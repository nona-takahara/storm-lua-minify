import Parser from "luaparse";
import { describe, expect, test } from "vitest";
import {
  OptimizationDiagnosticCollector,
  summarizeOptimizationDiagnostics,
} from "../src/optimizerDiagnostics";
import { resolveScopes } from "../src/resolver";
import { analyzeOptimizer } from "../src/optimizerAnalysis";
import { planStatementSchedule } from "../src/statementScheduler";
import {
  createTemporaryLuaProject,
  minifyLuaProject,
  minifyTemporaryLuaSource,
} from "./lib/minifierHarness";

describe("optimization diagnostics", () => {
  test("summarizes accepted and rejected planner decisions", () => {
    const source = "local t={x=1,y=2} local first=t.x tick() local second=t.y";
    const chunk = Parser.parse(source, { luaVersion: "5.3" });
    const resolved = resolveScopes(chunk);
    const collector = new OptimizationDiagnosticCollector();

    const analysis = analyzeOptimizer(chunk, resolved);
    planStatementSchedule(chunk, resolved, {
      facts: analysis.facts,
      dataflow: analysis.statementDataflow,
      outputNameLengthOf: () => 1,
      preserveRequireSplice: false,
      enableLocalPacking: true,
      enableLexicalLocalMerge: true,
      tableEffects: analysis.tableEffects,
      dirtyGranularity: "static-key",
      diagnostics: collector,
      moduleName: "main",
    });
    const rejectedChunk = Parser.parse("local u={} local bad=u[key]", {
      luaVersion: "5.3",
    });
    const rejectedResolved = resolveScopes(rejectedChunk);
    const rejectedAnalysis = analyzeOptimizer(rejectedChunk, rejectedResolved);
    planStatementSchedule(rejectedChunk, rejectedResolved, {
      facts: rejectedAnalysis.facts,
      dataflow: rejectedAnalysis.statementDataflow,
      outputNameLengthOf: () => 1,
      preserveRequireSplice: false,
      enableLocalPacking: true,
      enableLexicalLocalMerge: true,
      tableEffects: rejectedAnalysis.tableEffects,
      dirtyGranularity: "static-key",
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
      "local function factory() return {x=1,y=2} end local t=factory() local a=t.x tick() local b=t.y use(a,b)",
    ];
    const diagnostics = fixtures.flatMap((source, index) => {
      const { minifier } = minifyTemporaryLuaSource(
        source,
        {
          requireWrapper: false,
          runtimeProfile: "stormworks",
          collectOptimizationDiagnostics: true,
        },
        {
          luaParseSettings: { luaVersion: "5.3" },
          prefix: `storm-diagnostics-corpus-${String(index)}-`,
        },
      );
      return [...minifier.optimizationDiagnostics];
    });
    const { minifier: luaMinifier } = minifyTemporaryLuaSource(
      fixtures[0],
      {
        requireWrapper: false,
        runtimeProfile: "lua53",
        allowIntrospectionChanges: true,
        collectOptimizationDiagnostics: true,
      },
      {
        luaParseSettings: { luaVersion: "5.3" },
        prefix: "storm-diagnostics-corpus-lua53-",
      },
    );
    diagnostics.push(...luaMinifier.optimizationDiagnostics);
    const reasons = new Set(diagnostics.map((item) => item.reason));
    (
      [
        "profitable-group",
        "dynamic-key",
        "call-escape",
        "resolved-call-target",
        "unknown-call-target",
      ] as const
    ).forEach((reason) => {
      expect(reasons.has(reason)).toBe(true);
    });
    expect(
      diagnostics.every(
        (item) =>
          item.moduleName === "main" &&
          item.runtimeProfile !== undefined &&
          item.sourceRange !== undefined,
      ),
    ).toBe(true);
    const summary = summarizeOptimizationDiagnostics(diagnostics);
    expect(
      new Set(summary.buckets.map((bucket) => bucket.runtimeProfile)),
    ).toEqual(new Set(["stormworks", "lua53"]));
    expect(JSON.parse(JSON.stringify(summary))).toEqual(summary);
  });

  test("collection does not change generated code or source map", () => {
    const source =
      "local t={x=1,y=2} local first=t.x tick() local second=t.y use(first,second)";
    const project = createTemporaryLuaProject(
      { "main.lua": source },
      { prefix: "storm-optimizer-diagnostics-test-" },
    );
    const create = (collectOptimizationDiagnostics: boolean) =>
      minifyLuaProject(
        project,
        {
          requireWrapper: false,
          runtimeProfile: "stormworks",
          collectOptimizationDiagnostics,
        },
        { luaParseSettings: { luaVersion: "5.3" } },
      );
    const disabled = create(false);
    const enabled = create(true);

    expect(enabled.code).toBe(disabled.code);
    expect(enabled.map).toEqual(disabled.map);
    expect(enabled.minifier.optimizationDiagnostics.length).toBeGreaterThan(0);
    expect(disabled.minifier.optimizationDiagnostics).toEqual([]);
  });
});
