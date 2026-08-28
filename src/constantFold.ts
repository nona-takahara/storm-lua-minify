// 定数畳み込みパス（#44）: 定数式の事前計算（例: `1+2` -> `3`）と、
// 再代入されない定数ローカルの伝搬（例: `local x=1 print(x)` -> `print(1)`）を
// opt-inで行う。既定では無効（minifier.tsのfoldConstants=trueのときのみ呼ばれる）。
//
// 畳み込みの判断は2つの条件で決まる。値がその場で確定すること、そして畳み込んでも
// プログラムの意味が変わらないこと。後者には、実行時エラーを消さないことも含む
// （`1//0`はエラーを起こす式であって、値を持つ式ではない）。
//
// 定数として認める文字列を、エスケープを含まない印字可能ASCIIに限っているのは、
// この条件を演算ごとに考え直さずに済ませるためである。この形の文字列は1文字が
// 1バイトに対応し、連結・比較・長さのいずれもJavaScript上の操作がそのまま
// Luaの結果と一致する。
import Parser from "luaparse";
import { ResolveResult, Symbol } from "./resolver";
import { OptimizerFacts } from "./optimizerFacts";
import { SourceMetadata } from "./sourceMetadata";
import {
  compareLuaByteStrings,
  concatLuaByteStrings,
  decodeLuaStringLiteral,
  encodeLuaByteString,
  LuaByteString,
  luaByteStringKey,
} from "./luaString";

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
  | { kind: "string"; value: LuaByteString; raw: string };

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
  const decoded = decodeLuaStringLiteral(node);
  return decoded.ok
    ? { kind: "string", value: decoded.value, raw: node.raw }
    : undefined;
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
        // Printerと再解析はrawを使う。luaparse型ではstring必須だが、既定の
        // discardStrings環境では意味値を保持しないため空文字を入れる。
        value: "",
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
    // Luaの剰余は床方向で、JavaScriptの`%`とは負数で結果が異なる。
    //
    // 浮動小数点では、Luaのマニュアルにある `a - floor(a/b)*b` という等式を
    // そのまま計算してはいけない。両辺の大きさが極端に違うとき、掛け戻しの桁で
    // 情報が落ちる（`10 % 1e-300`が0になる）。Lua自身はC言語のfmodを使って
    // 余りを直接求め、符号が除数と食い違うときだけ除数を足している。
    // JavaScriptの`%`はfmodと同じ切り捨て方向の余りなので、同じ手順を踏む。
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
    let remainder = lf % rf;
    if (remainder !== 0 && remainder < 0 !== rf < 0) {
      remainder += rf;
    }
    return { kind: "float", value: remainder };
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
  if (l.kind === "string" && r.kind === "string") {
    const comparison = compareLuaByteStrings(l.value, r.value);
    return { kind: "boolean", value: compareValues(op, comparison, 0) };
  }
  // 数値と文字列の比較はLuaでは実行時エラーなので、畳み込んでエラーを消さない。
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

function compareValues<T extends bigint | number | string>(
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
    return (
      l.kind === "string" &&
      r.kind === "string" &&
      luaByteStringKey(l.value) === luaByteStringKey(r.value)
    );
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
  const combined = concatLuaByteStrings(l.value, r.value);
  return {
    kind: "string",
    value: combined,
    raw: encodeLuaByteString(combined),
  };
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
  // 残るのは`#`。Lua stringは共有decoderが返すbyte列なので、JavaScriptの
  // code unit数ではなくbyte数を使う。tableへの`#`は実行時に決まるため対象外。
  if (v.kind !== "string") return undefined;
  return literalNodeFor(
    { kind: "int", value: BigInt(v.value.bytes.length) },
    expr,
  );
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

// 共通operationのwriteから再代入を求める。Symbol.referencesはread/writeを区別しない
// ため参照数では代用できない。これを落とすと`local x=5 x=7`が`5=7`になる。
function collectReassignedSymbols(facts: OptimizerFacts): Set<Symbol> {
  const out = new Set<Symbol>();
  facts.operations.forEach((operation) => {
    if (
      operation.kind === "write" &&
      (operation.location.kind === "local" ||
        operation.location.kind === "parameter" ||
        operation.location.kind === "upvalue")
    ) {
      out.add(operation.location.symbol);
    }
  });
  return out;
}

// 伝搬した値が印字時に何バイトになるかを見積もる。畳み込みの出力経路
// （intLiteralNode/floatLiteralNode/literalNodeFor）と同じ表記規則で数える。
function printedLengthOf(value: ConstantValue): number {
  switch (value.kind) {
    case "nil":
      return 3; // "nil"
    case "boolean":
      return value.value ? 4 : 5; // "true" / "false"
    case "int": {
      const abs = value.value < 0n ? -value.value : value.value;
      return (value.value < 0n ? 1 : 0) + abs.toString(10).length;
    }
    case "float": {
      const abs = Math.abs(value.value);
      let raw = String(abs);
      if (!/[.eE]/.test(raw)) raw += ".0";
      return (value.value < 0 ? 1 : 0) + raw.length;
    }
    case "string":
      return new TextEncoder().encode(value.raw).length;
  }
}

// 参照が複数ある定数ローカルを配ってよいか。
//
// 配ると「宣言（`local <名前>=<値>` のおよそ7+名前の長さ+値の長さバイト）」が
// 丸ごと消える代わりに、参照のたびに識別子(名前の長さ)ではなく値の長さが
// 出力される。名前の長さは、この畳み込みパスがrenameパスより前に走るため
// ここではまだ決まっていない（minifier.tsのfoldConstantsAllはrenameAllより前）。
// 決め方を誤って出力を伸ばすくらいなら伝搬しない方に倒したいので、renameが
// 名前をこれ以上削れない最短の1文字にできた場合（配らない側にとって最も有利な
// 場合）を仮定して、その上でなお配る方が短くなることだけを条件にする。
// 名前が実際には1文字より長くなった場合、配る側はこの見積りより得をする
// だけなので、この判定が縮まない伝搬を通すことはない。
//
// 1文字（`printedLength<=1`）は、名前が最短の1文字であっても宣言の分だけ
// 必ず得なので、参照回数に関わらず常に配ってよい（isShortLiteralが対象に
// していた「1文字の数値リテラル」を含む、より一般化した条件になっている）。
function worthPropagatingWhenShared(
  printedLength: number,
  refCount: number,
): boolean {
  if (printedLength <= 1) return true;
  // 名前1文字・宣言の定数オーバーヘッド(`local `+`=`)7バイトを仮定したときの
  // 収支: refCount*(printedLength-1) <= printedLength+8
  return refCount * (printedLength - 1) <= printedLength + 8;
}

function collectPropagationCandidates(
  body: Parser.Statement[],
  resolved: ResolveResult,
  metadata: SourceMetadata,
  reassigned: ReadonlySet<Symbol>,
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

      const refCount = symbol.references.length;
      if (
        refCount === 1 ||
        worthPropagatingWhenShared(printedLengthOf(value), refCount)
      ) {
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
  readonly evaluateExpressions: boolean;
  changed: boolean;
}

function rewriteCallLike(
  expr:
    | Parser.CallExpression
    | Parser.TableCallExpression
    | Parser.StringCallExpression,
  ctx: RewriteContext,
): void {
  expr.base = rewriteExpression(expr.base, ctx);
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
      const folded = ctx.evaluateExpressions ? tryFoldBinary(expr) : undefined;
      if (folded) {
        ctx.changed = true;
        return folded;
      }
      return expr;
    }
    case "LogicalExpression": {
      expr.left = rewriteExpression(expr.left, ctx);
      expr.right = rewriteExpression(expr.right, ctx);
      const folded = ctx.evaluateExpressions ? tryFoldLogical(expr) : undefined;
      if (folded) {
        ctx.changed = true;
        return folded;
      }
      return expr;
    }
    case "UnaryExpression": {
      expr.argument = rewriteExpression(expr.argument, ctx);
      const folded = ctx.evaluateExpressions ? tryFoldUnary(expr) : undefined;
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
      expr.base = rewriteExpression(expr.base, ctx);
      expr.index = rewriteExpression(expr.index, ctx);
      return expr;
    case "MemberExpression":
      expr.base = rewriteExpression(expr.base, ctx);
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
    v.base = rewriteExpression(v.base, ctx);
    v.index = rewriteExpression(v.index, ctx);
    return v;
  }
  v.base = rewriteExpression(v.base, ctx);
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
  facts: OptimizerFacts,
  options: {
    readonly evaluateExpressions?: boolean;
    readonly propagateLocals?: boolean;
  } = {},
): boolean {
  const reassigned = collectReassignedSymbols(facts);
  const propagate =
    options.propagateLocals === false
      ? new Map<Symbol, ConstantValue>()
      : collectPropagationCandidates(
          chunk.body,
          resolved,
          metadata,
          reassigned,
        );
  const ctx: RewriteContext = {
    resolved,
    propagate,
    evaluateExpressions: options.evaluateExpressions !== false,
    changed: false,
  };
  rewriteBlock(chunk.body, ctx);
  return ctx.changed;
}

// テストの再パース検査用に、定数値の分類器と内部表現を公開する。
export type { ConstantValue };
export { constantValueOf };
