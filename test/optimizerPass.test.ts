import Parser from "luaparse";
import { describe, expect, test } from "vitest";
import { PassOrchestrator, UNCHANGED } from "../src/optimizerPass";
import { resolveScopes } from "../src/resolver";

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
});
