import Parser from "luaparse";
import { afterEach, describe, expect, test, vi } from "vitest";
import { analyzeOptimizer } from "../src/optimizerAnalysis";
import { PassOrchestrator } from "../src/optimizerPass";
import { resolveScopes } from "../src/resolver";
import { runtimeEnvironmentOf } from "../src/runtimeEnvironment";
import {
  analyzeOptimizerFactsAtGeneration,
  OPTIMIZER_FACTS_CACHE_KEY,
} from "../src/optimizerFacts";
import * as values from "../src/valueFlow";
import * as tables from "../src/tableEffects";
import * as statements from "../src/statementDataflow";
import * as cfg from "../src/controlFlow";
import * as liveness from "../src/symbolLiveness";

function fixture() {
  const chunk = Parser.parse("local t={x=1} local a=t.x use(a)", {
    luaVersion: "5.3",
  });
  return { chunk, passes: new PassOrchestrator(chunk, resolveScopes(chunk)) };
}

afterEach(() => vi.restoreAllMocks());

describe("lazy optimizer snapshots", () => {
  test("summary-only readers build none of the heavy analyses", () => {
    const flow = vi.spyOn(values, "analyzeValueFlow");
    const effects = vi.spyOn(tables, "analyzeTableEffects");
    const dataflow = vi.spyOn(statements, "analyzeStatementDataflow");
    const control = vi.spyOn(cfg, "analyzeControlFlow");
    const live = vi.spyOn(liveness, "analyzeSymbolLiveness");
    const { passes } = fixture();
    const analysis = passes.optimizerAnalysis();
    expect(analysis.callGraph.calls).toHaveLength(1);
    expect(analysis.interprocedural.generation).toBe(0);
    for (const spy of [flow, effects, dataflow, control, live])
      expect(spy).toHaveBeenCalledTimes(0);
  });

  test("liveness-only readers skip value flow and statement dependencies", () => {
    const flow = vi.spyOn(values, "analyzeValueFlow");
    const effects = vi.spyOn(tables, "analyzeTableEffects");
    const dataflow = vi.spyOn(statements, "analyzeStatementDataflow");
    const { passes } = fixture();
    const analysis = passes.optimizerAnalysis();
    expect(analysis.symbolLiveness.controlFlow === analysis.controlFlow).toBe(
      true,
    );
    for (const spy of [flow, effects, dataflow])
      expect(spy).toHaveBeenCalledTimes(0);
  });

  test("dependent getters share one CFG, value flow and liveness", () => {
    const spies = [
      vi.spyOn(values, "analyzeValueFlow"),
      vi.spyOn(tables, "analyzeTableEffects"),
      vi.spyOn(statements, "analyzeStatementDataflow"),
      vi.spyOn(cfg, "analyzeControlFlow"),
      vi.spyOn(liveness, "analyzeSymbolLiveness"),
    ];
    const { passes } = fixture();
    const analysis = passes.optimizerAnalysis();
    expect(analysis.tableEffects === analysis.tableEffects).toBe(true);
    expect(analysis.statementDataflow === analysis.statementDataflow).toBe(
      true,
    );
    expect(analysis.valueFlow.controlFlow === analysis.controlFlow).toBe(true);
    expect(
      analysis.statementDataflow.symbolLiveness === analysis.symbolLiveness,
    ).toBe(true);
    for (const spy of spies) expect(spy).toHaveBeenCalledTimes(1);
  });

  test("first lazy access after a binding-preserving write rejects the old snapshot", () => {
    const { chunk, passes } = fixture();
    const before = passes.optimizerAnalysis();
    passes.run("append-call", () => {
      chunk.body.push(Parser.parse("use(2)").body[0]);
      return { changed: true, invalidatesResolve: false };
    });
    const flow = vi.spyOn(values, "analyzeValueFlow");
    for (const read of [
      () => before.valueFlow,
      () => before.tableEffects,
      () => before.statementDataflow,
      () => before.controlFlow,
      () => before.symbolLiveness,
    ])
      expect(read).toThrow(/stale optimizer/);
    expect(flow).toHaveBeenCalledTimes(0);
    expect(passes.optimizerAnalysis().valueFlow.version).toBe(1);
  });

  test("materialized getters also reject after Resolve invalidation", () => {
    const { chunk, passes } = fixture();
    const before = passes.optimizerAnalysis();
    const materialized = before.statementDataflow;
    passes.run("insert-local", () => {
      chunk.body.unshift(Parser.parse("local extra=1").body[0]);
      return { changed: true, invalidatesResolve: true };
    });
    expect(() => before.statementDataflow).toThrow(/stale optimizer/);
    expect(passes.optimizerAnalysis().statementDataflow === materialized).toBe(
      false,
    );
  });

  test("a throwing transform expires its read snapshot", () => {
    const { passes } = fixture();
    const before = passes.optimizerAnalysis();
    expect(() =>
      passes.run("failed", () => {
        throw new Error("failed");
      }),
    ).toThrow("failed");
    expect(() => before.valueFlow).toThrow(/stale optimizer/);
  });

  test("standalone snapshot owners can end the read lifetime", () => {
    const { chunk } = fixture();
    const analysis = analyzeOptimizer(chunk, resolveScopes(chunk));
    analysis.invalidate();
    expect(() => analysis.valueFlow).toThrow(/stale optimizer/);
  });

  test("shares default facts across pass families and isolates runtime and assumption policies", () => {
    const { passes } = fixture();
    const facts = passes.analysis(
      OPTIMIZER_FACTS_CACHE_KEY,
      analyzeOptimizerFactsAtGeneration,
    );
    expect(passes.optimizerAnalysis().facts === facts).toBe(true);
    const runtimePolicy = Object.freeze({
      runtime: runtimeEnvironmentOf("stormworks"),
    });
    const assumptionPolicy = Object.freeze({
      ...runtimePolicy,
      assumptions: new Map([["test", "explicit test assumption"]]),
    });
    const summaryPolicy = Object.freeze({
      ...runtimePolicy,
      interprocedural: { externalContracts: new Map() },
    });
    const first = passes.optimizerAnalysis(runtimePolicy);
    expect(passes.optimizerAnalysis(runtimePolicy) === first).toBe(true);
    expect(first.facts === facts).toBe(false);
    expect(
      passes
        .optimizerAnalysis(assumptionPolicy)
        .facts.policy.assumptions.get("test"),
    ).toBe("explicit test assumption");
    expect(passes.optimizerAnalysis(summaryPolicy) === first).toBe(false);
    passes.run("read-only", () => ({
      changed: false,
      invalidatesResolve: false,
    }));
    expect(passes.optimizerAnalysis(runtimePolicy) === first).toBe(true);
  });
});
