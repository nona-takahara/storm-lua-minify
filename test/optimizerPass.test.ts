import Parser from "luaparse";
import { describe, expect, test } from "vitest";
import { PassOrchestrator, UNCHANGED } from "../src/optimizerPass";
import { resolveScopes } from "../src/resolver";
import {
  analyzeOptimizerAtGeneration,
  OPTIMIZER_ANALYSIS_CACHE_KEY,
} from "../src/optimizerAnalysis";

describe("optimizer pass orchestrator", () => {
  test("re-resolves immediately after an invalidating transform", () => {
    const chunk = Parser.parse("local before=1 use(before)", {
      luaVersion: "5.3",
    });
    const orchestrator = new PassOrchestrator(chunk, resolveScopes(chunk));
    const original = orchestrator.resolved;

    orchestrator.run("insert-local", () => {
      chunk.body.unshift(
        Parser.parse("local inserted=2", { luaVersion: "5.3" }).body[0],
      );
      return { changed: true, invalidatesResolve: true };
    });

    expect(orchestrator.resolved).not.toBe(original);
    expect(orchestrator.astGeneration).toBe(1);
    expect(orchestrator.resolveGeneration).toBe(1);
    expect(orchestrator.resolved.symbols.map((symbol) => symbol.name)).toEqual([
      "inserted",
      "before",
    ]);
    expect(orchestrator.records).toEqual([
      {
        name: "insert-local",
        changed: true,
        invalidatesResolve: true,
        astGenerationBefore: 0,
        astGenerationAfter: 1,
        resolveGenerationBefore: 0,
        resolveGenerationAfter: 1,
      },
    ]);
  });

  test("keeps the analysis generation for a read-only pass", () => {
    const chunk = Parser.parse("return 1", { luaVersion: "5.3" });
    const orchestrator = new PassOrchestrator(chunk, resolveScopes(chunk));

    orchestrator.run("inspect", () => UNCHANGED);

    expect(orchestrator.resolveGeneration).toBe(0);
    expect(orchestrator.astGeneration).toBe(0);
    expect(orchestrator.records[0]).toMatchObject({
      changed: false,
      resolveGenerationBefore: 0,
      resolveGenerationAfter: 0,
    });
  });

  test("rejects an inconsistent invalidation result", () => {
    const chunk = Parser.parse("return 1", { luaVersion: "5.3" });
    const orchestrator = new PassOrchestrator(chunk, resolveScopes(chunk));

    expect(() =>
      orchestrator.run("invalid", () => ({
        changed: false,
        invalidatesResolve: true,
      })),
    ).toThrow(/cannot invalidate Resolve/);
  });

  test("caches facts within an AST generation and drops them after any change", () => {
    const chunk = Parser.parse("local value=1", { luaVersion: "5.3" });
    const orchestrator = new PassOrchestrator(chunk, resolveScopes(chunk));
    const key = {};
    const built: number[] = [];
    const analyze = (
      _chunk: Parser.Chunk,
      _resolved: unknown,
      generation: number,
    ) => {
      built.push(generation);
      return { generation };
    };

    const first = orchestrator.analysis(key, analyze);
    expect(orchestrator.analysis(key, analyze)).toBe(first);
    orchestrator.run("rewrite-without-binding-change", () => ({
      changed: true,
      invalidatesResolve: false,
    }));
    const second = orchestrator.analysis(key, analyze);

    expect(second).not.toBe(first);
    expect(built).toEqual([0, 1]);
    expect(orchestrator.astGeneration).toBe(1);
    expect(orchestrator.resolveGeneration).toBe(0);
  });

  test("rejects an analysis built for another AST generation", () => {
    const chunk = Parser.parse("return 1", { luaVersion: "5.3" });
    const orchestrator = new PassOrchestrator(chunk, resolveScopes(chunk));

    expect(() => orchestrator.analysis({}, () => ({ generation: 99 }))).toThrow(
      /stale AST generation/,
    );
  });

  test("invalidates call graph and function summaries with the AST generation", () => {
    const chunk = Parser.parse(
      "local function value() return 1 end local result=value()",
      { luaVersion: "5.3" },
    );
    const orchestrator = new PassOrchestrator(chunk, resolveScopes(chunk));
    const first = orchestrator.analysis(
      OPTIMIZER_ANALYSIS_CACHE_KEY,
      analyzeOptimizerAtGeneration,
    );
    const declaration = chunk.body[0] as Parser.FunctionDeclaration;
    const returned = (declaration.body[0] as Parser.ReturnStatement)
      .arguments[0] as Parser.NumericLiteral;
    returned.value = 2;
    returned.raw = "2";
    orchestrator.run("change-return-value", () => ({
      changed: true,
      invalidatesResolve: false,
    }));
    const second = orchestrator.analysis(
      OPTIMIZER_ANALYSIS_CACHE_KEY,
      analyzeOptimizerAtGeneration,
    );

    expect(second).not.toBe(first);
    expect(second.interprocedural.generation).toBe(1);
    expect(
      second.interprocedural.summaries[0].returns.prefix[0].atoms,
    ).toContainEqual({ kind: "number", raw: "2" });
  });
});
