import fs from "fs";
import os from "os";
import path from "path";
import Parser from "luaparse";
import { afterEach, describe, expect, test } from "vitest";
import { Minifier } from "../src/minifier";
import {
  OptimizationDiagnosticCollector,
  summarizeOptimizationDiagnostics,
} from "../src/optimizerDiagnostics";
import { planNonAdjacentLocals } from "../src/nonAdjacentLocals";
import { resolveScopes } from "../src/resolver";
import { analyzeTableEffects } from "../src/tableEffects";
import { planTableReadMerges } from "../src/tableReadMerge";

const temporaryDirectories: string[] = [];

afterEach(() => {
  temporaryDirectories.splice(0).forEach((directory) => {
    fs.rmSync(directory, { recursive: true, force: true });
  });
});

describe("optimization diagnostics", () => {
  test("summarizes accepted and rejected planner decisions", () => {
    const source = "local t={x=1,y=2} local first=t.x tick() local second=t.y";
    const chunk = Parser.parse(source, { luaVersion: "5.3" });
    const resolved = resolveScopes(chunk);
    const collector = new OptimizationDiagnosticCollector();

    planTableReadMerges(chunk, analyzeTableEffects(chunk, resolved), {
      dirtyGranularity: "static-key",
      diagnostics: collector,
      moduleName: "main",
    });
    planNonAdjacentLocals(chunk, resolved, {
      outputNameLengthOf: () => 1,
      preserveRequireSplice: true,
      diagnostics: collector,
      moduleName: "main",
    });

    const summary = summarizeOptimizationDiagnostics(collector.diagnostics);
    expect(summary.acceptedCandidates).toBeGreaterThanOrEqual(2);
    expect(summary.rejectedCandidates).toBeGreaterThan(0);
    expect(summary.estimatedByteSavings).toBeGreaterThan(0);
    expect(summary.buckets.some((bucket) => bucket.moduleName === "main")).toBe(
      true,
    );
    expect(
      collector.diagnostics.every((item) => item.moduleName === "main"),
    ).toBe(true);
  });

  test("classifies rejection reasons across a reproducible fixture corpus", () => {
    const fixtures = [
      "local t={x=1,y=2} local a=t.x tick() local b=t.y use(a,b)",
      "local t={} local a=t[key] use(a)",
      "local t={x=1} consume(t) local a=t.x use(a)",
      "local a=1 tick() if ready then use(a) end local b=2 use(b)",
      "local first=1 tick() local second=2 use(first,second)",
    ];
    const diagnostics = fixtures.flatMap((source, index) => {
      const directory = fs.mkdtempSync(
        path.join(os.tmpdir(), `storm-diagnostics-corpus-${String(index)}-`),
      );
      temporaryDirectories.push(directory);
      const entry = path.join(directory, "main.lua");
      fs.writeFileSync(entry, source);
      const minifier = new Minifier(
        entry,
        { luaVersion: "5.3" },
        {
          moduleLikeLua: false,
          runtimeProfile: "stormworks",
          collectOptimizationDiagnostics: true,
        },
      );
      minifier.parse();
      return [...minifier.optimizationDiagnostics];
    });
    const reasons = new Set(diagnostics.map((item) => item.reason));
    (
      [
        "profitable-group",
        "dynamic-key",
        "call-escape",
        "control-flow-barrier",
        "nonpositive-cost",
      ] as const
    ).forEach((reason) => expect(reasons.has(reason)).toBe(true));
    expect(
      diagnostics.every(
        (item) =>
          item.moduleName === "main" &&
          item.runtimeProfile === "stormworks" &&
          item.sourceRange !== undefined,
      ),
    ).toBe(true);
    const summary = summarizeOptimizationDiagnostics(diagnostics);
    expect(
      summary.buckets.every((bucket) => bucket.runtimeProfile === "stormworks"),
    ).toBe(true);
    expect(JSON.parse(JSON.stringify(summary))).toEqual(summary);
  });

  test("collection does not change generated code or source map", () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "storm-optimizer-diagnostics-test-"),
    );
    temporaryDirectories.push(directory);
    const entry = path.join(directory, "main.lua");
    fs.writeFileSync(
      entry,
      "local t={x=1,y=2} local first=t.x tick() local second=t.y use(first,second)",
    );
    const create = (collectOptimizationDiagnostics: boolean) =>
      new Minifier(
        entry,
        { luaVersion: "5.3" },
        {
          moduleLikeLua: false,
          runtimeProfile: "stormworks",
          collectOptimizationDiagnostics,
        },
      );
    const disabled = create(false);
    const enabled = create(true);
    const disabledOutput = disabled
      .parse()
      .toStringWithSourceMap({ file: "main.min.lua" });
    const enabledOutput = enabled
      .parse()
      .toStringWithSourceMap({ file: "main.min.lua" });

    expect(enabledOutput.code).toBe(disabledOutput.code);
    expect(enabledOutput.map.toString()).toBe(disabledOutput.map.toString());
    expect(enabled.optimizationDiagnostics.length).toBeGreaterThan(0);
    expect(disabled.optimizationDiagnostics).toEqual([]);
  });
});
