import { describe, test } from "vitest";
import assert from "node:assert/strict";
import Parser from "luaparse";
import { resolveScopes } from "../src/resolver";
import { assignRenames } from "../src/renamer";

describe("local identifier renaming", () => {
  function parse(code: string): Parser.Chunk {
    return Parser.parse(code, { luaVersion: "5.3" });
  }

  test("sibling scopes (non-overlapping) reuse the same short name", () => {
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
    const result = assignRenames(chunk, resolved, new Set());

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

  test("symbols live in the same scope never receive the same short name", () => {
    const chunk = parse(`
    local a = 1
    local b = 2
    local c = 3
    print(a, b, c)
  `);
    const resolved = resolveScopes(chunk);
    const result = assignRenames(chunk, resolved, new Set());

    const names = (chunk.body.slice(0, 3) as Parser.LocalStatement[]).map((s) =>
      result.nameOf(s.variables[0]),
    );
    assert.equal(new Set(names).size, 3);
  });

  test("same-scope symbols with disjoint liveness reuse one short name", () => {
    const chunk = parse(`
    local first = 1
    print(first)
    local second = 2
    print(second)
  `);
    const resolved = resolveScopes(chunk);
    const result = assignRenames(
      chunk,
      resolved,
      new Set(),
      undefined,
      new Set(),
      { allowLocalNameReuse: true },
    );
    const first = (chunk.body[0] as Parser.LocalStatement).variables[0];
    const second = (chunk.body[2] as Parser.LocalStatement).variables[0];

    assert.equal(result.nameOf(first), result.nameOf(second));
  });

  test("branch join and loop back-edge keep simultaneously live symbols apart", () => {
    const chunk = parse(`
    local branchValue = 0
    if flag then branchValue = 1 else branchValue = 2 end
    local loopValue = 0
    while flag do loopValue = loopValue + branchValue end
    print(branchValue, loopValue)
  `);
    const resolved = resolveScopes(chunk);
    const result = assignRenames(
      chunk,
      resolved,
      new Set(),
      undefined,
      new Set(),
      { allowLocalNameReuse: true },
    );
    const branchValue = (chunk.body[0] as Parser.LocalStatement).variables[0];
    const loopValue = (chunk.body[2] as Parser.LocalStatement).variables[0];

    assert.notEqual(result.nameOf(branchValue), result.nameOf(loopValue));
  });

  test("a captured ancestor never collides with a nested local", () => {
    const chunk = parse(`
    local captured = 1
    do
      local nested = 2
      local function read() return captured end
      print(nested, read())
    end
  `);
    const resolved = resolveScopes(chunk);
    const result = assignRenames(
      chunk,
      resolved,
      new Set(),
      undefined,
      new Set(),
      { allowLocalNameReuse: true },
    );
    const captured = (chunk.body[0] as Parser.LocalStatement).variables[0];
    const nested = (
      (chunk.body[1] as Parser.DoStatement).body[0] as Parser.LocalStatement
    ).variables[0];

    assert.notEqual(result.nameOf(captured), result.nameOf(nested));
  });

  test("a captured local never collides with a same-scope function binding", () => {
    const chunk = parse(`
    local captured
    local function reader() return captured end
    reader()
  `);
    const resolved = resolveScopes(chunk);
    const result = assignRenames(
      chunk,
      resolved,
      new Set(),
      undefined,
      new Set(),
      { allowLocalNameReuse: true },
    );
    const captured = (chunk.body[0] as Parser.LocalStatement).variables[0];
    const reader = (chunk.body[1] as Parser.FunctionDeclaration)
      .identifier as Parser.Identifier;

    assert.notEqual(result.nameOf(captured), result.nameOf(reader));
  });

  test("parameters bound together interfere", () => {
    const chunk = parse(`
    local function combine(left, right) return left + right end
  `);
    const resolved = resolveScopes(chunk);
    const result = assignRenames(
      chunk,
      resolved,
      new Set(),
      undefined,
      new Set(),
      { allowLocalNameReuse: true },
    );
    const fn = chunk.body[0] as Parser.FunctionDeclaration;
    const left = fn.parameters[0] as Parser.Identifier;
    const right = fn.parameters[1] as Parser.Identifier;

    assert.notEqual(result.nameOf(left), result.nameOf(right));
  });

  test("generic-for variables bound together interfere", () => {
    const chunk = parse(`
    for key, value in pairs(items) do print(key, value) end
  `);
    const resolved = resolveScopes(chunk);
    const result = assignRenames(
      chunk,
      resolved,
      new Set(),
      undefined,
      new Set(),
      { allowLocalNameReuse: true },
    );
    const loop = chunk.body[0] as Parser.ForGenericStatement;

    assert.notEqual(
      result.nameOf(loop.variables[0]),
      result.nameOf(loop.variables[1]),
    );
  });

  test("return keeps all returned locals mutually live", () => {
    const chunk = parse(`
    local first = source()
    local second = source()
    return first, second
  `);
    const resolved = resolveScopes(chunk);
    const result = assignRenames(
      chunk,
      resolved,
      new Set(),
      undefined,
      new Set(),
      { allowLocalNameReuse: true },
    );
    const first = (chunk.body[0] as Parser.LocalStatement).variables[0];
    const second = (chunk.body[1] as Parser.LocalStatement).variables[0];

    assert.notEqual(result.nameOf(first), result.nameOf(second));
  });

  test("coloring is deterministic", () => {
    const source = `
    local first = 1
    print(first)
    local second = 2
    print(second)
  `;
    const names = () => {
      const chunk = parse(source);
      const resolved = resolveScopes(chunk);
      const result = assignRenames(
        chunk,
        resolved,
        new Set(),
        undefined,
        new Set(),
        { allowLocalNameReuse: true },
      );
      return resolved.symbols.map((symbol) =>
        result.nameOf(symbol.declaration),
      );
    };

    assert.deepEqual(names(), names());
  });

  test("more frequently referenced symbols get shorter names", () => {
    const chunk = parse(`
    local hot = 1
    local cold = 2
    print(hot, hot, hot, hot)
    print(cold)
  `);
    const resolved = resolveScopes(chunk);
    const result = assignRenames(chunk, resolved, new Set());

    const hotDecl = (chunk.body[0] as Parser.LocalStatement).variables[0];
    const coldDecl = (chunk.body[1] as Parser.LocalStatement).variables[0];

    const hotName = result.nameOf(hotDecl);
    const coldName = result.nameOf(coldDecl);
    assert.ok(hotName);
    assert.ok(coldName);
    assert.ok(hotName.length <= coldName.length);
    assert.notEqual(hotName, coldName);
  });

  test("reserved names (globals/keywords) are never assigned to a symbol", () => {
    const chunk = parse(`
    local x = 1
    print(x)
  `);
    const resolved = resolveScopes(chunk);
    // Reserving the preferred first name forces the allocator to skip it.
    const result = assignRenames(chunk, resolved, new Set(["a"]));

    const decl = (chunk.body[0] as Parser.LocalStatement).variables[0];
    assert.notEqual(result.nameOf(decl), "a");
  });

  test("self is never renamed and never assigned to another symbol", () => {
    const chunk = parse(`
    local function m(self, x)
      return self, x
    end
  `);
    const resolved = resolveScopes(chunk);
    const result = assignRenames(chunk, resolved, new Set());

    const fnDecl = chunk.body[0] as Parser.FunctionDeclaration;
    const selfParam = fnDecl.parameters[0] as Parser.Identifier;
    const xParam = fnDecl.parameters[1] as Parser.Identifier;

    assert.equal(result.nameOf(selfParam), undefined);
    assert.notEqual(result.nameOf(xParam), "self");
  });

  test("usedNames reflects exactly the short names handed out", () => {
    const chunk = parse(`
    local x = 1
    do
      local y = 2
      print(y)
    end
    print(x)
  `);
    const resolved = resolveScopes(chunk);
    const result = assignRenames(chunk, resolved, new Set());

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

  test("globalRenames applies to genuine global references", () => {
    const chunk = parse(`
    counter = 0
    counter = counter + 1
  `);
    const resolved = resolveScopes(chunk);
    const result = assignRenames(
      chunk,
      resolved,
      new Set(),
      new Map([["counter", "g"]]),
    );

    const firstAssignTarget = (chunk.body[0] as Parser.AssignmentStatement)
      .variables[0] as Parser.Identifier;
    assert.equal(result.nameOf(firstAssignTarget), "g");
  });

  test("globalRenames leaves a same-spelling field unchanged", () => {
    const chunk = parse(`
    counter = 0
    local t = {}
    t.counter = 1
    print(t.counter)
  `);
    const resolved = resolveScopes(chunk);
    const result = assignRenames(
      chunk,
      resolved,
      new Set(),
      new Map([["counter", "g"]]),
    );

    const fieldAssignTarget = (
      (chunk.body[2] as Parser.AssignmentStatement)
        .variables[0] as Parser.MemberExpression
    ).identifier;
    const fieldReadTarget = (
      (
        (chunk.body[3] as Parser.CallStatement)
          .expression as Parser.CallExpression
      ).arguments[0] as Parser.MemberExpression
    ).identifier;

    // A field and global with the same spelling have independent identities.
    assert.equal(result.nameOf(fieldAssignTarget), undefined);
    assert.equal(result.nameOf(fieldReadTarget), undefined);
  });
});
