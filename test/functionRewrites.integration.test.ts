import { describe, expect, test } from "vitest";
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
});
