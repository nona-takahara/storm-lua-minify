import Parser from "luaparse";
import { ResolveResult, Symbol } from "./resolver";
import { copyNodeOrigin, identifierWithOrigin } from "./generatedNode";
import { SourceMetadata } from "./sourceMetadata";
import { TransformResult } from "./optimizerPass";
import { childStatementBodies } from "./controlFlow";
import {
  OptimizationDiagnosticReason,
  OptimizationDiagnosticSink,
} from "./optimizerDiagnostics";
import { RuntimeProfile } from "./runtimeEnvironment";
import { OptimizerFacts, OptimizerOperation } from "./optimizerFacts";

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
  readonly facts: OptimizerFacts;
  // Rename後の印字名長。未確定のsymbolをundefinedにすると、その候補は拒否する。
  readonly outputNameLengthOf: (symbol: Symbol) => number | undefined;
  readonly preserveRequireSplice: boolean;
  readonly diagnostics?: OptimizationDiagnosticSink;
  readonly moduleName?: string;
  readonly runtimeProfile?: RuntimeProfile;
}

interface Candidate {
  readonly statement: Parser.LocalStatement;
  readonly index: number;
  readonly symbol: Symbol;
}

type CandidateDecision =
  | { readonly candidate: Candidate }
  | { readonly reason: OptimizationDiagnosticReason };

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
    const record = (
      decision: "accepted" | "rejected",
      reason: OptimizationDiagnosticReason,
      candidateSize: number,
      estimatedByteSavings?: number,
      estimatedOpportunityBytes?: number,
      sourceRange?: readonly [number, number],
    ) =>
      options.diagnostics?.record({
        pass: "effect-aware-local-hoist",
        moduleName: options.moduleName,
        runtimeProfile: options.runtimeProfile,
        decision,
        reason,
        candidateSize,
        estimatedByteSavings,
        estimatedOpportunityBytes,
        sourceRange,
      });
    const flush = (
      rejectionReason: OptimizationDiagnosticReason = "insufficient-group",
    ) => {
      if (run.length >= 2) {
        const hasSeparatedStatements = run.some(
          (candidate, index) =>
            index > 0 && candidate.index > run[index - 1].index + 1,
        );
        const priorSymbols = new Set<Symbol>();
        const hasInitializerDependency = run.some((candidate) => {
          const depends = options.facts
            .operationsWithin(candidate.statement)
            .some((operation) => {
              if (operation.kind !== "read") return false;
              const symbol = symbolOfOperation(operation);
              return symbol !== undefined && priorSymbols.has(symbol);
            });
          priorSymbols.add(candidate.symbol);
          return depends;
        });
        if (!hasSeparatedStatements && !hasInitializerDependency) {
          record(
            "rejected",
            "adjacent-local-owned-by-merge",
            run.length,
            undefined,
            0,
            rangeOf(run[0].statement),
          );
          run = [];
          return;
        }
        const lengths = run.map((candidate) =>
          options.outputNameLengthOf(candidate.symbol),
        );
        if (lengths.every((length): length is number => length !== undefined)) {
          // 先頭initializerは結合後のlocal文に残し、2個目以降だけを元位置の
          // assignmentへ分離する。これにより依存付きの隣接runも短くできる。
          const savings =
            4 * run.length -
            6 -
            lengths.reduce((sum, length) => sum + length, 0) +
            lengths[0] +
            2;
          if (savings > 0) {
            groups.push({
              body,
              statements: run.map((candidate) => candidate.statement),
              indexes: run.map((candidate) => candidate.index),
              symbols: run.map((candidate) => candidate.symbol),
              estimatedByteSavings: savings,
            });
            record(
              "accepted",
              "profitable-group",
              run.length,
              savings,
              undefined,
              rangeOf(run[0].statement),
            );
            run = [];
            return;
          }
          record(
            "rejected",
            "nonpositive-cost",
            run.length,
            undefined,
            Math.max(0, 4 * run.length - 6),
            rangeOf(run[0].statement),
          );
        } else {
          record(
            "rejected",
            "output-name-unknown",
            run.length,
            undefined,
            Math.max(0, 4 * run.length - 6),
            rangeOf(run[0].statement),
          );
        }
      } else if (run.length > 0) {
        record(
          "rejected",
          rejectionReason,
          run.length,
          undefined,
          0,
          rangeOf(run[0].statement),
        );
      }
      run = [];
    };

    body.forEach((statement, index) => {
      if (isLinearInterveningStatement(statement)) return;

      if (statement.type !== "LocalStatement") {
        flush("control-flow-barrier");
        return;
      }
      const decision = candidateOf(statement, index, resolved, options);
      if ("reason" in decision) {
        flush("control-flow-barrier");
        record(
          "rejected",
          decision.reason,
          1,
          undefined,
          0,
          rangeOf(statement),
        );
        return;
      }
      const candidate = decision.candidate;

      if (wouldChangeBinding(body, index, candidate, options.facts)) {
        flush("binding-shadow-hazard");
        record(
          "rejected",
          "binding-shadow-hazard",
          1,
          undefined,
          0,
          rangeOf(statement),
        );
        return;
      }

      if (
        run.some((prior) => prior.symbol.name === candidate.symbol.name) ||
        wouldChangeBinding(
          body,
          run[0]?.index ?? candidate.index,
          candidate,
          options.facts,
        )
      ) {
        flush("binding-shadow-hazard");
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
      init: [group.statements[0].init[0]],
    };
    copyNodeOrigin(declaration, group.statements[0]);

    const assignments = group.statements.slice(1).map((statement) => {
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
        offset === 0 ? [declaration] : [assignments[offset - 1]];
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
  statement: Parser.LocalStatement,
  index: number,
  resolved: ResolveResult,
  options: NonAdjacentLocalPlannerOptions,
): CandidateDecision {
  if (statement.variables.length !== 1 || statement.init.length !== 1) {
    return { reason: "unsupported-shape" };
  }
  if (options.preserveRequireSplice && isRequireCall(statement.init[0])) {
    return { reason: "require-splice" };
  }
  const symbol = resolved.symbolOf(statement.variables[0]);
  if (!symbol || symbol.kind !== "local") {
    return { reason: "unsupported-shape" };
  }
  return { candidate: { statement, index, symbol } };
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
  facts: OptimizerFacts,
): boolean {
  for (let index = groupStart; index <= candidate.index; index++) {
    const referencedNames = facts
      .operationsWithin(body[index])
      .filter(
        (operation) => operation.kind === "read" || operation.kind === "write",
      )
      .map(bindingNameOfOperation)
      .filter((name): name is string => name !== undefined);
    if (referencedNames.includes(candidate.symbol.name)) return true;
  }
  return false;
}

function symbolOfOperation(operation: OptimizerOperation): Symbol | undefined {
  if (!("location" in operation)) return undefined;
  return operation.location.kind === "local" ||
    operation.location.kind === "parameter" ||
    operation.location.kind === "upvalue"
    ? operation.location.symbol
    : undefined;
}

function bindingNameOfOperation(
  operation: OptimizerOperation,
): string | undefined {
  if (!("location" in operation)) return undefined;
  if (operation.location.kind === "global")
    return operation.location.binding.name;
  return symbolOfOperation(operation)?.name;
}

function childBlocksOf(body: Parser.Statement[]): Parser.Statement[][] {
  return childStatementBodies(body);
}

function isRequireCall(expression: Parser.Expression): boolean {
  return (
    (expression.type === "CallExpression" ||
      expression.type === "StringCallExpression") &&
    expression.base.type === "Identifier" &&
    expression.base.name === "require"
  );
}

function rangeOf(
  statement: Parser.Statement,
): readonly [number, number] | undefined {
  return (statement as { range?: [number, number] }).range;
}
