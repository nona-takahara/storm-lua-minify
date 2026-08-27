import { test } from "vitest";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import Parser from "luaparse";
import { SourceMapConsumer } from "source-map";
import { resolveScopes } from "../src/resolver";
import { fixtureEntryPath, runMinifier, WORKING_CASES } from "./lib/helpers";
import {
  foldConstants,
  constantValueOf,
  ConstantValue,
} from "../src/constantFold";
import { SourceMetadata } from "../src/sourceMetadata";
import { analyzeOptimizerFacts } from "../src/optimizerFacts";
import { Minifier } from "../src/minifier";
import {
  decodeLuaStringLiteral,
  luaByteStringKey,
  luaByteStringOfText,
} from "../src/luaString";
import { minifyTemporaryLuaSource } from "./lib/minifierHarness";

const PARSE_SETTINGS = {
  luaVersion: "5.3" as const,
  comments: true,
  locations: true,
  ranges: true,
};

function fold(code: string): Parser.Chunk {
  const chunk = Parser.parse(code, PARSE_SETTINGS);
  const metadata = new SourceMetadata(chunk, code);
  let resolved = resolveScopes(chunk);
  while (
    foldConstants(
      chunk,
      resolved,
      metadata,
      analyzeOptimizerFacts(chunk, resolved),
    )
  ) {
    resolved = resolveScopes(chunk);
  }
  return chunk;
}

// `return <expr>` の形で1式だけを畳み込み、結果の式を返す。
function foldExpr(exprSource: string): Parser.Expression {
  const chunk = fold("return " + exprSource);
  const ret = chunk.body[chunk.body.length - 1] as Parser.ReturnStatement;
  assert.equal(ret.type, "ReturnStatement");
  return ret.arguments[0];
}

// 実際にMinifierを通して、opt-in有効時の出力文字列を得る（一時ファイル経由）。
// 「出力を再パースして壊れていないことを確認する」系のテストに使う。
function minifyWith(code: string, constantOptimizations: boolean): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "storm-const-fold-test-"));
  const filePath = path.join(dir, "main.lua");
  fs.writeFileSync(filePath, code);
  try {
    const minifier = new Minifier(
      filePath,
      { locations: true, luaVersion: "5.3", ranges: true, scope: true },
      {
        requireWrapper: false,
        constantOptimizations,
        interproceduralConstantPropagation: constantOptimizations,
      },
    );
    const sourceNode = minifier.parse();
    return sourceNode.toStringWithSourceMap({ file: "main.min.lua" }).code;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("propagates a pure function summary into a direct scalar call", () => {
  const source = `
local function answer() return 42 end
local value=answer()
print(value)
`;
  const enabled = minifyWith(source, true);
  const disabled = minifyWith(source, false);

  assert.match(enabled, /42/);
  assert.doesNotMatch(enabled, /function/);
  assert.ok(Buffer.byteLength(enabled) < Buffer.byteLength(disabled));
});

test("does not erase an effectful or recursive call from a constant summary", () => {
  const effectful = `
local function answer() print('effect') return 1 end
local value=answer()
print(value)
`;
  const recursive = `
local function answer() return answer() end
local value=answer()
print(value)
`;
  const globalWrite = `
local function answer() output=1 return 1 end
local value=answer()
print(value,output)
`;
  assert.match(minifyWith(effectful, true), /effect/);
  assert.match(minifyWith(recursive, true), /function/);
  assert.match(minifyWith(globalWrite, true), /output=1/);
});

test("constant expression evaluation and local propagation are independent", () => {
  const expressionOnly = minifyTemporaryLuaSource(
    "local value=1+2 print(value)",
    {
      requireWrapper: false,
      identifierOptimizations: false,
      constantExpressionEvaluation: true,
      localConstantPropagation: false,
    },
  ).code;
  const propagationOnly = minifyTemporaryLuaSource(
    "local value=3 print(value)",
    {
      requireWrapper: false,
      identifierOptimizations: false,
      constantExpressionEvaluation: false,
      localConstantPropagation: true,
    },
  ).code;

  assert.match(expressionOnly, /value=3/);
  assert.match(expressionOnly, /print\(value\)/);
  assert.doesNotMatch(propagationOnly, /local\s+value/);
  assert.match(propagationOnly, /print\(3\)/);
});

function runFoldedMinifier(code: string): string {
  return minifyWith(code, true);
}

// 畳み込みを有効にしたときの出力が、無効なときより長くなっていないことを
// 確かめる比較対象として使う。
function runPlainMinifier(code: string): string {
  return minifyWith(code, false);
}

// リテラル/単項マイナスのリテラルのみを対象に、AST上のrawからLuaソース断片を
// 組み立てる（生成したリテラルの再パース検査用）。
function literalSourceText(expr: Parser.Expression): string {
  if (expr.type === "UnaryExpression" && expr.operator === "-") {
    return "-" + literalSourceText(expr.argument);
  }
  if (
    expr.type === "NumericLiteral" ||
    expr.type === "StringLiteral" ||
    expr.type === "BooleanLiteral" ||
    expr.type === "NilLiteral"
  ) {
    return expr.raw;
  }
  throw new Error("not a literal-shaped expression: " + expr.type);
}

// 生成されたexprのrawを`return <raw>`として読み直し、自分の分類器(constantValueOf)
// にかけて元の値と一致することを確認する。3と3.0の取り違えを機械的に捕まえる。
function assertRoundTrips(expr: Parser.Expression): ConstantValue {
  const original = constantValueOf(expr);
  assert.ok(original, "式が定数として分類できませんでした: " + expr.type);
  const source = literalSourceText(expr);
  const reparsed = Parser.parse("return " + source, { luaVersion: "5.3" });
  const reparsedExpr = (reparsed.body[0] as Parser.ReturnStatement)
    .arguments[0];
  const roundTripped = constantValueOf(reparsedExpr);
  assert.ok(
    roundTripped,
    "再パース後の式が定数として分類できませんでした: " + source,
  );
  assert.equal(
    roundTripped.kind,
    original.kind,
    "種別(int/float等)が一致しません",
  );
  if (original.kind === "int" && roundTripped.kind === "int") {
    assert.equal(roundTripped.value, original.value);
  } else if (original.kind === "float" && roundTripped.kind === "float") {
    assert.equal(roundTripped.value, original.value);
  } else if (original.kind === "string" && roundTripped.kind === "string") {
    assert.equal(
      luaByteStringKey(roundTripped.value),
      luaByteStringKey(original.value),
    );
  } else if (original.kind === "boolean" && roundTripped.kind === "boolean") {
    assert.equal(roundTripped.value, original.value);
  }
  return original;
}

function assertInt(expr: Parser.Expression, expected: bigint): void {
  const value = assertRoundTrips(expr);
  assert.equal(value.kind, "int");
  assert.equal(value.value, expected);
}

function assertFloat(expr: Parser.Expression, expected: number): void {
  const value = assertRoundTrips(expr);
  assert.equal(value.kind, "float");
  assert.equal(value.value, expected);
}

function assertBoolean(expr: Parser.Expression, expected: boolean): void {
  assert.equal(expr.type, "BooleanLiteral");
  assert.equal(expr.value, expected);
}

function assertStringValue(expr: Parser.Expression, expected: string): void {
  assert.equal(expr.type, "StringLiteral");
  const decoded = decodeLuaStringLiteral(expr);
  assert.ok(decoded.ok);
  assert.equal(
    luaByteStringKey(decoded.value),
    luaByteStringKey(luaByteStringOfText(expected)),
  );
}

// ============================================================
// 畳み込まれること
// ============================================================

test("1+2 folds to the int 3", () => {
  assertInt(foldExpr("1+2"), 3n);
});

test("7//2 floor-divides to the int 3", () => {
  assertInt(foldExpr("7//2"), 3n);
});

test("-7//2 floors toward negative infinity to -4", () => {
  assertInt(foldExpr("-7//2"), -4n);
});

test("7%3 folds to the int 1", () => {
  assertInt(foldExpr("7%3"), 1n);
});

test("-7%3 uses floored modulo and folds to the int 2", () => {
  assertInt(foldExpr("-7%3"), 2n);
});

test("10 % 1e-300 keeps the precision of the true remainder", () => {
  // Luaのマニュアルにある `a - floor(a/b)*b` をそのまま計算すると、両辺の
  // 大きさが極端に違うときに掛け戻しの桁で情報が落ち、0になってしまう。
  // 本物のLua 5.3は9.6318652803971148e-301を返す。
  assertFloat(foldExpr("10 % 1e-300"), 10 % 1e-300);
  assert.notEqual((foldExpr("10 % 1e-300") as Parser.NumericLiteral).value, 0);
});

test("5.5 % -2 keeps Lua's floored sign", () => {
  assertFloat(foldExpr("5.5 % -2"), -0.5);
});

test("-5.5 % 2 keeps Lua's floored sign", () => {
  assertFloat(foldExpr("-5.5 % 2"), 0.5);
});

test("1/2 folds to the float 0.5", () => {
  assertFloat(foldExpr("1/2"), 0.5);
});

test("3/1 folds to the float 3.0, not the int 3", () => {
  const expr = foldExpr("3/1");
  assertFloat(expr, 3);
  assert.equal(expr.type, "NumericLiteral");
  assert.ok(
    expr.raw.includes("."),
    "floatのrawは`.`を含む必要がある: " + expr.raw,
  );
});

test("2^2 folds to the float 4.0", () => {
  assertFloat(foldExpr("2^2"), 4);
});

test("-6/2 folds to the negative float -3.0 (unary-wrap + .0-suffix interaction)", () => {
  // floatLiteralNodeの負数分岐(単項式で包む)と、整数に見える値への".0"付与が
  // 両方絡む経路。ここでの取り違えはassertRoundTrips(再パース検査)で
  // 機械的に捕まる。
  const expr = foldExpr("-6/2");
  assertFloat(expr, -3);
  assert.equal(expr.type, "UnaryExpression");
});

test('"a".."b" folds to the string "ab"', () => {
  assertStringValue(foldExpr('"a".."b"'), "ab");
});

test("not nil folds to true", () => {
  assertBoolean(foldExpr("not nil"), true);
});

test("1<2 folds to true", () => {
  assertBoolean(foldExpr("1<2"), true);
});

test("1==1.0 folds to true (int/float compare by value)", () => {
  assertBoolean(foldExpr("1==1.0"), true);
});

test('"a"=="b" folds to false', () => {
  assertBoolean(foldExpr('"a"=="b"'), false);
});

test("1<<3 folds to 8", () => {
  assertInt(foldExpr("1<<3"), 8n);
});

test("1<<64 folds to 0 (shift amount >= 64)", () => {
  assertInt(foldExpr("1<<64"), 0n);
});

test("~0 folds to -1", () => {
  assertInt(foldExpr("~0"), -1n);
});

test("false and f() folds to false without requiring f() to be constant", () => {
  assertBoolean(foldExpr("false and f()"), false);
});

test("0x7fffffffffffffff+2 wraps to a representable negative int", () => {
  // int64の範囲でラップすることを、実際に再パースできる値で確認する
  // (+1はmath.mininteger自体になり、下のテストで別途扱う)。
  assertInt(foldExpr("0x7fffffffffffffff+2"), -9223372036854775807n);
});

test(
  "0x7fffffffffffffff+1 wraps to math.mininteger, but folding is declined " +
    "because no decimal literal round-trips as that int",
  () => {
    const chunk = fold("return 0x7fffffffffffffff+1");
    const ret = chunk.body[0] as Parser.ReturnStatement;
    // 畳み込まれず、元のBinaryExpressionのまま残ることを確認する。
    assert.equal(ret.arguments[0].type, "BinaryExpression");
    // ただし、内部の演算自体はint64として正しくラップしていることを、
    // 分類器の外側からも検算しておく。
    const wrapped = BigInt.asIntN(64, BigInt("0x7fffffffffffffff") + 1n);
    assert.equal(wrapped, -(2n ** 63n));
  },
);

// ============================================================
// 畳み込まれないこと
// ============================================================

test("1/0 is not folded (non-finite float)", () => {
  assert.equal(foldExpr("1/0").type, "BinaryExpression");
});

test("1//0 is not folded (integer division by zero is a runtime error)", () => {
  assert.equal(foldExpr("1//0").type, "BinaryExpression");
});

test("1%0 is not folded (integer modulo by zero is a runtime error)", () => {
  assert.equal(foldExpr("1%0").type, "BinaryExpression");
});

test('"10"+1 is not folded (strings are never coerced for arithmetic)', () => {
  assert.equal(foldExpr('"10"+1').type, "BinaryExpression");
});

test('1<"a" is not folded (mixed-type ordering)', () => {
  assert.equal(foldExpr('1<"a"').type, "BinaryExpression");
});

test('#"abc" folds to the byte length 3', () => {
  assertInt(foldExpr('#"abc"'), 3n);
});

test("long-bracket and Unicode string lengths use Lua bytes", () => {
  assertInt(foldExpr("#[[abc]]"), 3n);
  assertInt(foldExpr('#"あ"'), 3n);
});

test("the length of a table constructor is not folded", () => {
  assert.equal(foldExpr("#{1,2,3}").type, "UnaryExpression");
});

test("x+1 is not folded when x is not a constant", () => {
  assert.equal(foldExpr("x+1").type, "BinaryExpression");
});

test("true and f() is not folded (right side must be constant too)", () => {
  assert.equal(foldExpr("true and f()").type, "LogicalExpression");
});

test('"a"..1 is not folded (numeric operands are never concatenated)', () => {
  assert.equal(foldExpr('"a"..1').type, "BinaryExpression");
});

test('"a" < "b" folds to true (byte order)', () => {
  assertBoolean(foldExpr('"a" < "b"'), true);
});

test('"abc" >= "abd" folds to false', () => {
  assertBoolean(foldExpr('"abc" >= "abd"'), false);
});

test("long-bracket and escaped strings compare by Lua bytes", () => {
  assertBoolean(foldExpr("[[a]] < [[b]]"), true);
  assertBoolean(foldExpr('"\\x61" == "a"'), true);
});

test("long-bracket string concatenation is folded through shared bytes", () => {
  assertStringValue(foldExpr("[[abc]]..[[def]]"), "abcdef");
});

test("concatenation preserves escaped byte values", () => {
  assertStringValue(foldExpr('"a\\nb".."c"'), "a\nbc");
});

test("(1+2).x folds to a literal base, and the printer keeps the parentheses", () => {
  const chunk = fold("return (1 + 2).x");
  const ret = chunk.body[0] as Parser.ReturnStatement;
  const member = ret.arguments[0] as Parser.MemberExpression;
  assertInt(member.base, 3n);

  // Luaの文法では数値をそのまま基底に置けない。`3.x`と出力されると字句解析が
  // 壊れるので、出力側が丸括弧を補っていることまで確かめる。
  const code = runFoldedMinifier("return (1 + 2).x");
  assert.ok(code.includes("(3).x"), code);
  assert.doesNotThrow(() => Parser.parse(code, { luaVersion: "5.3" }));
});

// ============================================================
// 伝搬
// ============================================================

test("a local referenced exactly once is propagated and the reference is replaced", () => {
  const chunk = fold(`
    local x = 42
    return x
  `);
  const ret = chunk.body[chunk.body.length - 1] as Parser.ReturnStatement;
  assertInt(ret.arguments[0], 42n);
});

test("a negative literal is propagated like any other constant", () => {
  const chunk = fold(`
    local n = -5
    return n
  `);
  const ret = chunk.body[chunk.body.length - 1] as Parser.ReturnStatement;
  assertInt(ret.arguments[0], -5n);
});

test("a negative constant local does not grow the minified output", () => {
  // 配ったあとに宣言が残ると、出力は縮まずむしろ伸びる。負の定数は初期値が
  // 単項式になるので、未使用削除がこの形を捨てられることに依存している。
  const source = `
    local n = -5
    print(n)
  `;
  const folded = runFoldedMinifier(source);
  const plain = runPlainMinifier(source);
  assert.ok(
    folded.length <= plain.length,
    "畳み込み有効時の出力が伸びている: " +
      String(folded.length) +
      " > " +
      String(plain.length),
  );
});

test("a literal too long relative to its reference count is not propagated", () => {
  // "hello"は7バイト(引用符込み)。名前が伝搬しない側にとって最も有利な1文字に
  // なると仮定しても、3回参照では宣言を残す方が短い(worthPropagatingWhenShared
  // 参照)。2回までなら次のテストの通り配る。
  const chunk = fold(`
    local greeting = "hello"
    print(greeting)
    print(greeting)
    print(greeting)
  `);
  const calls = chunk.body.filter(
    (s): s is Parser.CallStatement => s.type === "CallStatement",
  );
  calls.forEach((call) => {
    const expr = call.expression as Parser.CallExpression;
    assert.equal(expr.arguments[0].type, "Identifier");
  });
});

test("a 1-character literal is propagated even with multiple references", () => {
  const chunk = fold(`
    local one = 1
    print(one)
    print(one)
  `);
  const calls = chunk.body.filter(
    (s): s is Parser.CallStatement => s.type === "CallStatement",
  );
  calls.forEach((call) => {
    const expr = call.expression as Parser.CallExpression;
    assertInt(expr.arguments[0], 1n);
  });
});

test("a longer literal is still propagated when few enough references make it shorter overall", () => {
  // "hello"(7バイト)を2回参照する場合は、宣言を残すより配る方が短くなる
  // (worthPropagatingWhenShared: 2*(7-1)=12 <= 7+8=15)。1文字リテラルに限らない
  // 一般化した収支判定になっていることを確認する。
  const chunk = fold(`
    local greeting = "hello"
    print(greeting)
    print(greeting)
  `);
  const calls = chunk.body.filter(
    (s): s is Parser.CallStatement => s.type === "CallStatement",
  );
  calls.forEach((call) => {
    const expr = call.expression as Parser.CallExpression;
    assertStringValue(expr.arguments[0], "hello");
  });
});

test("a reassigned local is not propagated", () => {
  const chunk = fold(`
    local x = 5
    x = 7
    return x
  `);
  const ret = chunk.body[chunk.body.length - 1] as Parser.ReturnStatement;
  assert.equal(ret.arguments[0].type, "Identifier");
  // 代入の左辺が壊れて`5 = 7`のようにならないことも合わせて確認する。
  const assignment = chunk.body[1] as Parser.AssignmentStatement;
  assert.equal(assignment.variables[0].type, "Identifier");
});

test("a reassigned local produces output that re-parses without throwing", () => {
  const code = runFoldedMinifier(`
    local x = 5
    x = 7
    return x
  `);
  assert.doesNotThrow(() => Parser.parse(code, { luaVersion: "5.3" }));
});

test("--@storm keep declarations are not propagated", () => {
  const chunk = fold(`
    --@storm keep
    local kept = 9
    return kept
  `);
  const ret = chunk.body[chunk.body.length - 1] as Parser.ReturnStatement;
  assert.equal(ret.arguments[0].type, "Identifier");
});

test("--@storm keep-name declarations are not propagated", () => {
  const chunk = fold(`
    --@storm keep-name
    local kept = 9
    return kept
  `);
  const ret = chunk.body[chunk.body.length - 1] as Parser.ReturnStatement;
  assert.equal(ret.arguments[0].type, "Identifier");
});

test("--@storm export declarations are not propagated", () => {
  const chunk = fold(`
    --@storm export
    local kept = 9
    return kept
  `);
  const ret = chunk.body[chunk.body.length - 1] as Parser.ReturnStatement;
  assert.equal(ret.arguments[0].type, "Identifier");
});

test("chained constant locals: W=10, H=20, A=W*H propagates and folds A to 200", () => {
  const chunk = fold(`
    local W = 10
    local H = 20
    local A = W * H
    return A
  `);
  const aDeclaration = chunk.body[2] as Parser.LocalStatement;
  assertInt(aDeclaration.init[0], 200n);
});

// ============================================================
// 定数を基底へ置いたときの出力
// ============================================================
//
// Luaの文法で基底にそのまま置けるのは変数・インデックス式・関数呼び出しだけで、
// 定数を置くには丸括弧が要る。括弧が落ちると`3.field`のように字句解析が壊れる
// ので、Minifierを通した出力を再パースして確かめる。

test("a constant propagated into a member-access base is parenthesized", () => {
  const code = runFoldedMinifier(`
    local x = 1 + 2
    return x.field
  `);
  assert.ok(code.includes("(3).field"), code);
  assert.doesNotThrow(() => Parser.parse(code, { luaVersion: "5.3" }));
});

test("a constant propagated into a method-call base is parenthesized", () => {
  const code = runFoldedMinifier(`
    local s = "a" .. "b"
    return s:upper()
  `);
  assert.ok(code.includes('("ab"):upper()'), code);
  assert.doesNotThrow(() => Parser.parse(code, { luaVersion: "5.3" }));
});

// ============================================================
// 目的の確認
// ============================================================

// 定数畳み込みは出力を縮めるための機能である。構文が壊れていないことも、
// 言語仕様どおりに計算していることも、それだけでは目的を満たさない。
// 配った先で宣言が残って出力が伸びるような状態は、この形でしか捕まらない。
test("すべてのfixtureで、定数最適化は出力を長くしない", () => {
  const grown: string[] = [];
  WORKING_CASES.forEach((c) => {
    const plain = runMinifier({
      ...c,
      mode: { ...c.mode, constantOptimizations: false },
    }).code;
    const folded = runMinifier({
      ...c,
      mode: { ...c.mode, constantOptimizations: true },
    }).code;
    if (folded.length > plain.length) {
      grown.push(
        `${c.label}: ${String(plain.length)} -> ${String(folded.length)}`,
      );
    }
  });
  assert.deepEqual(grown, [], "有効にすると伸びるfixtureがあります");
}, 20_000);

// ============================================================
// Source Map
// ============================================================

// 生成コード中で`needle`が最初に現れる位置を、source-map準拠の座標
// （行は1始まり、列は0始まり）で返す。
function locateInGenerated(
  code: string,
  needle: string,
): { line: number; column: number } {
  const lines = code.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const column = lines[i].indexOf(needle);
    if (column >= 0) return { line: i + 1, column };
  }
  throw new Error("生成コードに見つかりません: " + needle);
}

// 元ソース中で`needle`を含む最初の行番号（1始まり）を返す。
function lineOfSource(source: string, needle: string): number {
  const lines = source.split("\n");
  const index = lines.findIndex((line) => line.includes(needle));
  if (index < 0) throw new Error("元ソースに見つかりません: " + needle);
  return index + 1;
}

// このパスは畳み込み・伝搬のたびに新しいASTノードを作り、位置情報を手で
// 引き継ぐ。引き継ぎを誤ると、出力は正しいのにSource Mapだけが黙って壊れる。
test("const-fold fixture keeps a source map that points into the original file", async () => {
  const { code, map } = runMinifier({
    label: "定数の事前計算と定数伝搬",
    fixture: "const-fold",
    mode: { requireWrapper: false, constantOptimizations: true },
  });
  const source = fs.readFileSync(fixtureEntryPath("const-fold"), "utf8");
  const sourceLineCount = source.split("\n").length;

  assert.ok(map.sources.includes("main.lua"));
  assert.ok(map.mappings.length > 0);

  await SourceMapConsumer.with(map, null, (consumer) => {
    // 元ファイルに存在しない行を指すマッピングが無いこと。
    // 生成側にしか対応の無いマッピングでは、型定義に反して実際にはnullが入る。
    // 型を信じずに実行時の値で振り分けるため、いったんunknownとして集める。
    const originalLines: unknown[] = [];
    consumer.eachMapping((mapping) => originalLines.push(mapping.originalLine));
    originalLines.forEach((line) => {
      if (typeof line !== "number") return;
      assert.ok(
        line >= 1 && line <= sourceLineCount,
        "元ファイルの範囲外を指すマッピングがあります: " + String(line),
      );
    });

    // 伝搬されたリテラルは、宣言側ではなく参照側の位置を指す。
    // ここでの200は`local area = width * height`が畳み込まれた値だが、
    // 出力に現れているのは`print(area)`の引数の位置である。
    const generated200 = locateInGenerated(code, "200");
    const original200 = consumer.originalPositionFor(generated200);
    assert.equal(original200.line, lineOfSource(source, "print(area)"));

    // 畳み込んだうえで配ったリテラルも、参照側の位置を指す。
    // `"ab"`は`local label = "a" .. "b"`を計算した値だが、出力に現れているのは
    // `print(label:upper())`の基底の位置である。
    const generatedAb = locateInGenerated(code, '"ab"');
    const originalAb = consumer.originalPositionFor(generatedAb);
    assert.equal(originalAb.line, lineOfSource(source, "print(label:upper())"));
  });
});

// ============================================================
// 既定の不変性
// ============================================================

test("foldConstants defaults to disabled: output is unchanged without the option", () => {
  const code = `
    local x = 1 + 2
    return x
  `;
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), "storm-const-fold-default-"),
  );
  const filePath = path.join(dir, "main.lua");
  fs.writeFileSync(filePath, code);
  try {
    const withoutOption = new Minifier(
      filePath,
      { locations: true, luaVersion: "5.3", ranges: true, scope: true },
      { requireWrapper: false },
    )
      .parse()
      .toStringWithSourceMap({ file: "main.min.lua" }).code;
    const withOptionFalse = new Minifier(
      filePath,
      { locations: true, luaVersion: "5.3", ranges: true, scope: true },
      { requireWrapper: false, constantOptimizations: false },
    )
      .parse()
      .toStringWithSourceMap({ file: "main.min.lua" }).code;
    assert.equal(withoutOption, withOptionFalse);
    // 折り畳まれていれば`1 + 2`は跡形もなく消えるはずなので、
    // 既定では加算がそのまま残っていることも確認する。
    assert.ok(withoutOption.includes("+"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
