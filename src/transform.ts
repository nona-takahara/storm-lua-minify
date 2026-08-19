// Transformパス（#9）: Resolveパスが構築したシンボルテーブルをもとに、
// 連続するlocal変数宣言文を安全な範囲でまとめ上げる。
//
//   local a = require("x")
//   local b = require("y")
//     ↓
//   local a,b = require("x"),require("y")
//
// このパスはASTを破壊的に変更する。ただし宣言・初期化式のノードは
// そのまま再利用し、新しい`LocalStatement`ラッパーに詰め替えるだけなので、
// Resolveパスが構築したノード同一性ベースの対応関係（symbolOf等）は
// このパスの前後を通じて有効なまま保たれる。
import Parser from "luaparse";
import { ResolveResult, Symbol } from "./resolver";
import { staticStringArgument, RESERVED_MODULE_FUNCTION_NAMES } from "./linker";
import { SourceMetadata } from "./sourceMetadata";

export interface MergeLocalsOptions {
  // SLモード（moduleLikeLua:false）では`local x = require("m")`形式の文を
  // ast2lua.tsのtrySpliceRequireStatementがfunctionで包まずその場展開する
  // 最適化（#29）の対象にしている。まとめ上げてしまうと変数が2個以上になり
  // その最適化が使えなくなる（IIFEラップへのフォールバックで逆にサイズが
  // 悪化しうる）ため、この形式の文は常にグループ境界として扱う。
  readonly preserveRequireSplice: boolean;
}

export function mergeLocalDeclarations(
  chunk: Parser.Chunk,
  resolveResult: ResolveResult,
  options: MergeLocalsOptions,
  metadata?: SourceMetadata,
): void {
  processBlock(chunk.body, resolveResult, options, metadata);
}

// #8b: リネームできない外部グローバル識別子（screen等）をチャンク先頭で
// ローカル変数に代入し、以降の参照をそのローカル経由に書き換える。
//
//   screen.setColor(1,2,3)          local a=screen
//   screen.drawText(0,0,"x")   ->   a.setColor(1,2,3)
//                                   a.drawText(0,0,"x")
//
// エイリアスの一時名(__globalAliasN)はこの時点では未確定の仮名でしかなく、
// このパスの後にresolveScopesを再実行して初めて通常のローカルシンボルとして
// 認識され、Renameパスが最終的な短縮名を割り当てる。
export interface InsertGlobalAliasesOptions {
  // #8aで直接リネームされることが決まっているグローバル名。
  // 二重にエイリアス化しないよう除外する。
  readonly excludeNames: ReadonlySet<string>;
}

// 十分に非現実的な接頭辞を使い、実在の識別子との衝突を避ける
// （このパスの直後にresolveScopesが再実行され、最終的な短縮名は
// Renameパスが決めるため、この仮名自体が出力に残ることはない）。
const ALIAS_TEMP_NAME_PREFIX = "__mergeAlias";

// エイリアス化で`.name`を書き換えた参照ノードについて、Source Mapに載せる
// べき「元の名前」を記録する。ast2lua.tsのgenerateIdentifierはこれを参照し、
// 位置情報(loc)はそのままなのにSource Mapのnamesフィールドだけ書き換え後の
// 仮名（あるいは最終的な短縮名）になってしまう不具合を避ける。
const aliasedOriginalNames = new WeakMap<Parser.Identifier, string>();

export function originalNameOf(
  identifier: Parser.Identifier,
): string | undefined {
  return aliasedOriginalNames.get(identifier);
}

// 代入コスト（`local X=`相当、8バイト）を、参照1回あたりの節約バイト数
// （元の名前の長さ-1文字、エイリアス名を1文字と仮定）で上回るかどうかで判定する。
function isWorthAliasing(name: string, referenceCount: number): boolean {
  const savingsPerReference = name.length - 1;
  const declarationCost = 8 + name.length;
  return referenceCount * savingsPerReference > declarationCost;
}

export function insertGlobalAliases(
  chunk: Parser.Chunk,
  resolveResult: ResolveResult,
  options: InsertGlobalAliasesOptions,
): void {
  const newLocals: Parser.LocalStatement[] = [];
  let aliasCounter = 0;

  resolveResult.globals.forEach((binding) => {
    // 一度でも代入されているグローバルは#8aが直接リネームする対象（か、そちらが
    // 保護対象として保持する）なので、ここでの対象は代入が一度もないものに限る。
    if (binding.writes.length > 0) {
      return;
    }
    if (options.excludeNames.has(binding.name)) {
      return;
    }
    // require/dofileはPrintパスが名前文字列で再検出するため、
    // エイリアス化して名前を変えると検出できなくなり壊れる。
    if (RESERVED_MODULE_FUNCTION_NAMES.has(binding.name)) {
      return;
    }
    if (!isWorthAliasing(binding.name, binding.references.length)) {
      return;
    }

    const tempName = ALIAS_TEMP_NAME_PREFIX + String(aliasCounter++);
    binding.references.forEach((ref) => {
      aliasedOriginalNames.set(ref, ref.name);
      ref.name = tempName;
    });
    newLocals.push({
      type: "LocalStatement",
      variables: [{ type: "Identifier", name: tempName }],
      init: [{ type: "Identifier", name: binding.name }],
    });
  });

  if (newLocals.length > 0) {
    chunk.body.unshift(...newLocals);
  }
}

// ============================================================
// ブロックの再帰走査
// ============================================================

interface WalkVisitor {
  onIdentifierReference?: (id: Parser.Identifier) => void;
  onBlock?: (body: Parser.Statement[]) => void;
}

// resolver.tsのresolveStatement/resolveExpressionの分岐を鏡写しにした
// 汎用ウォーカー。「参照として現れる識別子」と「ネストしたブロック本体」を
// どちらも一度の走査で収集できるようにし、resolver.tsの走査ロジックの
// 重複を避ける。
function walkStatement(
  statement: Parser.Statement,
  visitor: WalkVisitor,
): void {
  switch (statement.type) {
    case "LocalStatement":
      // 宣言される変数自体は参照ではないため辿らない
      statement.init.forEach((expr) => {
        walkExpression(expr, visitor);
      });
      return;
    case "AssignmentStatement":
      statement.variables.forEach((v) => {
        if (v.type === "Identifier") {
          visitor.onIdentifierReference?.(v);
        } else {
          walkExpression(v, visitor);
        }
      });
      statement.init.forEach((expr) => {
        walkExpression(expr, visitor);
      });
      return;
    case "CallStatement":
      walkExpression(statement.expression, visitor);
      return;
    case "DoStatement":
      visitor.onBlock?.(statement.body);
      return;
    case "WhileStatement":
      walkExpression(statement.condition, visitor);
      visitor.onBlock?.(statement.body);
      return;
    case "RepeatStatement":
      visitor.onBlock?.(statement.body);
      walkExpression(statement.condition, visitor);
      return;
    case "IfStatement":
      statement.clauses.forEach((clause) => {
        if (clause.type !== "ElseClause") {
          walkExpression(clause.condition, visitor);
        }
        visitor.onBlock?.(clause.body);
      });
      return;
    case "ForNumericStatement":
      walkExpression(statement.start, visitor);
      walkExpression(statement.end, visitor);
      if (statement.step) {
        walkExpression(statement.step, visitor);
      }
      visitor.onBlock?.(statement.body);
      return;
    case "ForGenericStatement":
      statement.iterators.forEach((iterator) => {
        walkExpression(iterator, visitor);
      });
      visitor.onBlock?.(statement.body);
      return;
    case "FunctionDeclaration":
      if (statement.identifier) {
        if (statement.identifier.type === "Identifier") {
          if (!statement.isLocal) {
            // 非local: 既存のローカル/グローバルへの代入（参照扱い）
            visitor.onIdentifierReference?.(statement.identifier);
          }
          // isLocalの場合は宣言自体であり参照ではないため辿らない
        } else {
          walkExpression(statement.identifier, visitor);
        }
      }
      visitor.onBlock?.(statement.body);
      return;
    case "ReturnStatement":
      statement.arguments.forEach((argument) => {
        walkExpression(argument, visitor);
      });
      return;
    case "BreakStatement":
    case "LabelStatement":
    case "GotoStatement":
      return;
    default: {
      const exhaustive: never = statement;
      throw new TypeError(
        "Unknown statement type: `" + JSON.stringify(exhaustive) + "`",
      );
    }
  }
}

function walkExpression(expr: Parser.Expression, visitor: WalkVisitor): void {
  switch (expr.type) {
    case "Identifier":
      visitor.onIdentifierReference?.(expr);
      return;
    case "StringLiteral":
    case "NumericLiteral":
    case "BooleanLiteral":
    case "NilLiteral":
    case "VarargLiteral":
      return;
    case "LogicalExpression":
    case "BinaryExpression":
      walkExpression(expr.left, visitor);
      walkExpression(expr.right, visitor);
      return;
    case "UnaryExpression":
      walkExpression(expr.argument, visitor);
      return;
    case "CallExpression":
      walkExpression(expr.base, visitor);
      expr.arguments.forEach((argument) => {
        walkExpression(argument, visitor);
      });
      return;
    case "TableCallExpression":
      walkExpression(expr.base, visitor);
      walkExpression(expr.arguments, visitor);
      return;
    case "StringCallExpression":
      walkExpression(expr.base, visitor);
      walkExpression(expr.argument, visitor);
      return;
    case "IndexExpression":
      walkExpression(expr.base, visitor);
      walkExpression(expr.index, visitor);
      return;
    case "MemberExpression":
      walkExpression(expr.base, visitor);
      // フィールド名（`.identifier`）は変数参照ではないため辿らない
      return;
    case "FunctionDeclaration":
      visitor.onBlock?.(expr.body);
      return;
    case "TableConstructorExpression":
      expr.fields.forEach((field) => {
        if (field.type === "TableKey") {
          walkExpression(field.key, visitor);
          walkExpression(field.value, visitor);
        } else {
          walkExpression(field.value, visitor);
        }
      });
      return;
    default: {
      const exhaustive: never = expr;
      throw new TypeError(
        "Unknown expression type: `" + JSON.stringify(exhaustive) + "`",
      );
    }
  }
}

function processBlock(
  body: Parser.Statement[],
  resolveResult: ResolveResult,
  options: MergeLocalsOptions,
  metadata?: SourceMetadata,
): void {
  // 先に子ブロック（ネストしたスコープ）を処理する。子ブロックは別配列なので
  // このレベルでのまとめ上げには影響しない。
  body.forEach((statement) => {
    walkStatement(statement, {
      onBlock: (nested) => {
        processBlock(nested, resolveResult, options, metadata);
      },
    });
  });
  mergeRunsInPlace(body, resolveResult, options, metadata);
}

// あるexpr（候補文のinit式）の中に現れる識別子参照をすべて収集する。
// ネストした関数リテラルの本体も再帰的に辿る（ハザード1: クロージャの
// 字句スコープは実行タイミングに関わらず即座に確定するため）。
function collectIdentifierReferences(
  expr: Parser.Expression,
): Parser.Identifier[] {
  const found: Parser.Identifier[] = [];
  const visitor: WalkVisitor = {
    onIdentifierReference: (id) => found.push(id),
    onBlock: (body) => {
      body.forEach((s) => {
        walkStatement(s, visitor);
      });
    },
  };
  walkExpression(expr, visitor);
  return found;
}

// ============================================================
// ハザード判定
// ============================================================

function isExpandable(expr: Parser.Expression): boolean {
  return (
    expr.type === "CallExpression" ||
    expr.type === "TableCallExpression" ||
    expr.type === "StringCallExpression" ||
    expr.type === "VarargLiteral"
  );
}

type NonTerminalSafety =
  | { readonly safe: true; readonly needsPadding: boolean }
  | { readonly safe: false };

// ハザード2（複数値展開）: statementをグループの非末尾要素として
// 後ろに文を連結してよいかどうかを判定する。
//   - 変数と初期化式の個数が一致: 常に安全（パディング不要）
//   - 変数が多い（不足）: 最後の初期化式が展開可能でなければnilパディングで安全。
//     展開可能な式に依存している場合は非末尾にできない。
//   - 初期化式が多い（過剰）: 常に非末尾として不安全
//     （余剰の値が後続文の変数へずれ込むため、パディングでは救えない）
function classifyNonTerminal(
  statement: Parser.LocalStatement,
): NonTerminalSafety {
  const varCount = statement.variables.length;
  const initCount = statement.init.length;
  if (varCount === initCount) {
    return { safe: true, needsPadding: false };
  }
  if (varCount > initCount) {
    const lastInit = initCount > 0 ? statement.init[initCount - 1] : undefined;
    if (!lastInit || !isExpandable(lastInit)) {
      return { safe: true, needsPadding: true };
    }
    return { safe: false };
  }
  return { safe: false };
}

// ハザード1（参照順序）: candidateのinit式が、groupSoFarで宣言済みの
// 変数を参照していないかを判定する。参照していれば統合するとLuaの
// スコープ規則上意味が変わってしまうため、そこでグループを閉じる必要がある。
function initReferencesDeclaredInGroup(
  candidate: Parser.LocalStatement,
  groupSoFar: readonly Parser.LocalStatement[],
  resolveResult: ResolveResult,
): boolean {
  const declaredInGroup = new Set<Symbol>();
  groupSoFar.forEach((statement) => {
    statement.variables.forEach((v) => {
      const symbol = resolveResult.symbolOf(v);
      if (symbol) {
        declaredInGroup.add(symbol);
      }
    });
  });

  return candidate.init.some((expr) =>
    collectIdentifierReferences(expr).some((id) => {
      const symbol = resolveResult.symbolOf(id);
      return symbol !== undefined && declaredInGroup.has(symbol);
    }),
  );
}

// ハザード4: SLモードでtrySpliceRequireStatement（#29）の対象になり得る
// `local x = require(<静的文字列>)`形式の文かどうかを判定する。
function isSpliceEligibleRequire(statement: Parser.LocalStatement): boolean {
  if (statement.variables.length !== 1 || statement.init.length !== 1) {
    return false;
  }
  return isStaticRequireCall(statement.init[0]);
}

function isStaticRequireCall(expr: Parser.Expression): boolean {
  if (expr.type === "CallExpression") {
    return (
      expr.base.type === "Identifier" &&
      expr.base.name === "require" &&
      expr.arguments.length > 0 &&
      staticStringArgument(expr.arguments[0]) !== undefined
    );
  }
  if (expr.type === "StringCallExpression") {
    return (
      expr.base.type === "Identifier" &&
      expr.base.name === "require" &&
      staticStringArgument(expr.argument) !== undefined
    );
  }
  return false;
}

// ============================================================
// グループ化とマージ
// ============================================================

function nilLiteral(): Parser.NilLiteral {
  return { type: "NilLiteral", value: null, raw: "nil" };
}

function combineGroup(
  group: readonly Parser.LocalStatement[],
): Parser.LocalStatement {
  const variables: Parser.Identifier[] = [];
  const init: Parser.Expression[] = [];

  group.forEach((statement, index) => {
    variables.push(...statement.variables);
    const isLast = index === group.length - 1;
    init.push(...statement.init);
    if (!isLast) {
      const safety = classifyNonTerminal(statement);
      if (safety.safe && safety.needsPadding) {
        const padCount = statement.variables.length - statement.init.length;
        for (let i = 0; i < padCount; i++) {
          init.push(nilLiteral());
        }
      }
    }
  });

  // 末尾の合成nilは、Luaが変数超過分を自動的にnilで埋めるため省略できる
  // （元から書かれていた明示的なnilを末尾で省略しても意味は変わらない）。
  while (init.length > 0 && init[init.length - 1].type === "NilLiteral") {
    init.pop();
  }

  return {
    type: "LocalStatement",
    variables,
    init,
  };
}

function mergeRun(
  run: readonly Parser.LocalStatement[],
  resolveResult: ResolveResult,
  options: MergeLocalsOptions,
  metadata?: SourceMetadata,
): Parser.LocalStatement[] {
  const output: Parser.LocalStatement[] = [];
  let groupStart = 0;

  const flushGroup = (endExclusive: number) => {
    if (endExclusive <= groupStart) {
      return;
    }
    const group = run.slice(groupStart, endExclusive);
    if (group.length >= 2) {
      const combined = combineGroup(group);
      metadata?.transferStatements(group, combined);
      output.push(combined);
    } else {
      output.push(group[0]);
    }
  };

  for (let k = 0; k < run.length; k++) {
    const statement = run[k];

    if (options.preserveRequireSplice && isSpliceEligibleRequire(statement)) {
      flushGroup(k);
      output.push(statement);
      groupStart = k + 1;
      continue;
    }

    if (k === groupStart) {
      continue;
    }

    const previous = run[k - 1];
    const previousSafety = classifyNonTerminal(previous);
    const referencesGroupLocal = initReferencesDeclaredInGroup(
      statement,
      run.slice(groupStart, k),
      resolveResult,
    );

    if (!previousSafety.safe || referencesGroupLocal) {
      flushGroup(k);
      groupStart = k;
    }
  }
  flushGroup(run.length);

  return output;
}

function mergeRunsInPlace(
  body: Parser.Statement[],
  resolveResult: ResolveResult,
  options: MergeLocalsOptions,
  metadata?: SourceMetadata,
): void {
  const result: Parser.Statement[] = [];
  let i = 0;
  while (i < body.length) {
    const statement = body[i];
    if (statement.type !== "LocalStatement") {
      result.push(statement);
      i++;
      continue;
    }
    let j = i;
    const run: Parser.LocalStatement[] = [];
    while (j < body.length && body[j].type === "LocalStatement") {
      run.push(body[j] as Parser.LocalStatement);
      j++;
    }
    result.push(...mergeRun(run, resolveResult, options, metadata));
    i = j;
  }
  body.splice(0, body.length, ...result);
}
