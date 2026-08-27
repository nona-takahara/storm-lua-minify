import { describe, expect, test } from "vitest";
import { MinifierMode } from "../src/minifier";
import { minifyTemporaryLuaSource } from "./lib/minifierHarness";

function minify(source: string, mode: Partial<MinifierMode>): string {
  return minifyTemporaryLuaSource(
    source,
    { requireWrapper: false, requiredWhitespace: " ", ...mode },
    { prefix: "storm-local-run-planner-test-" },
  ).code;
}

describe("Issue #42 local-run planner profiles", () => {
  test("keeps pure-Lua independent merging as an opt-out", () => {
    const source = "local first=f() local second=g() use(first,second)";
    const enabled = minify(source, {
      runtimeProfile: "lua53",
      identifierOptimizations: false,
    });
    const disabled = minify(source, {
      runtimeProfile: "lua53",
      identifierOptimizations: false,
      localDeclarationMerging: false,
    });

    expect(enabled).toBe("local first,second=f(),g()use(first,second)");
    expect(Buffer.byteLength(enabled)).toBeLessThan(
      Buffer.byteLength(disabled),
    );
  });

  test("separates dependent initializers by default only in Stormworks", () => {
    const source = "local a=f() local b=g(a) use(a,b)";
    const stormworks = minify(source, {
      runtimeProfile: "stormworks",
      identifierOptimizations: false,
    });
    const optedOut = minify(source, {
      runtimeProfile: "stormworks",
      identifierOptimizations: false,
      localDeclarationHoisting: false,
    });
    const lua = minify(source, {
      runtimeProfile: "lua53",
      identifierOptimizations: false,
    });

    expect(stormworks).toBe("local a,b=f()b=g(a)use(a,b)");
    expect(optedOut).toBe(lua);
    expect(Buffer.byteLength(stormworks)).toBeLessThan(
      Buffer.byteLength(optedOut),
    );
  });

  test("moves dirty table reads only with the explicit aggressive opt-in", () => {
    const source =
      "local tableValue={x=1} local before=tableValue.x tableValue.x=2 local after=tableValue.x use(before,after)";
    const safe = minify(source, {
      runtimeProfile: "stormworks",
      identifierOptimizations: false,
    });
    const aggressive = minify(source, {
      runtimeProfile: "stormworks",
      identifierOptimizations: false,
      allowObservableTableReadChanges: true,
    });

    expect(safe.replace(/\s+/g, " ")).toContain(
      "tableValue.x=2 local after=tableValue.x",
    );
    expect(aggressive.replace(/\s+/g, " ")).toContain(
      "local before,after=tableValue.x,tableValue.x tableValue.x=2",
    );
    expect(Buffer.byteLength(aggressive)).toBeLessThan(Buffer.byteLength(safe));
  });
});
