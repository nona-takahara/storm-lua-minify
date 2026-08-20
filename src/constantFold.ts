// 定数畳み込みパス（#44）: 定数式の事前計算（例: `1+2` -> `3`）と、
// 再代入されない定数ローカルの伝搬（例: `local x=1 print(x)` -> `print(1)`）を
// opt-inで行う。既定では無効（minifier.tsのfoldConstants=trueのときのみ呼ばれる）。
//
// このパスにとって最悪の失敗は「出力が静かに壊れること」である。畳み込める範囲を
// 広げるより、安全でないケースを確実に見送ることを優先する。判断に迷ったら畳み込まない。
import Parser from "luaparse";
import { ResolveResult, Symbol } from "./resolver";
import { SourceMetadata } from "./sourceMetadata";

// ============================================================
// 定数値の内部表現
// ============================================================

// Lua 5.3は整数と浮動小数点数を別の型として区別する（3と3.0はmath.typeで区別でき、
// printの出力も異なる）。この区別を壊さないことが、この実装で最も落としやすい点である。
// 整数はint64のBigIntで持つ（luaparseのNumericLiteral.valueはJavaScriptのdouble
// なので、0x7fffffffffffffffのような値は既に丸められている。計算にはvalueを使わず、
// rawから起こし直す）。
type ConstantValue =
  | { kind: "nil" }
  | { kind: "boolean"; value: boolean }
  | { kind: "int"; value: bigint }
  | { kind: "float"; value: number }
  | { kind: "string"; value: string; raw: string };

const INT64_MIN = -(2n ** 63n);

function rangeOf(node: object): [number, number] | undefined {
  return (node as { range?: [number, number] }).range;
}

// 生成・複製したノードに、元ノードの位置情報(loc/range)をコピーする（Source Mapのため）。
function withOriginPosition(node: Parser.Node, origin: Parser.Node): void {
  node.loc = origin.loc;
  const range = rangeOf(origin);
  if (range) {
    (node as { range?: [number, number] }).range = range;
  }
}

const DEC_INT_RAW = /^[0-9]+$/;
const HEX_INT_RAW = /^0[xX][0-9a-fA-F]+$/;

function numericConstantOf(
  node: Parser.NumericLiteral,
): ConstantValue | undefined {
  const raw = node.raw;
  if (DEC_INT_RAW.test(raw)) {
    const parsed = BigInt(raw);
    const wrapped = BigInt.asIntN(64, parsed);
    // 10進の整数リテラルがint64に収まらない場合、Luaはfloatとして扱う。
    // 扱いを分けず、単に見送る。
    if (wrapped !== parsed) return undefined;
    return { kind: "int", value: wrapped };
  }
  if (HEX_INT_RAW.test(raw)) {
    // 16進整数リテラルは大きさに関わらず常にint64として2の補数でラップされる
    // （Luaの規定）。
    return { kind: "int", value: BigInt.asIntN(64, BigInt(raw)) };
  }
  // それ以外（`.`やe/Eを含む10進float、16進float）。16進floatのp指数はNumber()
  // では解釈できないため、luaparseが既に解いた.valueを使う。整数の桁と違い、
  // floatはどちらの経路でもJavaScriptのdoubleと同じ精度なので、ここでvalueを
  // 使っても精度は失われない。
  const value = node.value;
  if (!Number.isFinite(value)) return undefined;
  return { kind: "float", value };
}

function stringConstantOf(
  node: Parser.StringLiteral,
): ConstantValue | undefined {
  const raw = node.raw;
  if (raw.length < 2) return undefined;
  const quote = raw.charAt(0);
  if (
    (quote !== '"' && quote !== "'") ||
    raw.charAt(raw.length - 1) !== quote
  ) {
    // 長括弧([[...]])形式などは対象外
    return undefined;
  }
  if (raw.includes("\\")) return undefined;
  const inner = raw.slice(1, -1);
  for (let i = 0; i < inner.length; i++) {
    const code = inner.charCodeAt(i);
    if (code < 0x20 || code > 0x7e) return undefined;
  }
  // node.valueは使わない: このプロジェクトのluaparse設定はencodingModeを指定して
  // おらず、既定値"none"はdiscardStrings:trueのためStringLiteral.valueは常にnull
  // になる（他のファイルが文字列の判定・比較に一貫してrawしか使わないのはこのため）。
  // エスケープの無い印字可能ASCIIだけを
  // 対象にしているので、raw内側の文字列(inner)がそのままLua側の値と一致する。
  return { kind: "string", value: inner, raw };
}

// 式が「今すぐ書き出せる定数」かどうかを判定する。畳み込み・伝搬どちらの判断でも
// 使う共通の読み取り関数で、ASTを変更しない。
function constantValueOf(expr: Parser.Expression): ConstantValue | undefined {
  switch (expr.type) {
    case "NilLiteral":
      return { kind: "nil" };
    case "BooleanLiteral":
      return { kind: "boolean", value: expr.value };
    case "NumericLiteral":
      return numericConstantOf(expr);
    case "StringLiteral":
      return stringConstantOf(expr);
    case "UnaryExpression":
      if (expr.operator === "-" && expr.argument.type === "NumericLiteral") {
        const inner = numericConstantOf(expr.argument);
        if (!inner) return undefined;
        if (inner.kind === "int") {
          return { kind: "int", value: BigInt.asIntN(64, -inner.value) };
        }
        if (inner.kind === "float") {
          const negated = -inner.value;
          if (Object.is(negated, -0)) return undefined; // -0は生成しない/認めない
          return { kind: "float", value: negated };
        }
        return undefined;
      }
      return undefined;
    default:
      return undefined;
  }
}

// ============================================================
// literalNodeFor: 定数値からASTノードを作る
// ============================================================

function intLiteralNode(
  v: bigint,
  origin: Parser.Node,
): Parser.Expression | undefined {
  if (v === INT64_MIN) {
    // math.mininteger（-9223372036854775808）は、絶対値(2^63)が10進の整数
    // リテラルとしてint64の範囲外になり、Luaの数値リテラル規則上floatとして
    // 読み直されてしまう（constantValueOfのnumericConstantOfが自分自身の
    // asIntN判定で弾く値と同じ）。この値を正しく再現する10進表記が無いため、
    // 畳み込みを見送る。
    return undefined;
  }
  if (v >= 0n) {
    const raw = v.toString(10);
    const node: Parser.NumericLiteral = {
      type: "NumericLiteral",
      value: Number(v),
      raw,
    };
    withOriginPosition(node, origin);
    return node;
  }
  // 負のintは単項式として持つ。印字はrawをそのまま出すため、raw="-2"のような
  // 数値リテラルが`a - -2`の右辺に来ると`a--2`と出力され、以降が行コメントに
  // なってしまう。`-`を単項式にすれば、既存の印字経路(insertSeparator)が
  // 区切りを入れてくれる。
  const abs = -v;
  const raw = abs.toString(10);
  const inner: Parser.NumericLiteral = {
    type: "NumericLiteral",
    value: Number(abs),
    raw,
  };
  withOriginPosition(inner, origin);
  const node: Parser.UnaryExpression = {
    type: "UnaryExpression",
    operator: "-",
    argument: inner,
  };
  withOriginPosition(node, origin);
  return node;
}

function floatLiteralNode(
  v: number,
  origin: Parser.Node,
): Parser.Expression | undefined {
  if (!Number.isFinite(v)) return undefined;
  if (Object.is(v, -0)) return undefined; // String(-0)は"0"になり-0.0と食い違う
  if (v < 0) {
    const positive = floatLiteralNode(-v, origin);
    if (!positive) return undefined;
    const node: Parser.UnaryExpression = {
      type: "UnaryExpression",
      operator: "-",
      argument: positive,
    };
    withOriginPosition(node, origin);
    return node;
  }
  let raw = String(v);
  if (!/[.eE]/.test(raw)) {
    // 3を3.0にする。付けないとfloatが整数に化ける。
    raw += ".0";
  }
  const node: Parser.NumericLiteral = { type: "NumericLiteral", value: v, raw };
  withOriginPosition(node, origin);
  return node;
}

function literalNodeFor(
  value: ConstantValue,
  origin: Parser.Node,
): Parser.Expression | undefined {
  switch (value.kind) {
    case "nil": {
      const node: Parser.NilLiteral = {
        type: "NilLiteral",
        value: null,
        raw: "nil",
      };
      withOriginPosition(node, origin);
      return node;
    }
    case "boolean": {
      const node: Parser.BooleanLiteral = {
        type: "BooleanLiteral",
        value: value.value,
        raw: value.value ? "true" : "false",
      };
      withOriginPosition(node, origin);
      return node;
    }
    case "string": {
      const node: Parser.StringLiteral = {
        type: "StringLiteral",
        value: value.value,
        raw: value.raw,
      };
      withOriginPosition(node, origin);
      return node;
    }
    case "int":
      return intLiteralNode(value.value, origin);
    case "float":
      return floatLiteralNode(value.value, origin);
  }
}

// ============================================================
// 畳み込む規則
// ============================================================

function isNumeric(
  v: ConstantValue,
): v is { kind: "int"; value: bigint } | { kind: "float"; value: number } {
  return v.kind === "int" || v.kind === "float";
}

function numAsFloat(
  v: { kind: "int"; value: bigint } | { kind: "float"; value: number },
): number {
  return v.kind === "int" ? Number(v.value) : v.value;
}

// Luaの `//` は床除算。BigIntの`/`は0方向への切り捨てなので、符号が異なり
// 余りがあるときに1引いて床に合わせる。
function bigIntFloorDiv(l: bigint, r: bigint): bigint {
  const q = l / r;
  const rem = l % r;
  if (rem !== 0n && rem < 0n !== r < 0n) {
    return q - 1n;
  }
  return q;
}

function evalArithmetic(
  op: "+" | "-" | "*" | "/" | "//" | "%" | "^",
  l: ConstantValue,
  r: ConstantValue,
): ConstantValue | undefined {
  if (!isNumeric(l) || !isNumeric(r)) return undefined;

  if (op === "/") {
    // `/`は常にfloat
    return { kind: "float", value: numAsFloat(l) / numAsFloat(r) };
  }
  if (op === "^") {
    // `^`は常にfloat
    return { kind: "float", value: Math.pow(numAsFloat(l), numAsFloat(r)) };
  }

  const bothInt = l.kind === "int" && r.kind === "int";

  if (op === "//") {
    if (bothInt) {
      if (r.value === 0n) return undefined; // Luaは実行時エラー。エラーを消してはならない
      return {
        kind: "int",
        value: BigInt.asIntN(64, bigIntFloorDiv(l.value, r.value)),
      };
    }
    const lf = numAsFloat(l);
    const rf = numAsFloat(r);
    return { kind: "float", value: Math.floor(lf / rf) };
  }

  if (op === "%") {
    // Luaの剰余は床剰余（a - floor(a/b)*b）。JavaScriptの%とは負数で結果が異なる。
    if (bothInt) {
      if (r.value === 0n) return undefined;
      return {
        kind: "int",
        value: BigInt.asIntN(
          64,
          l.value - bigIntFloorDiv(l.value, r.value) * r.value,
        ),
      };
    }
    const lf = numAsFloat(l);
    const rf = numAsFloat(r);
    return { kind: "float", value: lf - Math.floor(lf / rf) * rf };
  }

  // + - *
  if (bothInt) {
    const raw =
      op === "+"
        ? l.value + r.value
        : op === "-"
          ? l.value - r.value
          : l.value * r.value;
    return { kind: "int", value: BigInt.asIntN(64, raw) };
  }
  const lf = numAsFloat(l);
  const rf = numAsFloat(r);
  const raw = op === "+" ? lf + rf : op === "-" ? lf - rf : lf * rf;
  return { kind: "float", value: raw };
}

// Luaのシフトは論理シフト（符号なし）。符号無し64bitに直してシフトし、int64に戻す。
// シフト量が負なら逆方向のシフトとして扱い、絶対値が64以上なら結果は0。
function shiftLogical(valueUnsigned: bigint, amount: bigint): bigint {
  if (amount >= 0n) {
    if (amount >= 64n) return 0n;
    return BigInt.asUintN(64, valueUnsigned << amount);
  }
  const shiftRightBy = -amount;
  if (shiftRightBy >= 64n) return 0n;
  return valueUnsigned >> shiftRightBy;
}

function evalBitwise(
  op: "&" | "|" | "~" | "<<" | ">>",
  l: ConstantValue,
  r: ConstantValue,
): ConstantValue | undefined {
  // 両辺がintのときだけ扱う（floatは整数値でも対象外）
  if (l.kind !== "int" || r.kind !== "int") return undefined;
  const lu = BigInt.asUintN(64, l.value);
  const ru = BigInt.asUintN(64, r.value);
  switch (op) {
    case "&":
      return { kind: "int", value: BigInt.asIntN(64, lu & ru) };
    case "|":
      return { kind: "int", value: BigInt.asIntN(64, lu | ru) };
    case "~":
      return { kind: "int", value: BigInt.asIntN(64, lu ^ ru) };
    case "<<":
      return {
        kind: "int",
        value: BigInt.asIntN(64, shiftLogical(lu, r.value)),
      };
    case ">>":
      return {
        kind: "int",
        value: BigInt.asIntN(64, shiftLogical(lu, -r.value)),
      };
  }
}

function isSafeBigInt(v: bigint): boolean {
  return (
    v >= BigInt(Number.MIN_SAFE_INTEGER) && v <= BigInt(Number.MAX_SAFE_INTEGER)
  );
}

function evalOrderComparison(
  op: "<" | "<=" | ">" | ">=",
  l: ConstantValue,
  r: ConstantValue,
): ConstantValue | undefined {
  // 文字列同士の大小比較は照合順の前提を持ち込まないため畳み込まない。
  // 数値と文字列の比較はLuaでは実行時エラーなので、当然畳み込まない。
  if (!isNumeric(l) || !isNumeric(r)) return undefined;

  let result: boolean;
  if (l.kind === "int" && r.kind === "int") {
    result = compareValues(op, l.value, r.value);
  } else {
    // 型混在（int/float）でintが安全整数の範囲外なら、Number化で誤差が出るため畳み込まない。
    if (l.kind === "int" && !isSafeBigInt(l.value)) return undefined;
    if (r.kind === "int" && !isSafeBigInt(r.value)) return undefined;
    result = compareValues(op, numAsFloat(l), numAsFloat(r));
  }
  return { kind: "boolean", value: result };
}

function compareValues<T extends bigint | number>(
  op: "<" | "<=" | ">" | ">=",
  l: T,
  r: T,
): boolean {
  switch (op) {
    case "<":
      return l < r;
    case "<=":
      return l <= r;
    case ">":
      return l > r;
    case ">=":
      return l >= r;
  }
}

// 両辺が定数のときに== ~=を判定する。型が違えばfalse（強制変換しない）。
// intとfloatは同じ数値型として値で比較する（1 == 1.0はtrue）。
// intとfloatが混在する比較では、大小比較と同様に安全整数の範囲外のintを避ける
// （精度を落として誤った真偽値を畳み込まないための防御）。
function valuesEqual(l: ConstantValue, r: ConstantValue): boolean | undefined {
  if (l.kind === "nil" || r.kind === "nil") {
    return l.kind === "nil" && r.kind === "nil";
  }
  if (l.kind === "boolean" || r.kind === "boolean") {
    return l.kind === "boolean" && r.kind === "boolean" && l.value === r.value;
  }
  if (l.kind === "string" || r.kind === "string") {
    return l.kind === "string" && r.kind === "string" && l.value === r.value;
  }
  if (l.kind === "int" && r.kind === "int") return l.value === r.value;
  if (l.kind === "float" && r.kind === "float") return l.value === r.value;
  const intSide = l.kind === "int" ? l : (r as { kind: "int"; value: bigint });
  if (!isSafeBigInt(intSide.value)) return undefined;
  return numAsFloat(l) === numAsFloat(r);
}

function evalConcat(
  l: ConstantValue,
  r: ConstantValue,
): ConstantValue | undefined {
  // 両辺が文字列定数のときだけ。数値との連結は対象外（1と1.0で表記が変わるため）。
  if (l.kind !== "string" || r.kind !== "string") return undefined;
  const combined = l.value + r.value;
  const useDouble = !combined.includes('"');
  const useSingle = !combined.includes("'");
  if (!useDouble && !useSingle) return undefined; // どちらの引用符も含むなら畳み込まない
  const quote = useDouble ? '"' : "'";
  return { kind: "string", value: combined, raw: quote + combined + quote };
}

function isTruthy(v: ConstantValue): boolean {
  return !(v.kind === "nil" || (v.kind === "boolean" && !v.value));
}

function tryFoldBinary(
  expr: Parser.BinaryExpression,
): Parser.Expression | undefined {
  const l = constantValueOf(expr.left);
  const r = constantValueOf(expr.right);
  if (!l || !r) return undefined;

  const op = expr.operator;
  let result: ConstantValue | undefined;
  switch (op) {
    case "+":
    case "-":
    case "*":
    case "/":
    case "//":
    case "%":
    case "^":
      result = evalArithmetic(op, l, r);
      break;
    case "&":
    case "|":
    case "~":
    case "<<":
    case ">>":
      result = evalBitwise(op, l, r);
      break;
    case "<":
    case "<=":
    case ">":
    case ">=":
      result = evalOrderComparison(op, l, r);
      break;
    case "==":
    case "~=": {
      const eq = valuesEqual(l, r);
      result =
        eq === undefined
          ? undefined
          : { kind: "boolean", value: op === "==" ? eq : !eq };
      break;
    }
    case "..":
      result = evalConcat(l, r);
      break;
    default: {
      const exhaustive: never = op;
      throw new TypeError(
        "Unknown binary operator: `" + JSON.stringify(exhaustive) + "`",
      );
    }
  }
  if (!result) return undefined;
  return literalNodeFor(result, expr);
}

function tryFoldLogical(
  expr: Parser.LogicalExpression,
): Parser.Expression | undefined {
  const l = constantValueOf(expr.left);
  if (!l) return undefined;
  const leftTruthy = isTruthy(l);

  if (expr.operator === "and") {
    if (!leftTruthy) {
      // 左が偽なら右は評価されない。左を残す（右が定数でなくてよい）。
      return literalNodeFor(l, expr);
    }
    const r = constantValueOf(expr.right);
    if (!r) return undefined; // 右も定数のときだけ置き換える（関数呼び出し等の多値展開を守る）
    return literalNodeFor(r, expr);
  }

  // or
  if (leftTruthy) {
    return literalNodeFor(l, expr);
  }
  const r = constantValueOf(expr.right);
  if (!r) return undefined;
  return literalNodeFor(r, expr);
}

function tryFoldUnary(
  expr: Parser.UnaryExpression,
): Parser.Expression | undefined {
  if (expr.operator === "-" && expr.argument.type === "NumericLiteral") {
    // constantValueOfはUnaryExpression("-", NumericLiteral)をそのまま定数として
    // 認める（終端の形）。ここで同じ形へ畳み込み直すと、`changed`が真になり続け
    // 前進しないまま無限ループになる。この形は既に確定した終端として扱い、
    // 何もしない。
    return undefined;
  }
  const v = constantValueOf(expr.argument);
  if (!v) return undefined;

  if (expr.operator === "not") {
    return literalNodeFor({ kind: "boolean", value: !isTruthy(v) }, expr);
  }
  if (expr.operator === "-") {
    if (v.kind === "int") {
      return literalNodeFor(
        { kind: "int", value: BigInt.asIntN(64, -v.value) },
        expr,
      );
    }
    if (v.kind === "float") {
      const negated = -v.value;
      if (Object.is(negated, -0)) return undefined;
      return literalNodeFor({ kind: "float", value: negated }, expr);
    }
    return undefined;
  }
  if (expr.operator === "~") {
    if (v.kind !== "int") return undefined;
    return literalNodeFor(
      { kind: "int", value: BigInt.asIntN(64, ~v.value) },
      expr,
    );
  }
  // "#"（長さ演算子）は畳み込まない。文字列のバイト長はエスケープ表現に依存する。
  return undefined;
}

// ============================================================
// baseスロット（置換禁止位置）の判定
// ============================================================
//
// MemberExpression/IndexExpression/CallExpression/TableCallExpression/
// StringCallExpressionの`.base`（`a:b()`のようなメソッド呼び出しの基底も含む）は、
// 印字側（ast2lua.tsのformatBase）がCallExpression/BinaryExpression/
// FunctionDeclaration/TableConstructorExpression/LogicalExpression/StringLiteralの
// 6種類にしか丸括弧を付けない。NumericLiteral/BooleanLiteral/NilLiteral/
// UnaryExpressionはこのリストに無いため、`(1+2).x`を`3.x`のように畳み込むと、
// 丸括弧の無い出力になり字句解析が壊れる（`5.`が数値リテラルの先頭として
// 食われてしまう等）。ast2lua.tsは変更禁止ファイルなので、こちら側でbaseスロット
// そのものの置換を避ける。
//
// - 畳み込み: baseスロットに直接乗っている式（BinaryExpression/LogicalExpression/
//   UnaryExpression）自体は畳み込まない。その子（baseではないスロット）へは
//   通常どおり再帰する。
// - 伝搬: 対象シンボルの参照のうち1つでもbaseスロットに直接現れるものがあれば、
//   そのシンボルは（他の参照も含めて）一切伝搬しない。一部の参照だけ消えて
//   宣言が残る中途半端な状態を避けるため。
// `a.b.c`のようにbaseが連鎖する場合も、連鎖の先頭までこの扱いを引き継ぐ。

function collectBaseSlotIdentifiers(
  body: Parser.Statement[],
): Set<Parser.Identifier> {
  const out = new Set<Parser.Identifier>();

  function visitBaseChain(expr: Parser.Expression): void {
    switch (expr.type) {
      case "Identifier":
        out.add(expr);
        return;
      case "MemberExpression":
        visitBaseChain(expr.base);
        return;
      case "IndexExpression":
        visitBaseChain(expr.base);
        visitExpr(expr.index);
        return;
      case "CallExpression":
        visitBaseChain(expr.base);
        expr.arguments.forEach(visitExpr);
        return;
      case "TableCallExpression":
        visitBaseChain(expr.base);
        visitExpr(expr.arguments);
        return;
      case "StringCallExpression":
        visitBaseChain(expr.base);
        visitExpr(expr.argument);
        return;
      default:
        // BinaryExpression/LogicalExpression/UnaryExpression/リテラル/
        // FunctionDeclaration/TableConstructorExpressionなど。baseチェーンの
        // 先頭（これ以上baseを辿らない式）なので、内側は通常の走査に戻る。
        visitExpr(expr);
        return;
    }
  }

  function visitExpr(expr: Parser.Expression): void {
    switch (expr.type) {
      case "Identifier":
      case "StringLiteral":
      case "NumericLiteral":
      case "BooleanLiteral":
      case "NilLiteral":
      case "VarargLiteral":
        return;
      case "BinaryExpression":
      case "LogicalExpression":
        visitExpr(expr.left);
        visitExpr(expr.right);
        return;
      case "UnaryExpression":
        visitExpr(expr.argument);
        return;
      case "CallExpression":
        visitBaseChain(expr.base);
        expr.arguments.forEach(visitExpr);
        return;
      case "TableCallExpression":
        visitBaseChain(expr.base);
        visitExpr(expr.arguments);
        return;
      case "StringCallExpression":
        visitBaseChain(expr.base);
        visitExpr(expr.argument);
        return;
      case "IndexExpression":
        visitBaseChain(expr.base);
        visitExpr(expr.index);
        return;
      case "MemberExpression":
        visitBaseChain(expr.base);
        return;
      case "FunctionDeclaration":
        visitBlock(expr.body);
        return;
      case "TableConstructorExpression":
        expr.fields.forEach((field) => {
          if (field.type === "TableKey") {
            visitExpr(field.key);
            visitExpr(field.value);
          } else {
            // TableValueとTableKeyString（キー名は変数参照ではない）
            visitExpr(field.value);
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

  function visitStatement(statement: Parser.Statement): void {
    switch (statement.type) {
      case "LocalStatement":
        statement.init.forEach(visitExpr);
        return;
      case "AssignmentStatement":
        statement.variables.forEach((v) => {
          if (v.type === "Identifier") return; // 代入の左辺はbaseスロットではない
          visitBaseChain(v.base);
          if (v.type === "IndexExpression") visitExpr(v.index);
        });
        statement.init.forEach(visitExpr);
        return;
      case "CallStatement":
        visitBaseChain(statement.expression.base);
        if (statement.expression.type === "CallExpression") {
          statement.expression.arguments.forEach(visitExpr);
        } else if (statement.expression.type === "TableCallExpression") {
          visitExpr(statement.expression.arguments);
        } else {
          visitExpr(statement.expression.argument);
        }
        return;
      case "DoStatement":
        visitBlock(statement.body);
        return;
      case "WhileStatement":
        visitExpr(statement.condition);
        visitBlock(statement.body);
        return;
      case "RepeatStatement":
        visitBlock(statement.body);
        visitExpr(statement.condition);
        return;
      case "IfStatement":
        statement.clauses.forEach((clause) => {
          if (clause.type !== "ElseClause") visitExpr(clause.condition);
          visitBlock(clause.body);
        });
        return;
      case "ForNumericStatement":
        visitExpr(statement.start);
        visitExpr(statement.end);
        if (statement.step) visitExpr(statement.step);
        visitBlock(statement.body);
        return;
      case "ForGenericStatement":
        statement.iterators.forEach(visitExpr);
        visitBlock(statement.body);
        return;
      case "FunctionDeclaration":
        visitBlock(statement.body);
        return;
      case "ReturnStatement":
        statement.arguments.forEach(visitExpr);
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

  function visitBlock(block: Parser.Statement[]): void {
    block.forEach(visitStatement);
  }

  visitBlock(body);
  return out;
}

// ============================================================
// 定数伝搬 — 対象の収集
// ============================================================

function childBlocksOf(statement: Parser.Statement): Parser.Statement[][] {
  switch (statement.type) {
    case "DoStatement":
    case "WhileStatement":
    case "RepeatStatement":
    case "FunctionDeclaration":
    case "ForNumericStatement":
    case "ForGenericStatement":
      return [statement.body];
    case "IfStatement":
      return statement.clauses.map((clause) => clause.body);
    default:
      return [];
  }
}

// シンボルが（AssignmentStatementの左辺、または非local形の`function name() end`
// による代入で）どこかで再代入されているかを走査する。
//
// resolver.SymbolのreferencesはAssignmentStatementの左辺に現れた識別子も同じ配列
// に積む（読みと書きを区別しない）ため、参照数だけでは再代入を検出できない。
// AssignmentStatement.variablesを自分で走査して判定する。
// これを落とすと`local x=5 x=7`が`5=7`という壊れた出力になる。
function collectReassignedSymbols(
  body: Parser.Statement[],
  resolved: ResolveResult,
): Set<Symbol> {
  const out = new Set<Symbol>();

  function note(id: Parser.Identifier): void {
    const symbol = resolved.symbolOf(id);
    if (symbol) out.add(symbol);
  }

  function visit(block: Parser.Statement[]): void {
    block.forEach((statement) => {
      childBlocksOf(statement).forEach(visit);
      if (statement.type === "AssignmentStatement") {
        statement.variables.forEach((v) => {
          if (v.type === "Identifier") note(v);
        });
      } else if (
        statement.type === "FunctionDeclaration" &&
        !statement.isLocal &&
        statement.identifier?.type === "Identifier"
      ) {
        // 非local形の`function f() end`は、既存のローカル/グローバルfへの代入
        // として働く（resolver.tsのresolveFunctionDeclaration参照）。
        // AssignmentStatementの左辺だけを見ているとこの形式を見逃し、
        // 「再代入されているのに定数として配ってしまう」危険があるため含める。
        note(statement.identifier);
      }
    });
  }

  visit(body);
  return out;
}

function isShortLiteral(expr: Parser.Expression): boolean {
  // "0" "1" のような1文字の数値リテラルだけが対象。文字列は引用符を含むため
  // 1文字にはならず、真偽値/nilのrawも1文字にはならない。
  return expr.type === "NumericLiteral" && expr.raw.length === 1;
}

// 伝搬したあと、参照が消えた宣言が実際に取り除かれるかどうかを判定する。
// 未使用ローカル削除が初期値ごと捨てられるのはリテラルそのものだけで、
// `-5`のような単項式は対象外である（removeUnused.tsのisDiscardableInitializer）。
// 宣言が残るなら、参照をリテラルに置き換えても出力は縮まず、むしろ伸びる。
function leavesNoDeclaration(expr: Parser.Expression): boolean {
  switch (expr.type) {
    case "NilLiteral":
    case "BooleanLiteral":
    case "NumericLiteral":
    case "StringLiteral":
      return true;
    default:
      return false;
  }
}

function collectPropagationCandidates(
  body: Parser.Statement[],
  resolved: ResolveResult,
  metadata: SourceMetadata,
  reassigned: ReadonlySet<Symbol>,
  baseSlotIdentifiers: ReadonlySet<Parser.Identifier>,
): Map<Symbol, ConstantValue> {
  const out = new Map<Symbol, ConstantValue>();

  function visit(block: Parser.Statement[]): void {
    block.forEach((statement) => {
      childBlocksOf(statement).forEach(visit);
      if (statement.type !== "LocalStatement") return;
      if (statement.variables.length !== 1 || statement.init.length !== 1)
        return;

      const annotations = metadata.annotationsOf(statement);
      if (annotations.keep || annotations.keepName || annotations.exported)
        return;

      const value = constantValueOf(statement.init[0]);
      if (!value) return;

      const symbol = resolved.symbolOf(statement.variables[0]);
      if (!symbol) return;
      if (reassigned.has(symbol)) return;

      // baseスロットに直接現れる参照が1つでもあれば、このシンボルは一切伝搬しない
      // （一部の参照だけ置き換えて宣言が残る中途半端な状態を作らないため）。
      if (symbol.references.some((ref) => baseSlotIdentifiers.has(ref))) return;

      if (!leavesNoDeclaration(statement.init[0])) return;

      const refCount = symbol.references.length;
      if (refCount === 1 || isShortLiteral(statement.init[0])) {
        out.set(symbol, value);
      }
    });
  }

  visit(body);
  return out;
}

// ============================================================
// 書き換え本体（畳み込みと伝搬を同じ式スロット走査の上に載せる）
// ============================================================

interface RewriteContext {
  readonly resolved: ResolveResult;
  readonly propagate: ReadonlyMap<Symbol, ConstantValue>;
  changed: boolean;
}

// MemberExpression/IndexExpression/CallExpression/TableCallExpression/
// StringCallExpressionの`.base`専用の書き換え。baseスロットに直接乗っている式
// （Identifier/BinaryExpression/LogicalExpression/UnaryExpression）自体の置換
// （定数への伝搬・畳み込み）は行わない。子（baseではないスロット）へは通常の
// rewriteExpressionで再帰する。詳細はcollectBaseSlotIdentifiers直前のコメント参照。
function rewriteBase(
  expr: Parser.Expression,
  ctx: RewriteContext,
): Parser.Expression {
  switch (expr.type) {
    case "Identifier":
      return expr;
    case "BinaryExpression":
      expr.left = rewriteExpression(expr.left, ctx);
      expr.right = rewriteExpression(expr.right, ctx);
      return expr;
    case "LogicalExpression":
      expr.left = rewriteExpression(expr.left, ctx);
      expr.right = rewriteExpression(expr.right, ctx);
      return expr;
    case "UnaryExpression":
      expr.argument = rewriteExpression(expr.argument, ctx);
      return expr;
    default:
      // これ以外の式（MemberExpression/IndexExpression/Call系/リテラル/
      // FunctionDeclaration/TableConstructorExpression）は通常のrewriteExpression
      // でも「置換されず、子だけが書き換わる」ため安全にそのまま委譲できる。
      // MemberExpression等のさらに内側の.baseは、rewriteExpression側が
      // 再びrewriteBaseを呼ぶことでbase制限が連鎖の先頭まで引き継がれる。
      return rewriteExpression(expr, ctx);
  }
}

function rewriteCallLike(
  expr:
    | Parser.CallExpression
    | Parser.TableCallExpression
    | Parser.StringCallExpression,
  ctx: RewriteContext,
): void {
  expr.base = rewriteBase(expr.base, ctx);
  if (expr.type === "CallExpression") {
    expr.arguments = expr.arguments.map((a) => rewriteExpression(a, ctx));
  } else if (expr.type === "TableCallExpression") {
    expr.arguments = rewriteExpression(expr.arguments, ctx);
  } else {
    expr.argument = rewriteExpression(expr.argument, ctx);
  }
}

function rewriteExpression(
  expr: Parser.Expression,
  ctx: RewriteContext,
): Parser.Expression {
  switch (expr.type) {
    case "Identifier": {
      const symbol = ctx.resolved.symbolOf(expr);
      const value = symbol ? ctx.propagate.get(symbol) : undefined;
      if (value) {
        // 伝搬の結果は、置き換えられた参照側のIdentifierの位置を使う（宣言側ではない）。
        const literal = literalNodeFor(value, expr);
        if (literal) {
          ctx.changed = true;
          return literal;
        }
      }
      return expr;
    }
    case "StringLiteral":
    case "NumericLiteral":
    case "BooleanLiteral":
    case "NilLiteral":
    case "VarargLiteral":
      return expr;
    case "BinaryExpression": {
      expr.left = rewriteExpression(expr.left, ctx);
      expr.right = rewriteExpression(expr.right, ctx);
      const folded = tryFoldBinary(expr);
      if (folded) {
        ctx.changed = true;
        return folded;
      }
      return expr;
    }
    case "LogicalExpression": {
      expr.left = rewriteExpression(expr.left, ctx);
      expr.right = rewriteExpression(expr.right, ctx);
      const folded = tryFoldLogical(expr);
      if (folded) {
        ctx.changed = true;
        return folded;
      }
      return expr;
    }
    case "UnaryExpression": {
      expr.argument = rewriteExpression(expr.argument, ctx);
      const folded = tryFoldUnary(expr);
      if (folded) {
        ctx.changed = true;
        return folded;
      }
      return expr;
    }
    case "CallExpression":
    case "TableCallExpression":
    case "StringCallExpression":
      rewriteCallLike(expr, ctx);
      return expr;
    case "IndexExpression":
      expr.base = rewriteBase(expr.base, ctx);
      expr.index = rewriteExpression(expr.index, ctx);
      return expr;
    case "MemberExpression":
      expr.base = rewriteBase(expr.base, ctx);
      return expr;
    case "FunctionDeclaration":
      rewriteBlock(expr.body, ctx);
      return expr;
    case "TableConstructorExpression":
      expr.fields = expr.fields.map((field) => {
        if (field.type === "TableKey") {
          field.key = rewriteExpression(field.key, ctx);
          field.value = rewriteExpression(field.value, ctx);
          return field;
        }
        // TableValueとTableKeyString（キー名は書き換えない）
        field.value = rewriteExpression(field.value, ctx);
        return field;
      });
      return expr;
    default: {
      const exhaustive: never = expr;
      throw new TypeError(
        "Unknown expression type: `" + JSON.stringify(exhaustive) + "`",
      );
    }
  }
}

function rewriteAssignmentTarget(
  v: Parser.Identifier | Parser.IndexExpression | Parser.MemberExpression,
  ctx: RewriteContext,
): Parser.Identifier | Parser.IndexExpression | Parser.MemberExpression {
  if (v.type === "Identifier") return v; // 代入の左辺は決して書き換えない
  if (v.type === "IndexExpression") {
    v.base = rewriteBase(v.base, ctx);
    v.index = rewriteExpression(v.index, ctx);
    return v;
  }
  v.base = rewriteBase(v.base, ctx);
  return v;
}

function rewriteStatement(
  statement: Parser.Statement,
  ctx: RewriteContext,
): void {
  switch (statement.type) {
    case "LocalStatement":
      statement.init = statement.init.map((e) => rewriteExpression(e, ctx));
      return;
    case "AssignmentStatement":
      statement.variables = statement.variables.map((v) =>
        rewriteAssignmentTarget(v, ctx),
      );
      statement.init = statement.init.map((e) => rewriteExpression(e, ctx));
      return;
    case "CallStatement":
      rewriteCallLike(statement.expression, ctx);
      return;
    case "DoStatement":
      rewriteBlock(statement.body, ctx);
      return;
    case "WhileStatement":
      statement.condition = rewriteExpression(statement.condition, ctx);
      rewriteBlock(statement.body, ctx);
      return;
    case "RepeatStatement":
      rewriteBlock(statement.body, ctx);
      statement.condition = rewriteExpression(statement.condition, ctx);
      return;
    case "IfStatement":
      statement.clauses.forEach((clause) => {
        if (clause.type !== "ElseClause") {
          clause.condition = rewriteExpression(clause.condition, ctx);
        }
        rewriteBlock(clause.body, ctx);
      });
      return;
    case "ForNumericStatement":
      statement.start = rewriteExpression(statement.start, ctx);
      statement.end = rewriteExpression(statement.end, ctx);
      if (statement.step) {
        statement.step = rewriteExpression(statement.step, ctx);
      }
      rewriteBlock(statement.body, ctx);
      return;
    case "ForGenericStatement":
      statement.iterators = statement.iterators.map((it) =>
        rewriteExpression(it, ctx),
      );
      rewriteBlock(statement.body, ctx);
      return;
    case "FunctionDeclaration":
      // identifier（宣言名）とparametersは決して書き換えない
      rewriteBlock(statement.body, ctx);
      return;
    case "ReturnStatement":
      statement.arguments = statement.arguments.map((a) =>
        rewriteExpression(a, ctx),
      );
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

function rewriteBlock(body: Parser.Statement[], ctx: RewriteContext): void {
  body.forEach((statement) => {
    rewriteStatement(statement, ctx);
  });
}

// ============================================================
// 入口
// ============================================================

/**
 * 定数式の事前計算（畳み込み）と、定数ローカル変数の伝搬を1回分行う。
 * removeUnusedLocalsと同じ形で、変更があればtrueを返す。呼び出し側は変化が
 * 無くなるまで繰り返す。各回の変換は必ずノード数か参照数を減らす
 * （減らない変換を入れると無限ループになる。tryFoldUnaryの終端形保護や
 * intLiteralNodeのINT64_MIN見送りはこの不変条件を守るためのもの）。
 */
export function foldConstants(
  chunk: Parser.Chunk,
  resolved: ResolveResult,
  metadata: SourceMetadata,
): boolean {
  const reassigned = collectReassignedSymbols(chunk.body, resolved);
  const baseSlotIdentifiers = collectBaseSlotIdentifiers(chunk.body);
  const propagate = collectPropagationCandidates(
    chunk.body,
    resolved,
    metadata,
    reassigned,
    baseSlotIdentifiers,
  );
  const ctx: RewriteContext = { resolved, propagate, changed: false };
  rewriteBlock(chunk.body, ctx);
  return ctx.changed;
}

// テストの再パース検査用に、定数値の分類器と内部表現を公開する。
export type { ConstantValue };
export { constantValueOf };
