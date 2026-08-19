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
    local a, b = 1, 2
    local c = ...
  `);
  assert.equal(chunk.body.length, 9);
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
