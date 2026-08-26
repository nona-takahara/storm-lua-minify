import { describe, expect, test } from "vitest";
import { SourceMapConsumer } from "source-map";
import { minifyTemporaryLuaSource } from "./lib/minifierHarness";

describe("function rewrites integration", () => {
  test("prunes a trailing unused parameter but leaves surplus actual evaluation", () => {
    const source = `
local function first(value,unused) return value end
return first(1,sideEffect())
`;
    const optimized = minifyTemporaryLuaSource(source, {
      moduleLikeLua: false,
      runtimeProfile: "stormworks",
      mergeLocals: false,
    }).code;
    const baseline = minifyTemporaryLuaSource(source, {
      moduleLikeLua: false,
      runtimeProfile: "stormworks",
      mergeLocals: false,
      effectAwareTransforms: false,
    }).code;

    expect(optimized).toContain("sideEffect()");
    expect(Buffer.byteLength(optimized)).toBeLessThan(
      Buffer.byteLength(baseline),
    );
  });

  test("preserves parameter declarations under Lua debug introspection", () => {
    const source =
      "local function first(value,unused)return value end return first(1,2)";
    const preserved = minifyTemporaryLuaSource(source, {
      moduleLikeLua: false,
      runtimeProfile: "lua53",
      mergeLocals: false,
      effectAwareLocalHoist: false,
      effectAwareTableReads: false,
    }).code;
    const allowed = minifyTemporaryLuaSource(source, {
      moduleLikeLua: false,
      runtimeProfile: "lua53",
      allowLocalLifetimeChanges: true,
      mergeLocals: false,
      effectAwareLocalHoist: false,
      effectAwareTableReads: false,
    }).code;

    expect(allowed.length).toBeLessThan(preserved.length);
  });

  test("gates aggregate variants on Lua local-lifetime permission", () => {
    const source =
      "local function choose(enabled,value)if enabled then return value end return 0 end return choose(true,1)+choose(true,2)+choose(true,3)";
    const preserved = minifyTemporaryLuaSource(source, {
      moduleLikeLua: false,
      runtimeProfile: "lua53",
      collectOptimizationDiagnostics: true,
    });
    const allowed = minifyTemporaryLuaSource(source, {
      moduleLikeLua: false,
      runtimeProfile: "lua53",
      allowLocalLifetimeChanges: true,
      collectOptimizationDiagnostics: true,
    });
    expect(
      preserved.minifier.optimizationDiagnostics.some(
        (diagnostic) => diagnostic.pass === "aggregate-function-specialization",
      ),
    ).toBe(false);
    expect(allowed.minifier.optimizationDiagnostics).toContainEqual(
      expect.objectContaining({
        pass: "aggregate-function-specialization",
        reason: "variant-created",
      }),
    );
  });

  test("inlines a closed single-use function and removes its declaration", () => {
    const source =
      "local function compute()return external()+1 end return compute()";
    const optimized = minifyTemporaryLuaSource(source, {
      moduleLikeLua: false,
      runtimeProfile: "stormworks",
      mergeLocals: false,
    }).code;

    expect(optimized).toContain("external()+1");
    expect(optimized).not.toContain("function");
  });

  test("splices a multi-statement closed body and removes the call frame", () => {
    const source =
      "local function run() first() globalValue=second() end run()";
    const optimized = minifyTemporaryLuaSource(source, {
      moduleLikeLua: false,
      runtimeProfile: "stormworks",
      mergeLocals: false,
    }).code;

    expect(optimized).toContain("first()globalValue=second()");
    expect(optimized).not.toContain("function");
  });

  test("specializes literal arguments before later optimization", () => {
    const source =
      "local function add(value,amount)return value+amount end return add(40,2)";
    const optimized = minifyTemporaryLuaSource(source, {
      moduleLikeLua: false,
      runtimeProfile: "stormworks",
      mergeLocals: false,
      foldConstants: true,
    }).code;

    expect(optimized).not.toContain("function");
    expect(optimized).toContain("42");
  });

  test("preserves arbitrary actual evaluation through a parameter binding", () => {
    const source =
      "local function run(first,second)local sum=first+second publish(sum)end run(makeFirst(),makeSecond())";
    const optimized = minifyTemporaryLuaSource(source, {
      moduleLikeLua: false,
      runtimeProfile: "stormworks",
      mergeLocals: false,
    }).code;

    expect(optimized.indexOf("makeFirst()")).toBeLessThan(
      optimized.indexOf("makeSecond()"),
    );
    expect(optimized).not.toContain("function");
    expect(optimized).toContain("publish");
  });

  test("preserves a multi-statement return tuple in tail position", () => {
    const source =
      "local function pair(value)local next=value+1 if flag then return value,next end return next,value end return pair(make())";
    const optimized = minifyTemporaryLuaSource(source, {
      moduleLikeLua: false,
      runtimeProfile: "stormworks",
      mergeLocals: false,
    }).code;

    expect(optimized).not.toContain("function");
    expect(optimized).toContain("return");
    expect(optimized).toContain("make()");
  });

  test("deletes unreachable local functions through the shared unused pass", () => {
    const source = "local function unreachable() publish() end return 1";
    const result = minifyTemporaryLuaSource(source, {
      moduleLikeLua: false,
      runtimeProfile: "stormworks",
      collectOptimizationDiagnostics: true,
    });

    expect(result.code).not.toContain("function");
    expect(result.minifier.optimizationDiagnostics).toContainEqual(
      expect.objectContaining({
        pass: "function-dce",
        decision: "accepted",
        reason: "unused-function",
      }),
    );
  });

  test("sends multi-use functions to aggregate specialization while reporting hard refusals", () => {
    const source = `
local function recursive(value) if value then return recursive(false) end end
local function escaping(value) return value end
consume(escaping)
local function shared(value) return value end
publish(shared(1),shared(1))
local function variadic(...) return ... end
return recursive(true),variadic(1)
`;
    const result = minifyTemporaryLuaSource(source, {
      moduleLikeLua: false,
      runtimeProfile: "stormworks",
      collectOptimizationDiagnostics: true,
    });
    const reasons = result.minifier.optimizationDiagnostics
      .filter((diagnostic) => diagnostic.pass === "function-rewrite")
      .map((diagnostic) => diagnostic.reason);

    expect(reasons).toEqual(
      expect.arrayContaining([
        "recursive-function",
        "function-escape",
        "vararg-function",
      ]),
    );
    expect(result.minifier.optimizationDiagnostics).toContainEqual(
      expect.objectContaining({
        pass: "aggregate-function-specialization",
        decision: "accepted",
        reason: "variant-created",
      }),
    );
  });

  test("maps an inlined expression to its function-body origin", async () => {
    const source = [
      "local function compute()",
      "  return external()+1",
      "end",
      "return compute()",
    ].join("\n");
    const result = minifyTemporaryLuaSource(source, {
      moduleLikeLua: false,
      runtimeProfile: "stormworks",
      mergeLocals: false,
    });
    const offset = result.code.indexOf("external");
    expect(offset).toBeGreaterThanOrEqual(0);
    const before = result.code.slice(0, offset).split("\n");
    const generated = {
      line: before.length,
      column: before.at(-1)?.length ?? 0,
    };

    await SourceMapConsumer.with(result.map, null, (consumer) => {
      const origin = consumer.originalPositionFor(generated);
      expect(origin.source).toBe("main.lua");
      expect(origin.line).toBe(2);
      expect(origin.name).toBe("external");
    });
  });

  test("gates function rewrites separately at final output", () => {
    const result = minifyTemporaryLuaSource(
      "local function run(value)publish(value)end run(make())",
      {
        moduleLikeLua: false,
        runtimeProfile: "stormworks",
        mergeLocals: false,
        collectOptimizationDiagnostics: true,
      },
    );
    expect(
      result.minifier.optimizationDiagnostics.some(
        (diagnostic) => diagnostic.pass === "function-rewrite-final-cost",
      ),
    ).toBe(true);
  });

  test("specializes a profitable value group across multiple call sites", () => {
    const source = `
local function choose(enabled,value,fallback)
  if enabled then return value end
  return fallback
end
return choose(true,1,9)+choose(true,2,9)+choose(true,3,9)+choose(true,4,9)
`;
    const result = minifyTemporaryLuaSource(source, {
      moduleLikeLua: false,
      runtimeProfile: "stormworks",
      mergeLocals: false,
      foldConstants: true,
      collectOptimizationDiagnostics: true,
    });
    expect(result.minifier.optimizationDiagnostics).toContainEqual(
      expect.objectContaining({
        pass: "aggregate-function-specialization",
        decision: "accepted",
        reason: "variant-created",
      }),
    );
    expect(result.minifier.optimizationDiagnostics).toContainEqual(
      expect.objectContaining({
        pass: "aggregate-specialization-final-cost",
        decision: "accepted",
        reason: "final-output-shorter",
      }),
    );
  });

  test("retains the original callable when an unspecialized call remains", () => {
    const source = `
local function choose(enabled,value)
  if enabled then return value end
  return 0
end
return choose(true,1)+choose(true,2)+choose(true,3)+choose(flag,4)
`;
    const result = minifyTemporaryLuaSource(source, {
      moduleLikeLua: false,
      runtimeProfile: "stormworks",
      mergeLocals: false,
      foldConstants: true,
      collectOptimizationDiagnostics: true,
    });
    expect(result.minifier.optimizationDiagnostics).toContainEqual(
      expect.objectContaining({
        pass: "aggregate-function-specialization",
        reason: "variant-created",
      }),
    );
    expect(result.code).toContain("function");
    expect(result.code).toContain("flag");
  });

  test("preserves a proven same-module capture binding", () => {
    const source = `
local captured=external()
local function choose(enabled,value)
  if enabled then return captured+value end
  return value
end
return choose(true,1)+choose(true,2)+choose(true,3)
`;
    const result = minifyTemporaryLuaSource(source, {
      moduleLikeLua: false,
      runtimeProfile: "stormworks",
      mergeLocals: false,
      collectOptimizationDiagnostics: true,
    });
    expect(result.minifier.optimizationDiagnostics).toContainEqual(
      expect.objectContaining({
        pass: "aggregate-function-specialization",
        decision: "accepted",
        reason: "variant-created",
      }),
    );
    expect(result.code.match(/external\(\)/g)).toHaveLength(1);
  });

  test("keeps callee and call-site provenance in a specialized variant", async () => {
    const source = [
      "local function choose(enabled)",
      "  if enabled then return external() end",
      "  return fallback()",
      "end",
      "return choose(true)+choose(true)+choose(true)",
    ].join("\n");
    const result = minifyTemporaryLuaSource(source, {
      moduleLikeLua: false,
      runtimeProfile: "stormworks",
      mergeLocals: false,
      collectOptimizationDiagnostics: true,
    });
    const offset = result.code.indexOf("external");
    expect(offset).toBeGreaterThanOrEqual(0);
    const before = result.code.slice(0, offset).split("\n");
    await SourceMapConsumer.with(result.map, null, (consumer) => {
      const origin = consumer.originalPositionFor({
        line: before.length,
        column: before.at(-1)?.length ?? 0,
      });
      expect(origin.source).toBe("main.lua");
      expect(origin.line).toBe(2);
      expect(origin.name).toBe("external");
    });
  });
});
