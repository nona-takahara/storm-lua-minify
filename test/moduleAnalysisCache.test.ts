import { describe, expect, test, vi, afterEach } from "vitest";
import Parser from "luaparse";
import { Minifier } from "../src/minifier";
import { PassOrchestrator } from "../src/optimizerPass";
import { WholeProgramObjectAnalysis } from "../src/wholeProgramObjects";
import { createTemporaryLuaProject } from "./lib/minifierHarness";
import * as optimizer from "../src/optimizerAnalysis";

// Exercise the compilation-local cache independently of cost-gate selection.
interface CacheOwner {
  link(): void;
  passesFor(name: string): PassOrchestrator;
  analyzeWholeProgramObjects(): WholeProgramObjectAnalysis;
  foldConstantsAll(names: readonly string[]): Set<string>;
  removeUnusedAll(names: readonly string[]): Set<string>;
  moduleChanged(name: string): void;
}
function project() {
  const { entryFilePath } = createTemporaryLuaProject({
    "main.lua": 'local dep=require("dep") local unused=1+2 return dep',
    "dep.lua": "return {value=1}",
  });
  const minifier = new Minifier(
    entryFilePath,
    { luaVersion: "5.3" },
    { constantOptimizations: true, runtimeProfile: "stormworks" },
  );
  const owner = minifier as unknown as CacheOwner;
  owner.link();
  return { minifier, owner };
}

function mainAnalysis(snapshot: WholeProgramObjectAnalysis) {
  const module = snapshot.modules.find((module) => module.name === "main");
  if (!module) throw new Error("Missing main module");
  return module.analysis;
}
function mainChunk(minifier: Minifier) {
  const chunk = minifier.moduleAST.get("main");
  if (!chunk) throw new Error("Missing main AST");
  return chunk;
}

afterEach(() => vi.restoreAllMocks());

describe("compilation-local module analysis cache", () => {
  test("reuses unchanged modules and the linked snapshot across readers", () => {
    const { owner } = project();
    const spy = vi.spyOn(optimizer, "analyzeOptimizer");
    const first = owner.analyzeWholeProgramObjects();
    expect(owner.analyzeWholeProgramObjects() === first).toBe(true);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(
      owner.passesFor("main").optimizerAnalysis() ===
        first.modules.find((module) => module.name === "main")?.analysis,
    ).toBe(true);
    owner.moduleChanged("main");
    const second = owner.analyzeWholeProgramObjects();
    expect(second === first).toBe(false);
    expect(second.generation).toBeGreaterThan(first.generation);
    expect(spy).toHaveBeenCalledTimes(3);
    expect(
      second.modules.find((module) => module.name === "dep")?.analysis ===
        first.modules.find((module) => module.name === "dep")?.analysis,
    ).toBe(true);
  });

  test("fold and DCE each expire the linked snapshot and old lazy reads", () => {
    const { owner } = project();
    const first = owner.analyzeWholeProgramObjects();
    const old = mainAnalysis(first);
    expect(owner.foldConstantsAll(["main"]).has("main")).toBe(true);
    expect(() => old.valueFlow).toThrow(/stale optimizer/);
    const folded = owner.analyzeWholeProgramObjects();
    expect(folded.generation).toBeGreaterThan(first.generation);
    const beforeDce = mainAnalysis(folded);
    expect(owner.removeUnusedAll(["main"]).has("main")).toBe(true);
    expect(() => beforeDce.statementDataflow).toThrow(/stale optimizer/);
    const removed = owner.analyzeWholeProgramObjects();
    expect(removed.generation).toBeGreaterThan(folded.generation);
  });

  test("bulk writes and scheduler-style binding-preserving writes share invalidation", () => {
    const { minifier, owner } = project();
    const first = owner.analyzeWholeProgramObjects();
    const old = mainAnalysis(first);
    mainChunk(minifier).body.push(Parser.parse("tick()").body[0]);
    owner.moduleChanged("main");
    expect(() => old.tableEffects).toThrow(/stale optimizer/);
    const second = owner.analyzeWholeProgramObjects();
    const current = mainAnalysis(second);
    owner.passesFor("main").run("scheduler-style-write", () => {
      mainChunk(minifier).body.push(Parser.parse("tick()").body[0]);
      return { changed: true, invalidatesResolve: false };
    });
    expect(() => current.valueFlow).toThrow(/stale optimizer/);
    expect(owner.analyzeWholeProgramObjects().generation).toBeGreaterThan(
      second.generation,
    );
  });
});
