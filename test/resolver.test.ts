import { test } from "vitest";
import assert from "node:assert/strict";
import Parser from "luaparse";
import { resolveScopes } from "../src/resolver";

// Resolveパス（#19）の単体テスト。宣言と参照の対応、シャドーイング、グローバル判定を検証する。
// このパスは出力を変更しないため、ここでは解析結果のみを検証する。

function parse(code: string): Parser.Chunk {
  return Parser.parse(code, { luaVersion: "5.3" });
}

test("binds colon method self as an implicit first parameter", () => {
  const chunk = parse(
    "local Object={} function Object:method(value)return self.value,value end",
  );
  const result = resolveScopes(chunk);
  const method = chunk.body[1] as Parser.FunctionDeclaration;
  assert.equal(method.type, "FunctionDeclaration");
  const self = result.scopeOfFunction(method)?.symbols[0];

  assert.ok(self);
  assert.equal(self.kind, "param");
  assert.equal(self.name, "self");
  assert.equal(self.references.length, 1);
  assert.equal(result.globals.has("self"), false);
});

test("resolves references to their declaring local symbol", () => {
  const chunk = parse(`
    local x = 1
    print(x)
    x = 2
  `);
  const result = resolveScopes(chunk);

  const declaration = (chunk.body[0] as Parser.LocalStatement).variables[0];
  const declSymbol = result.symbolOf(declaration);
  assert.ok(declSymbol);
  assert.equal(declSymbol.kind, "local");

  const printArg = (
    (chunk.body[1] as Parser.CallStatement).expression as Parser.CallExpression
  ).arguments[0] as Parser.Identifier;
  assert.equal(result.symbolOf(printArg), declSymbol);

  const assignTarget = (chunk.body[2] as Parser.AssignmentStatement)
    .variables[0] as Parser.Identifier;
  assert.equal(result.symbolOf(assignTarget), declSymbol);

  assert.deepEqual(
    declSymbol.references.map((r) => r.name),
    ["x", "x"],
  );
});

test("shadowed locals in a nested block resolve to a distinct symbol", () => {
  const chunk = parse(`
    local x = 1
    do
      local x = 2
      print(x)
    end
    print(x)
  `);
  const result = resolveScopes(chunk);

  const outerDecl = (chunk.body[0] as Parser.LocalStatement).variables[0];
  const outerSymbol = result.symbolOf(outerDecl);

  const doStatement = chunk.body[1] as Parser.DoStatement;
  const innerDecl = (doStatement.body[0] as Parser.LocalStatement).variables[0];
  const innerSymbol = result.symbolOf(innerDecl);

  assert.ok(outerSymbol);
  assert.ok(innerSymbol);
  assert.notEqual(innerSymbol, outerSymbol);

  const innerPrintArg = (
    (doStatement.body[1] as Parser.CallStatement)
      .expression as Parser.CallExpression
  ).arguments[0] as Parser.Identifier;
  assert.equal(result.symbolOf(innerPrintArg), innerSymbol);

  const outerPrintArg = (
    (chunk.body[2] as Parser.CallStatement).expression as Parser.CallExpression
  ).arguments[0] as Parser.Identifier;
  assert.equal(result.symbolOf(outerPrintArg), outerSymbol);
});

test("re-declaring a local in the same block shadows only subsequent references", () => {
  const chunk = parse(`
    local x = 1
    print(x)
    local x = 2
    print(x)
  `);
  const result = resolveScopes(chunk);

  const firstSymbol = result.symbolOf(
    (chunk.body[0] as Parser.LocalStatement).variables[0],
  );
  const secondSymbol = result.symbolOf(
    (chunk.body[2] as Parser.LocalStatement).variables[0],
  );
  assert.ok(firstSymbol);
  assert.ok(secondSymbol);
  assert.notEqual(firstSymbol, secondSymbol);

  const firstPrintArg = (
    (chunk.body[1] as Parser.CallStatement).expression as Parser.CallExpression
  ).arguments[0] as Parser.Identifier;
  assert.equal(result.symbolOf(firstPrintArg), firstSymbol);

  const secondPrintArg = (
    (chunk.body[3] as Parser.CallStatement).expression as Parser.CallExpression
  ).arguments[0] as Parser.Identifier;
  assert.equal(result.symbolOf(secondPrintArg), secondSymbol);
});

test("a function parameter shadows an outer local of the same name", () => {
  const chunk = parse(`
    local x = 1
    local function f(x)
      return x
    end
  `);
  const result = resolveScopes(chunk);

  const outerSymbol = result.symbolOf(
    (chunk.body[0] as Parser.LocalStatement).variables[0],
  );
  const fnDecl = chunk.body[1] as Parser.FunctionDeclaration;
  const paramSymbol = result.symbolOf(
    fnDecl.parameters[0] as Parser.Identifier,
  );
  assert.ok(outerSymbol);
  assert.ok(paramSymbol);
  assert.notEqual(paramSymbol, outerSymbol);
  assert.equal(paramSymbol.kind, "param");

  const returnArg = (fnDecl.body[0] as Parser.ReturnStatement)
    .arguments[0] as Parser.Identifier;
  assert.equal(result.symbolOf(returnArg), paramSymbol);
});

test("a local function can refer to itself recursively", () => {
  const chunk = parse(`
    local function fact(n)
      if n <= 1 then return 1 end
      return n * fact(n - 1)
    end
  `);
  const result = resolveScopes(chunk);

  const fnDecl = chunk.body[0] as Parser.FunctionDeclaration;
  const declSymbol = result.symbolOf(fnDecl.identifier as Parser.Identifier);
  assert.ok(declSymbol);
  assert.equal(declSymbol.kind, "local");

  const returnStatement = fnDecl.body[1] as Parser.ReturnStatement;
  const multiplyExpr = returnStatement.arguments[0] as Parser.BinaryExpression;
  const callExpr = multiplyExpr.right as Parser.CallExpression;
  const callee = callExpr.base as Parser.Identifier;
  assert.equal(result.symbolOf(callee), declSymbol);
});

test("a numeric for-loop variable is scoped to the loop body only", () => {
  const chunk = parse(`
    for i = 1, 10 do
      print(i)
    end
    print(i)
  `);
  const result = resolveScopes(chunk);

  const forStatement = chunk.body[0] as Parser.ForNumericStatement;
  const loopVarSymbol = result.symbolOf(forStatement.variable);
  assert.ok(loopVarSymbol);
  assert.equal(loopVarSymbol.kind, "for");

  const insideArg = (
    (forStatement.body[0] as Parser.CallStatement)
      .expression as Parser.CallExpression
  ).arguments[0] as Parser.Identifier;
  assert.equal(result.symbolOf(insideArg), loopVarSymbol);

  // ループの外側にある同名の参照は、ループ変数のシンボルとは無関係でグローバル扱いになる
  const afterArg = (
    (chunk.body[1] as Parser.CallStatement).expression as Parser.CallExpression
  ).arguments[0] as Parser.Identifier;
  assert.equal(result.symbolOf(afterArg), undefined);
  assert.ok(result.globals.has("i"));
});

test("unresolved identifiers are collected as globals, not symbols, and field/key names are ignored", () => {
  const chunk = parse(`
    screen.setColor(1, 2, 3)
    local w, h = screen.getWidth(), screen.getHeight()
    local t = { x = 1 }
  `);
  const result = resolveScopes(chunk);

  // "screen" はどこにも宣言されていないためグローバル参照が3回集計される
  const screenBinding = result.globals.get("screen");
  assert.ok(screenBinding);
  assert.equal(screenBinding.references.length, 3);

  // フィールド名（setColor/getWidth/getHeight）やテーブルキー名（x）は
  // 変数参照ではないため、グローバルにもシンボルにも現れない
  assert.equal(result.globals.size, 1);
  assert.ok(!result.symbols.some((s) => s.name === "screen"));
  assert.ok(!result.symbols.some((s) => s.name === "x"));

  assert.deepEqual(
    result.symbols
      .filter((s) => s.kind === "local")
      .map((s) => s.name)
      .sort(),
    ["h", "t", "w"],
  );
});

test("GlobalBinding.writes only records assignment-target occurrences (#8a)", () => {
  const chunk = parse(`
    print(readOnly)
    writable = 1
    writable = writable + 1
    function onTick() end
  `);
  const result = resolveScopes(chunk);

  const readOnlyBinding = result.globals.get("readOnly");
  assert.ok(readOnlyBinding);
  assert.equal(readOnlyBinding.references.length, 1);
  assert.equal(readOnlyBinding.writes.length, 0);

  const writableBinding = result.globals.get("writable");
  assert.ok(writableBinding);
  // 代入先2回 + 加算式の右辺での読み取り1回 = 参照3回
  assert.equal(writableBinding.references.length, 3);
  assert.equal(writableBinding.writes.length, 2);

  // `function name() end`形式のグローバル宣言も代入先として扱われる
  const onTickBinding = result.globals.get("onTick");
  assert.ok(onTickBinding);
  assert.equal(onTickBinding.references.length, 1);
  assert.equal(onTickBinding.writes.length, 1);
});

test("isGlobalReference distinguishes real global references from field names with the same spelling (#8a)", () => {
  const chunk = parse(`
    counter = 1
    local t = {}
    t.counter = 2
  `);
  const result = resolveScopes(chunk);

  const globalAssignTarget = (chunk.body[0] as Parser.AssignmentStatement)
    .variables[0] as Parser.Identifier;
  assert.equal(result.isGlobalReference(globalAssignTarget), true);

  const fieldAssignTarget = (
    (chunk.body[2] as Parser.AssignmentStatement)
      .variables[0] as Parser.MemberExpression
  ).identifier;
  assert.equal(result.isGlobalReference(fieldAssignTarget), false);
});
