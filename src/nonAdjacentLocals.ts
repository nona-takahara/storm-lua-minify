import Parser from "luaparse";
import { AstWalkVisitor, walkStatement } from "./astWalk";
import { ResolveResult, Symbol } from "./resolver";
import { copyNodeOrigin, identifierWithOrigin } from "./generatedNode";
import { SourceMetadata } from "./sourceMetadata";
import { TransformResult } from "./optimizerPass";

export interface NonAdjacentLocalGroup {
  readonly body: Parser.Statement[];
  readonly statements: readonly Parser.LocalStatement[];
  readonly indexes: readonly number[];
  readonly symbols: readonly Symbol[];
  readonly estimatedByteSavings: number;
}

export interface NonAdjacentLocalPlan {
  readonly groups: readonly NonAdjacentLocalGroup[];
}

export interface NonAdjacentLocalPlannerOptions {
  // Rename後の印字名長。未確定のsymbolをundefinedにすると、その候補は拒否する。
  readonly outputNameLengthOf: (symbol: Symbol) => number | undefined;
  readonly preserveRequireSplice: boolean;
}

interface Candidate {
  readonly statement: Parser.LocalStatement;
  readonly index: number;
  readonly symbol: Symbol;
}

/**
 * 非連続localの宣言hoist候補を選ぶ。ASTは変更しない。
 *
 * 初期段階では単純な1変数/1初期化だけを扱い、制御文や複数戻り値を境界にする。
 * これにより評価式は元位置へ代入として残せ、後続transformの安全性判断を小さく保つ。
 */
export function planNonAdjacentLocals(
  chunk: Parser.Chunk,
  resolved: ResolveResult,
  options: NonAdjacentLocalPlannerOptions,
): NonAdjacentLocalPlan {
  const groups: NonAdjacentLocalGroup[] = [];

  function processBlock(body: Parser.Statement[]): void {
    childBlocksOf(body).forEach(processBlock);

    let run: Candidate[] = [];
    const flush = () => {
      if (run.length >= 2) {
        const lengths = run.map((candidate) =>
          options.outputNameLengthOf(candidate.symbol),
        );
        if (lengths.every((length): length is number => length !== undefined)) {
          // N個の`local v=e`を`local v,...` + N個の`v=e`へ変える。
          // token差に加え、新しい宣言と最初の代入間に必要な1 byte separatorも引く。
          const savings =
            4 * run.length -
            6 -
            lengths.reduce((sum, length) => sum + length, 0);
          if (savings > 0) {
            groups.push({
              body,
              statements: run.map((candidate) => candidate.statement),
              indexes: run.map((candidate) => candidate.index),
              symbols: run.map((candidate) => candidate.symbol),
              estimatedByteSavings: savings,
            });
          }
        }
      }
      run = [];
    };

    body.forEach((statement, index) => {
      if (isLinearInterveningStatement(statement)) return;

      // 後続の既存local merge (#9) と候補選択を競合させない。隣接localを
      // hoistすると、#47単体では短くても#9適用後を基準に出力が長くなり得る。
      // #42で両案を同じplannerへ統合するまでは、孤立したlocalだけを扱う。
      if (
        statement.type === "LocalStatement" &&
        (body[index - 1]?.type === "LocalStatement" ||
          body[index + 1]?.type === "LocalStatement")
      ) {
        flush();
        return;
      }

      const candidate = candidateOf(statement, index, resolved, options);
      if (!candidate) {
        flush();
        return;
      }

      if (wouldChangeBinding(body, index, candidate)) {
        flush();
        return;
      }

      if (
        run.some((prior) => prior.symbol.name === candidate.symbol.name) ||
        wouldChangeBinding(body, run[0]?.index ?? candidate.index, candidate)
      ) {
        flush();
      }
      run.push(candidate);
    });
    flush();
  }

  processBlock(chunk.body);
  return { groups };
}

/** plannerが安全性と費用を確認したgroupだけをASTへ適用する。 */
export function applyNonAdjacentLocalPlan(
  plan: NonAdjacentLocalPlan,
  metadata?: SourceMetadata,
): TransformResult {
  // nested blockを含む各bodyは別配列である。同じbody内では後ろから置換し、
  // plannerが記録したindexを先行groupの挿入でずらさない。
  [...plan.groups].reverse().forEach((group) => {
    const declaration: Parser.LocalStatement = {
      type: "LocalStatement",
      variables: group.statements.map((statement) => statement.variables[0]),
      init: [],
    };
    copyNodeOrigin(declaration, group.statements[0]);

    const assignments = group.statements.map((statement) => {
      const assignment: Parser.AssignmentStatement = {
        type: "AssignmentStatement",
        variables: [identifierWithOrigin(statement.variables[0])],
        init: [statement.init[0]],
      };
      copyNodeOrigin(assignment, statement);
      return assignment;
    });

    for (let offset = group.indexes.length - 1; offset >= 0; offset--) {
      const index = group.indexes[offset];
      const source = group.statements[offset];
      const replacements =
        offset === 0
          ? [declaration, assignments[offset]]
          : [assignments[offset]];
      metadata?.replaceStatement(source, replacements);
      group.body.splice(index, 1, ...replacements);
    }
  });
  return {
    changed: plan.groups.length > 0,
    invalidatesResolve: plan.groups.length > 0,
  };
}

function candidateOf(
  statement: Parser.Statement,
  index: number,
  resolved: ResolveResult,
  options: NonAdjacentLocalPlannerOptions,
): Candidate | undefined {
  if (
    statement.type !== "LocalStatement" ||
    statement.variables.length !== 1 ||
    statement.init.length !== 1 ||
    (options.preserveRequireSplice && isRequireCall(statement.init[0]))
  ) {
    return undefined;
  }
  const symbol = resolved.symbolOf(statement.variables[0]);
  if (!symbol || symbol.kind !== "local") return undefined;
  return { statement, index, symbol };
}

function isLinearInterveningStatement(statement: Parser.Statement): boolean {
  return (
    statement.type === "AssignmentStatement" ||
    statement.type === "CallStatement"
  );
}

function wouldChangeBinding(
  body: Parser.Statement[],
  groupStart: number,
  candidate: Candidate,
): boolean {
  for (let index = groupStart; index <= candidate.index; index++) {
    const referencedNames: string[] = [];
    const visitor: AstWalkVisitor = {
      onIdentifierReference: (identifier) => {
        referencedNames.push(identifier.name);
      },
      onBlock: (nested) => {
        nested.forEach((statement) => {
          walkStatement(statement, visitor);
        });
      },
    };
    walkStatement(body[index], visitor);
    if (referencedNames.includes(candidate.symbol.name)) return true;
  }
  return false;
}

function childBlocksOf(body: Parser.Statement[]): Parser.Statement[][] {
  const children: Parser.Statement[][] = [];
  body.forEach((statement) => {
    walkStatement(statement, {
      onBlock: (nested) => children.push(nested),
    });
  });
  return children;
}

function isRequireCall(expression: Parser.Expression): boolean {
  return (
    (expression.type === "CallExpression" ||
      expression.type === "StringCallExpression") &&
    expression.base.type === "Identifier" &&
    expression.base.name === "require"
  );
}
