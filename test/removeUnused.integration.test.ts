import { test } from "vitest";
import assert from "node:assert/strict";
import Parser from "luaparse";
import { SourceMapConsumer } from "source-map";
import { runMinifier } from "./lib/helpers";

test("stage 4 composes with require splicing, comments, rename, and local merging", async () => {
  const { code, map } = runMinifier({
    label: "unused stage 4 integration",
    fixture: "unused-stage4",
    mode: { moduleLikeLua: false },
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

test("removeUnused false disables all stage 4 transformations", () => {
  const { code } = runMinifier({
    label: "unused stage 4 disabled",
    fixture: "unused-stage4",
    mode: {
      moduleLikeLua: true,
      removeUnused: false,
      rename: false,
      mergeLocals: false,
      globalAlias: false,
    },
  });
  assert.match(
    code,
    /local\nunusedModule,unusedResult=require\("dep"\),sideEffect\(\)/,
  );
  assert.match(code, /local\nremovableName=1/);
  assert.match(code, /local\nretained,removable=produce\(\),2/);
});
