import { test } from "vitest";
import assert from "node:assert/strict";
import Parser from "luaparse";
import { SourceMapConsumer } from "source-map";
import { runMinifier } from "./lib/helpers";
import { minifyTemporaryLuaSource } from "./lib/minifierHarness";

test("stage 4 composes with require splicing, comments, rename, and local merging", async () => {
  const { code, map } = runMinifier({
    label: "unused stage 4 integration",
    fixture: "unused-stage4",
    mode: { requireWrapper: false },
  });

  assert.doesNotThrow(() => Parser.parse(code, { luaVersion: "5.3" }));
  assert.match(code, /--# before effects\ndependencyEffect\(\)/);
  assert.match(code, /sideEffect\(\)\n--# after effects/);
  assert.doesNotMatch(code, /removableName|removable/);
  assert.match(code, /local\n[a-zA-Z_]=produce\(\)/);

  const generatedIndex = code.indexOf("sideEffect");
  assert.notEqual(generatedIndex, -1);
  await SourceMapConsumer.with(map, null, (consumer) => {
    const original = consumer.originalPositionFor({
      line: code.slice(0, generatedIndex).split("\n").length,
      column: generatedIndex - (code.lastIndexOf("\n", generatedIndex) + 1),
    });
    assert.equal(original.source, "main.lua");
    assert.equal(original.line, 2);
    assert.equal(original.name, "sideEffect");

    const retainedIndex = code.indexOf("=produce") - 1;
    const retained = consumer.originalPositionFor({
      line: code.slice(0, retainedIndex).split("\n").length,
      column: retainedIndex - (code.lastIndexOf("\n", retainedIndex) + 1),
    });
    assert.equal(retained.source, "main.lua");
    assert.equal(retained.line, 7);
    assert.equal(retained.name, "retained");
  });
});

test("unusedCodeRemoval false disables all stage 4 transformations", () => {
  const { code } = runMinifier({
    label: "unused stage 4 disabled",
    fixture: "unused-stage4",
    mode: {
      requireWrapper: true,
      unusedCodeRemoval: false,
      identifierOptimizations: false,
      localDeclarationMerging: false,
      globalAliasing: false,
    },
  });
  assert.match(
    code,
    /local\nunusedModule,unusedResult=require\("dep"\),sideEffect\(\)/,
  );
  assert.match(code, /local\nremovableName=1/);
  assert.match(code, /local\nretained,removable=produce\(\),2/);
});

test("unused local and unused function removal can be selected independently", () => {
  const source =
    "local function unusedFunction()end local unusedValue=1 return 2";
  const functionOnly = minifyTemporaryLuaSource(source, {
    requireWrapper: false,
    identifierOptimizations: false,
    unusedLocalRemoval: false,
    unusedFunctionRemoval: true,
  }).code;
  const localOnly = minifyTemporaryLuaSource(source, {
    requireWrapper: false,
    identifierOptimizations: false,
    unusedLocalRemoval: true,
    unusedFunctionRemoval: false,
  }).code;

  assert.doesNotMatch(functionOnly, /unusedFunction/);
  assert.match(functionOnly, /unusedValue=1/);
  assert.match(localOnly, /unusedFunction/);
  assert.doesNotMatch(localOnly, /unusedValue/);
});
