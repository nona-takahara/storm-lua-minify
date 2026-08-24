import assert from "node:assert/strict";
import Parser from "luaparse";
import { describe, test } from "vitest";
import { MinifierMode } from "../src/minifier";
import { minifyTemporaryLuaProject } from "./lib/minifierHarness";

const MAIN = `
local dependency=require("dep")
local mainTable={left=1,right=2}
local mainLeft=mainTable.left
mainStep()
local mainRight=mainTable.right
local foldedMain=1+2
local unusedMain=99
screen.drawText(0,0,"a")
screen.drawText(0,0,"b")
screen.drawText(0,0,"c")
screen.drawText(0,0,"d")
screen.drawText(0,0,"e")
useMain(mainLeft,mainRight,foldedMain,dependency)
`;

const DEPENDENCY = `
local depTable={first=3,second=4}
local depFirst=depTable.first
depStep()
local depSecond=depTable.second
local foldedDep=2*3
local unusedDep=88
useDep(depFirst,depSecond,foldedDep)
return depFirst+depSecond
`;

function minify(
  moduleLikeLua: boolean,
  overrides: Partial<MinifierMode> = {},
): string {
  return minifyTemporaryLuaProject(
    { "main.lua": MAIN, "dep.lua": DEPENDENCY },
    {
      moduleLikeLua,
      runtimeProfile: "stormworks",
      ...overrides,
    },
    {
      outputFile: "pipeline.min.lua",
      prefix: "storm-effect-pipeline-test-",
    },
  ).code;
}

function assertValidAndNonGrowing(
  moduleLikeLua: boolean,
  pairwiseMode: Partial<MinifierMode> = {},
): void {
  const enabled = minify(moduleLikeLua, pairwiseMode);
  const disabled = minify(moduleLikeLua, {
    ...pairwiseMode,
    effectAwareTransforms: false,
  });

  assert.doesNotThrow(() => Parser.parse(enabled, { luaVersion: "5.3" }));
  assert.doesNotThrow(() => Parser.parse(disabled, { luaVersion: "5.3" }));
  assert.ok(
    Buffer.byteLength(enabled) <= Buffer.byteLength(disabled),
    `effect-aware output grew (${String(Buffer.byteLength(enabled))} > ${String(Buffer.byteLength(disabled))})`,
  );
  assert.match(enabled, /mainStep\(\)/);
  assert.match(enabled, /depStep\(\)/);
}

describe.each([false, true])(
  "effect-aware multi-module pipeline (moduleLikeLua=%s)",
  (moduleLikeLua) => {
    test("transforms candidates in both the entry and dependency modules", () => {
      assertValidAndNonGrowing(moduleLikeLua);
    });

    test.each([
      ["constant folding", { foldConstants: true }],
      ["global alias", { globalAlias: false }],
      ["local merge", { mergeLocals: false }],
      ["unused removal", { removeUnused: false }],
    ] as const)("composes pairwise with %s disabled", (_label, mode) => {
      assertValidAndNonGrowing(moduleLikeLua, mode);
    });
  },
);

test("SL require statement splicing remains protected from local hoisting", () => {
  const enabled = minify(false);
  const disabledHoist = minify(false, { effectAwareLocalHoist: false });

  assert.doesNotThrow(() => Parser.parse(enabled, { luaVersion: "5.3" }));
  assert.doesNotThrow(() => Parser.parse(disabledHoist, { luaVersion: "5.3" }));
  assert.doesNotMatch(enabled, /require\s*\(?["']dep["']/);
  assert.match(enabled, /depStep\(\)/);
  assert.match(enabled, /mainStep\(\)/);
});
