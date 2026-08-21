// Issue #52: 印字処理(src/ast2lua.ts)の既存の丸括弧省略バグを、式の文字列では
// なくAST構造から機械的に判定するための分類器。
//
// Luaの演算子優先順位(低い方から): or / and / < <= > >= ~= == / | / ~(二項) /
// & / << >> / ..(連結、右結合) / + - / * / // % / 単項(not # - ~) / ^(右結合)。
// `..`式が、これより優先順位の高い演算子(+ - * / // %、単項演算子、^)の直接の
// オペランドとして現れるとき、印字処理が必要な丸括弧を落とし、Luaの構文解析上の
// グルーピングが変わってしまう(詳細: https://github.com/nona-takahara/storm-lua-minify/issues/52)。
// 比較・ビット演算・and/orは`..`より優先順位が低い(`..`のほうが強く束縛する)ので
// 丸括弧は元から不要であり、対象外。
//
// 式の文字列そのものではなくAST構造で判定するのは、差分テストのランダム式は
// シードを変えるたびに変わるため、個々の式を列挙する判定は壊れやすいから。
import Parser from "luaparse";

const HIGHER_THAN_CONCAT_BINARY: ReadonlySet<string> = new Set([
  "+",
  "-",
  "*",
  "/",
  "//",
  "%",
  "^",
]);
const UNARY_OPERATORS: ReadonlySet<string> = new Set(["not", "#", "-", "~"]);
const OPERATOR_NODE_TYPES: ReadonlySet<string> = new Set([
  "BinaryExpression",
  "UnaryExpression",
  "LogicalExpression",
]);

const LUAPARSE_SETTINGS = {
  luaVersion: "5.3" as const,
  ranges: true,
  locations: true,
  scope: true,
};

interface OperatorParent {
  type: string;
  operator: string;
}

function isOperatorParentRequiringParens(parent: OperatorParent): boolean {
  if (parent.type === "BinaryExpression") {
    return HIGHER_THAN_CONCAT_BINARY.has(parent.operator);
  }
  if (parent.type === "UnaryExpression") {
    return UNARY_OPERATORS.has(parent.operator);
  }
  return false;
}

// nodeの部分木に、「`..`式が優先順位の高い演算子の直接のオペランドである」箇所が
// あるかどうかを走査する。ASTを型を問わず再帰的に辿る点はsrc/linker.tsのwalkと
// 同じ考え方だが、直接の親の演算子種別を追跡する必要があるためこちらに個別実装する。
function containsIssue52Pattern(
  node: unknown,
  parent: OperatorParent | undefined,
): boolean {
  if (node === null || typeof node !== "object") return false;
  if (Array.isArray(node)) {
    return node.some((child) => containsIssue52Pattern(child, parent));
  }
  const n = node as Record<string, unknown>;
  const type = n.type as string | undefined;
  if (
    type === "BinaryExpression" &&
    n.operator === ".." &&
    parent &&
    isOperatorParentRequiringParens(parent)
  ) {
    return true;
  }
  const childParent: OperatorParent | undefined =
    type !== undefined && OPERATOR_NODE_TYPES.has(type)
      ? { type, operator: n.operator as string }
      : undefined;
  for (const key of Object.keys(n)) {
    if (key === "loc" || key === "range" || key === "type") continue;
    const child = n[key];
    if (
      child !== null &&
      typeof child === "object" &&
      containsIssue52Pattern(child, childParent)
    ) {
      return true;
    }
  }
  return false;
}

// exprSourceが、Issue #52の条件(`..`式が、より優先順位の高い演算子の直接の
// オペランドとして現れる)に当てはまるかどうかを判定する。構文解析に失敗した
// 場合はfalseを返す(そもそも比較の土俵に乗らないケースなので、呼び出し側の
// 他のロジックに判定を委ねる)。
export function matchesIssue52Pattern(exprSource: string): boolean {
  let chunk: Parser.Chunk;
  try {
    chunk = Parser.parse(`return (${exprSource})`, LUAPARSE_SETTINGS);
  } catch {
    return false;
  }
  return containsIssue52Pattern(chunk.body, undefined);
}
