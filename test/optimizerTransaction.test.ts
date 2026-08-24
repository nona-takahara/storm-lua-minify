import { describe, expect, test } from "vitest";
import { selectTransactionalMinifierVariant } from "../src/optimizerTransaction";
import {
  createTemporaryLuaProject,
  minifyTemporaryLuaSource,
} from "./lib/minifierHarness";

function fixture(source: string): string {
  return createTemporaryLuaProject(
    { "main.lua": source },
    { prefix: "storm-optimizer-transaction-" },
  ).entryFilePath;
}

describe("transactional final-output selection", () => {
  test("normal Minifier path selects scheduler output only after final print", () => {
    const source =
      "local first=makeFirst() if flag then tick() end local second=makeSecond() use(first,second)";
    const selected = minifyTemporaryLuaSource(
      source,
      {
        moduleLikeLua: false,
        runtimeProfile: "stormworks",
        collectOptimizationDiagnostics: true,
      },
      { prefix: "storm-normal-final-cost-" },
    );
    const baseline = minifyTemporaryLuaSource(
      source,
      {
        moduleLikeLua: false,
        runtimeProfile: "stormworks",
        mergeLocals: false,
        effectAwareTransforms: false,
      },
      { prefix: "storm-normal-final-cost-baseline-" },
    );

    expect(Buffer.byteLength(selected.code)).toBeLessThan(
      Buffer.byteLength(baseline.code),
    );
    expect(selected.minifier.moduleAST.size).toBeGreaterThan(0);
    expect(selected.minifier.moduleSourceText.size).toBeGreaterThan(0);
    expect(selected.minifier.optimizationDiagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          pass: "statement-scheduler-final-cost",
          decision: "accepted",
          reason: "final-output-shorter",
        }),
      ]),
    );
  });

  test("normal Minifier path keeps baseline when final output is not shorter", () => {
    const source = "return value";
    const selected = minifyTemporaryLuaSource(
      source,
      {
        moduleLikeLua: false,
        collectOptimizationDiagnostics: true,
      },
      { prefix: "storm-normal-final-cost-equal-" },
    );
    const baseline = minifyTemporaryLuaSource(
      source,
      {
        moduleLikeLua: false,
        mergeLocals: false,
        effectAwareTransforms: false,
      },
      { prefix: "storm-normal-final-cost-equal-baseline-" },
    );

    expect(selected.code).toBe(baseline.code);
    expect(selected.minifier.optimizationDiagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          pass: "statement-scheduler-final-cost",
          decision: "rejected",
          reason: "final-output-not-shorter",
        }),
      ]),
    );
  });

  test("selects a strictly shorter effect-aware final artifact", () => {
    const entryFilePath = fixture(`
local t={x=1,y=2}
local first=t.x
tick()
local second=t.y
use(first,second)
`);
    const result = selectTransactionalMinifierVariant({
      entryFilePath,
      luaParseSettings: { luaVersion: "5.3" },
      baselineMode: {
        moduleLikeLua: false,
        runtimeProfile: "stormworks",
        effectAwareTransforms: false,
      },
      trialMode: {
        moduleLikeLua: false,
        runtimeProfile: "stormworks",
      },
    });
    expect(result.accepted).toBe(true);
    expect(result.byteSavings).toBeGreaterThan(0);
    expect(result.selected).toEqual(result.trial);
  });

  test("keeps baseline and its source map when trial is not shorter", () => {
    const entryFilePath = fixture(
      "--# preserved\nlocal descriptive=1 return descriptive",
    );
    const result = selectTransactionalMinifierVariant({
      entryFilePath,
      luaParseSettings: { luaVersion: "5.3" },
      baselineMode: { moduleLikeLua: false, rename: true },
      trialMode: { moduleLikeLua: false, rename: false },
    });
    expect(result).toMatchObject({ accepted: false, reason: "not-shorter" });
    expect(result.selected).toEqual(result.baseline);
    expect(result.selected.code).toContain("--# preserved");
    const sourceMap = JSON.parse(result.selected.sourceMap) as {
      sources: unknown;
    };
    expect(sourceMap.sources).toContain("main.lua");
  });

  test("remains deterministic across modules", () => {
    const { entryFilePath } = createTemporaryLuaProject(
      {
        "main.lua": 'local child=require("child") return child',
        "child.lua": "local value=1 return value",
      },
      { prefix: "storm-optimizer-transaction-" },
    );
    const request = {
      entryFilePath,
      luaParseSettings: { luaVersion: "5.3" as const },
      baselineMode: { moduleLikeLua: true },
      trialMode: { moduleLikeLua: true },
    };
    const first = selectTransactionalMinifierVariant(request);
    const second = selectTransactionalMinifierVariant(request);
    expect(first).toEqual(second);
    expect(first).toMatchObject({ accepted: false, reason: "not-shorter" });
  });

  test("isolates a trial failure from the selected baseline", () => {
    const entryFilePath = fixture("local value=1 return value");
    const failingReservedNames = {
      [Symbol.iterator](): Iterator<string> {
        throw new Error("trial-only failure");
      },
    } as ReadonlySet<string>;
    const result = selectTransactionalMinifierVariant({
      entryFilePath,
      luaParseSettings: { luaVersion: "5.3" },
      baselineMode: { moduleLikeLua: false },
      trialMode: {
        moduleLikeLua: false,
        neverRenameGlobals: failingReservedNames,
      },
    });
    expect(result).toMatchObject({ accepted: false, reason: "trial-failed" });
    expect(result.selected).toEqual(result.baseline);
  });
});
