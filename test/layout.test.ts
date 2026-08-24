import { test } from "vitest";
import assert from "node:assert/strict";
import Parser from "luaparse";
import { runMinifier } from "./lib/helpers";

test("必須空白は既定でLFになり、半角スペースへ切り替えても出力サイズは変わらない", () => {
  const lineFeed = runMinifier({
    label: "required whitespace LF",
    fixture: "single-file",
    mode: { moduleLikeLua: false },
  }).code;
  const space = runMinifier({
    label: "required whitespace space",
    fixture: "single-file",
    mode: { moduleLikeLua: false, requiredWhitespace: " " },
  }).code;

  assert.match(lineFeed, /local\nfunction/);
  assert.match(space, /local function/);
  assert.equal(Buffer.byteLength(lineFeed), Buffer.byteLength(space));
  assert.doesNotThrow(() => Parser.parse(lineFeed, { luaVersion: "5.3" }));
  assert.doesNotThrow(() => Parser.parse(space, { luaVersion: "5.3" }));
});

test("AST化したrequireラッパーにも同じ必須空白ポリシーを適用する", () => {
  const lineFeed = runMinifier({
    label: "require wrapper LF",
    fixture: "require-call",
    mode: { moduleLikeLua: true },
  }).code;
  const space = runMinifier({
    label: "require wrapper space",
    fixture: "require-call",
    mode: { moduleLikeLua: true, requiredWhitespace: " " },
  }).code;

  assert.match(lineFeed, /^function\nrequire\(m,r\)/);
  assert.match(space, /^function require\(m,r\)/);
  assert.equal(Buffer.byteLength(lineFeed), Buffer.byteLength(space));
  assert.doesNotThrow(() => Parser.parse(lineFeed, { luaVersion: "5.3" }));
  assert.doesNotThrow(() => Parser.parse(space, { luaVersion: "5.3" }));
});
