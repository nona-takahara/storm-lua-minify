import { describe, expect, test } from "vitest";
import { MinifierMode } from "../src/minifier";
import { minifyTemporaryLuaSource } from "./lib/minifierHarness";
import { executeLua } from "./lib/luaExecution";
import { expectLuaProgramsOutput } from "./lib/luaProjectAssertions";

function minify(source: string, mode: Partial<MinifierMode>): string {
  return minifyTemporaryLuaSource(
    source,
    { requireWrapper: false, requiredWhitespace: " ", ...mode },
    { prefix: "storm-local-run-planner-test-" },
  ).code;
}

describe("local-run planner profiles", () => {
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

    expectLuaProgramsOutput(
      [source, enabled, disabled],
      "f\ng\nuse\t1\t2\ntrue\n",
      'function f() print("f") return 1 end function g() print("g") return 2 end function use(...) print("use",...) end',
    );
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

    expectLuaProgramsOutput(
      [source, stormworks, optedOut, lua],
      "f\ng\t1\nuse\t1\t2\ntrue\n",
      'function f() print("f") return 1 end function g(x) print("g",x) return x+1 end function use(...) print("use",...) end',
    );
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

    expect(Buffer.byteLength(aggressive)).toBeLessThan(Buffer.byteLength(safe));
    const prelude = "function use(before,after) print(before,after) end\n";
    const unchanged = { status: 0, stdout: "1\t2\n", stderr: "" };
    expect(executeLua(prelude + source)).toEqual(unchanged);
    expect(executeLua(prelude + safe)).toEqual(unchanged);
    // This opt-in explicitly permits the second read to observe the old value.
    expect(executeLua(prelude + aggressive)).toEqual({
      status: 0,
      stdout: "1\t1\n",
      stderr: "",
    });
  });
});
