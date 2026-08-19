import { test } from "vitest";
import assert from "node:assert/strict";
import Parser from "luaparse";
import { resolveScopes } from "../src/resolver";
import { removeUnusedLocals } from "../src/removeUnused";
import { SourceMetadata } from "../src/sourceMetadata";

function remove(code: string): Parser.Chunk {
  const chunk = Parser.parse(code, {
    luaVersion: "5.3",
    comments: true,
    locations: true,
    ranges: true,
  });
  const metadata = new SourceMetadata(chunk, code);
  let resolved = resolveScopes(chunk);
  while (removeUnusedLocals(chunk, resolved, metadata)) {
    resolved = resolveScopes(chunk);
  }
  return chunk;
}

test("removes unused local functions including self-recursive functions", () => {
  const chunk = remove(`
    local function plain() end
    local function recursive() recursive() end
    print("kept")
  `);
  assert.deepEqual(
    chunk.body.map((v) => v.type),
    ["CallStatement"],
  );
});

test("removes safe single locals to a fixed point", () => {
  const chunk = remove(`
    local value = 1
    local function consumer() print(value) end
  `);
  assert.equal(chunk.body.length, 0);
});

test("keeps used, annotated, effectful, multi-variable, and expandable locals", () => {
  const chunk = remove(`
    local used = 1
    print(used)
    --@storm keep
    local retained = 2
    local effectful = call()
    local tableValue = {}
    local calculated = 1 + 2
    local indexed = object.value
    local c = ...
  `);
  assert.equal(chunk.body.length, 8);
});

test("turns direct initializers of wholly unused declarations into statements", () => {
  const chunk = remove(`
    local a, b, c, d, e = 1, first(), function() end, second {}, third "x"
  `);
  assert.deepEqual(
    chunk.body.map((statement) => statement.type),
    ["CallStatement", "CallStatement", "CallStatement"],
  );
  assert.deepEqual(
    chunk.body.map((statement) => {
      const expression = (statement as Parser.CallStatement).expression;
      return expression.base.type === "Identifier" ? expression.base.name : "";
    }),
    ["first", "second", "third"],
  );
});

test("removes discardable pairs without shifting values of retained locals", () => {
  const chunk = remove(`
    local first, unused, last = makeFirst(), 1, makeLast()
    print(first, last)
  `);
  const declaration = chunk.body[0] as Parser.LocalStatement;
  assert.deepEqual(
    declaration.variables.map((variable) => variable.name),
    ["first", "last"],
  );
  assert.deepEqual(
    declaration.init.map((expression) => expression.type),
    ["CallExpression", "CallExpression"],
  );
});

test("removes unused names anywhere when a declaration has no initializers", () => {
  const chunk = remove(`
    local first, unused, last
    print(first, last)
  `);
  const declaration = chunk.body[0] as Parser.LocalStatement;
  assert.deepEqual(
    declaration.variables.map((variable) => variable.name),
    ["first", "last"],
  );
  assert.equal(declaration.init.length, 0);
});

test("removes an unused suffix while preserving surplus RHS evaluation", () => {
  const chunk = remove(`
    local used, unused = first(), second()
    print(used)
  `);
  const declaration = chunk.body[0] as Parser.LocalStatement;
  assert.deepEqual(
    declaration.variables.map((variable) => variable.name),
    ["used"],
  );
  assert.equal(declaration.init.length, 2);
});

test("handles fewer and excess initializers without changing their order", () => {
  const fewer = remove(`
    local used, unused = values()
    print(used)
  `).body[0] as Parser.LocalStatement;
  assert.equal(fewer.variables.length, 1);
  assert.equal(fewer.init.length, 1);

  const excess = remove(`
    local used, unused = first(), second(), third()
    print(used)
  `).body[0] as Parser.LocalStatement;
  assert.equal(excess.variables.length, 1);
  assert.equal(excess.init.length, 3);
});

test("keeps unsafe middle values, expandable expressions, and protected declarations", () => {
  const chunk = remove(`
    local usedA, unsafe, usedB = first(), side(), third()
    print(usedA, usedB)
    local tableValue, calculated, indexed, expanded = {}, 1 + 2, object.value, ...
    --@storm keep
    local keptA, keptB = 1, second()
    --@storm export
    local exportedA, exportedB = 1, third()
  `);
  assert.equal((chunk.body[0] as Parser.LocalStatement).variables.length, 3);
  assert.equal((chunk.body[2] as Parser.LocalStatement).variables.length, 4);
  assert.equal((chunk.body[3] as Parser.LocalStatement).variables.length, 2);
  assert.equal((chunk.body[4] as Parser.LocalStatement).variables.length, 2);
});

test("keep-name alone does not prevent unused removal", () => {
  const chunk = remove(`
    --@storm keep-name
    local unusedA, unusedB = 1, call()
  `);
  assert.deepEqual(
    chunk.body.map((statement) => statement.type),
    ["CallStatement"],
  );
});

test("recurses through nested blocks and distinguishes shadowed symbols", () => {
  const chunk = remove(`
    local value = 1
    do
      local value = 2
      print(value)
    end
  `);
  assert.equal(chunk.body.length, 1);
  const block = chunk.body[0] as Parser.DoStatement;
  assert.equal(block.body.length, 2);
});

test("detached file comments survive removal of the following declaration", () => {
  const code = `--# detached

local unused = 1`;
  const chunk = Parser.parse(code, {
    luaVersion: "5.3",
    comments: true,
    locations: true,
    ranges: true,
  });
  const metadata = new SourceMetadata(chunk, code);
  removeUnusedLocals(chunk, resolveScopes(chunk), metadata);
  assert.equal(chunk.body.length, 0);
  assert.deepEqual(
    metadata.afterModuleComments().map((v) => v.raw),
    ["--# detached"],
  );
});
