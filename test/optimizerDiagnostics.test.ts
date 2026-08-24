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
    expect(
      collector.diagnostics.every((item) => item.moduleName === "main"),
    ).toBe(true);
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
