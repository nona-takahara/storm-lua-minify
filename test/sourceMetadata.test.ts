import { test } from "vitest";
import assert from "node:assert/strict";
import Parser from "luaparse";
import { SourceMetadata } from "../src/sourceMetadata";
import { resolveScopes } from "../src/resolver";
import { mergeLocalDeclarations } from "../src/transform";

function metadata(code: string): {
  chunk: Parser.Chunk;
  metadata: SourceMetadata;
} {
  const chunk = Parser.parse(code, {
    luaVersion: "5.3",
    comments: true,
    locations: true,
    ranges: true,
  });
  return { chunk, metadata: new SourceMetadata(chunk, code) };
}

test("associates leading, trailing, and detached comments with statement boundaries", () => {
  const code = `--# leading
local a = 1 --# trailing

--# detached
local b = 2`;
  const { chunk, metadata: result } = metadata(code);
  assert.deepEqual(
    result.beforeOf(chunk.body[0]).map((v) => v.raw),
    ["--# leading"],
  );
  assert.deepEqual(
    result.trailingOf(chunk.body[0]).map((v) => v.raw),
    ["--# trailing"],
  );
  assert.deepEqual(
    result.beforeOf(chunk.body[1]).map((v) => v.raw),
    ["--# detached"],
  );
});

test("parses contiguous annotations and expands export", () => {
  const code = `--@storm keep
--@storm export
function onTick() end`;
  const { chunk, metadata: result } = metadata(code);
  assert.deepEqual(result.annotationsOf(chunk.body[0]), {
    keep: true,
    keepName: true,
    exported: true,
  });
});

test("does not attach an annotation across a blank line", () => {
  const code = `--@storm keep

local unused = 1`;
  const { chunk, metadata: result } = metadata(code);
  assert.equal(result.annotationsOf(chunk.body[0]).keep, false);
});

test("rejects unknown or argument-bearing storm annotations", () => {
  assert.throws(
    () => metadata(`--@storm keep extra\nlocal a = 1`),
    /Unknown storm annotation/,
  );
  assert.throws(
    () => metadata(`--@storm mystery\nlocal a = 1`),
    /Unknown storm annotation/,
  );
});

test("transfers preserved comments when local declarations are merged", () => {
  const code = `--# first
local a = call()
--# second
local b = call()`;
  const { chunk, metadata: result } = metadata(code);
  mergeLocalDeclarations(
    chunk,
    resolveScopes(chunk),
    { preserveRequireSplice: false },
    result,
  );
  assert.equal(chunk.body.length, 1);
  assert.deepEqual(
    result.beforeOf(chunk.body[0]).map((v) => v.raw),
    ["--# first", "--# second"],
  );
});

test("moves outer comments to the first and last statement of a replacement", () => {
  const code = `--# leading
local a, b = first(), second() --# trailing`;
  const { chunk, metadata: result } = metadata(code);
  const source = chunk.body[0];
  const original = source as Parser.LocalStatement;
  const replacements = original.init.map(
    (expression) =>
      ({ type: "CallStatement", expression }) as Parser.CallStatement,
  );
  result.replaceStatement(source, replacements);
  assert.deepEqual(
    result.beforeOf(replacements[0]).map((comment) => comment.raw),
    ["--# leading"],
  );
  assert.deepEqual(
    result.trailingOf(replacements[1]).map((comment) => comment.raw),
    ["--# trailing"],
  );
  assert.equal(result.trailingOf(replacements[0]).length, 0);
});
