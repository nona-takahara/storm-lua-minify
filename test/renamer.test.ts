import { test } from "node:test";
import assert from "node:assert/strict";
import Parser from "luaparse";
import { resolveScopes } from "../src/resolver";
import { assignRenames } from "../src/renamer";

// Renameパス（#20）の単体テスト。スコープに基づくスロット再利用、頻度順の名前割当、
// 予約名との非衝突を検証する。

function parse(code: string): Parser.Chunk {
  return Parser.parse(code, { luaVersion: "5.3" });
}

void test("sibling scopes (non-overlapping) reuse the same short name", () => {
  const chunk = parse(`
    do
      local x = 1
      print(x)
    end
    do
      local y = 2
      print(y)
    end
  `);
  const resolved = resolveScopes(chunk);
  const result = assignRenames(resolved, new Set());

  const firstDecl = (
    (chunk.body[0] as Parser.DoStatement).body[0] as Parser.LocalStatement
  ).variables[0];
  const secondDecl = (
    (chunk.body[1] as Parser.DoStatement).body[0] as Parser.LocalStatement
  ).variables[0];

  const firstName = result.nameOf(firstDecl);
  const secondName = result.nameOf(secondDecl);
  assert.ok(firstName);
  assert.equal(firstName, secondName);
});

void test("symbols live in the same scope never receive the same short name", () => {
  const chunk = parse(`
    local a = 1
    local b = 2
    local c = 3
    print(a, b, c)
  `);
  const resolved = resolveScopes(chunk);
  const result = assignRenames(resolved, new Set());

  const names = (chunk.body.slice(0, 3) as Parser.LocalStatement[]).map((s) =>
    result.nameOf(s.variables[0]),
  );
  assert.equal(new Set(names).size, 3);
});

void test("more frequently referenced symbols get shorter names", () => {
  const chunk = parse(`
    local hot = 1
    local cold = 2
    print(hot, hot, hot, hot)
    print(cold)
  `);
  const resolved = resolveScopes(chunk);
  const result = assignRenames(resolved, new Set());

  const hotDecl = (chunk.body[0] as Parser.LocalStatement).variables[0];
  const coldDecl = (chunk.body[1] as Parser.LocalStatement).variables[0];

  const hotName = result.nameOf(hotDecl);
  const coldName = result.nameOf(coldDecl);
  assert.ok(hotName);
  assert.ok(coldName);
  assert.ok(hotName.length <= coldName.length);
  assert.notEqual(hotName, coldName);
});

void test("reserved names (globals/keywords) are never assigned to a symbol", () => {
  const chunk = parse(`
    local x = 1
    print(x)
  `);
  const resolved = resolveScopes(chunk);
  // "a" は本来最初に割り当てられるはずの名前。予約済みとして渡すと避けられる。
  const result = assignRenames(resolved, new Set(["a"]));

  const decl = (chunk.body[0] as Parser.LocalStatement).variables[0];
  assert.notEqual(result.nameOf(decl), "a");
});

void test("self is never renamed and never assigned to another symbol", () => {
  const chunk = parse(`
    local function m(self, x)
      return self, x
    end
  `);
  const resolved = resolveScopes(chunk);
  const result = assignRenames(resolved, new Set());

  const fnDecl = chunk.body[0] as Parser.FunctionDeclaration;
  const selfParam = fnDecl.parameters[0] as Parser.Identifier;
  const xParam = fnDecl.parameters[1] as Parser.Identifier;

  assert.equal(result.nameOf(selfParam), undefined);
  assert.notEqual(result.nameOf(xParam), "self");
});

void test("usedNames reflects exactly the short names handed out", () => {
  const chunk = parse(`
    local x = 1
    do
      local y = 2
      print(y)
    end
    print(x)
  `);
  const resolved = resolveScopes(chunk);
  const result = assignRenames(resolved, new Set());

  const xDecl = (chunk.body[0] as Parser.LocalStatement).variables[0];
  const yDecl = (
    (chunk.body[1] as Parser.DoStatement).body[0] as Parser.LocalStatement
  ).variables[0];

  const xName = result.nameOf(xDecl);
  const yName = result.nameOf(yDecl);
  assert.ok(xName);
  assert.ok(yName);
  assert.deepEqual(result.usedNames, new Set([xName, yName]));
});
