import Parser from "luaparse";
import { describe, expect, test } from "vitest";
import { MinifierMode } from "../src/minifier";
import { minifyTemporaryLuaSource } from "./lib/minifierHarness";
import { executeLua } from "./lib/luaExecution";
import { expectLuaProgramsOutput } from "./lib/luaProjectAssertions";

function minify(source: string, mode: Partial<MinifierMode>): string {
  return minifyTemporaryLuaSource(
    source,
    { requireWrapper: false, ...mode },
    { prefix: "storm-effect-locals-test-" },
  ).code;
}

const SOURCE = `
local first = makeFirst()
tick()
local second = makeSecond()
value = 1
local third = makeThird()
use(first, second, third)
`;

function expectSourceTrace(...outputs: string[]): void {
  expectLuaProgramsOutput(
    [SOURCE, ...outputs].map((code) => `${code}\nprint("global",value)`),
    "first\ntick\nsecond\nthird\nuse\t11\t22\t33\nglobal\t1\ntrue\n",
    'function makeFirst() print("first") return 11 end function makeSecond() print("second") return 22 end function makeThird() print("third") return 33 end function tick() print("tick") end function use(...) print("use",...) end',
  );
}

describe("effect-aware non-adjacent locals pipeline", () => {
  test("is enabled by default for Stormworks and produces shorter valid Lua", () => {
    const disabled = minify(SOURCE, {
      runtimeProfile: "stormworks",
      localDeclarationHoisting: false,
      tableReadMerging: false,
    });
    const enabled = minify(SOURCE, { runtimeProfile: "stormworks" });

    expect(Buffer.byteLength(enabled)).toBeLessThan(
      Buffer.byteLength(disabled),
    );
    expect(() => Parser.parse(enabled, { luaVersion: "5.3" })).not.toThrow();
  });

  test("can be opted out in Stormworks", () => {
    expectSourceTrace(
      minify(SOURCE, {
        runtimeProfile: "stormworks",
        statementOptimizations: false,
      }),
      minify(SOURCE, { runtimeProfile: "lua53" }),
    );
  });

  test("requires a separate local-lifetime opt-in for pure Lua", () => {
    const defaultLua = minify(SOURCE, { runtimeProfile: "lua53" });
    const optedInLua = minify(SOURCE, {
      runtimeProfile: "lua53",
      allowIntrospectionChanges: true,
    });

    expect(Buffer.byteLength(optedInLua)).toBeLessThan(
      Buffer.byteLength(defaultLua),
    );
  });

  test("does not run the lifetime opt-in when the safe transform master is off", () => {
    const output = minify(SOURCE, {
      runtimeProfile: "lua53",
      allowIntrospectionChanges: true,
      statementOptimizations: false,
    });

    expectSourceTrace(output, minify(SOURCE, { runtimeProfile: "lua53" }));
  });

  test("does not replace a shorter adjacent-local merge", () => {
    const source =
      "local first=f() local second=g() local third=h() use(first,second,third)";
    const disabled = minify(source, {
      runtimeProfile: "stormworks",
      localDeclarationHoisting: false,
      tableReadMerging: false,
    });
    const enabled = minify(source, { runtimeProfile: "stormworks" });

    expect(Buffer.byteLength(enabled)).toBeLessThanOrEqual(
      Buffer.byteLength(disabled),
    );
    expectLuaProgramsOutput(
      [source, enabled, disabled],
      "f\ng\nh\nuse\t1\t2\t3\ntrue\n",
      'function f() print("f") return 1 end function g() print("g") return 2 end function h() print("h") return 3 end function use(...) print("use",...) end',
    );
  });

  test("table-read opt-out does not disable local hoisting", () => {
    const enabled = minify(SOURCE, {
      runtimeProfile: "stormworks",
      tableReadMerging: false,
    });
    const localDisabled = minify(SOURCE, {
      runtimeProfile: "stormworks",
      tableReadMerging: false,
      localDeclarationHoisting: false,
    });

    expect(Buffer.byteLength(enabled)).toBeLessThan(
      Buffer.byteLength(localDisabled),
    );
  });

  describe.each(["if flag then tick() end", "while flag do tick() break end"])(
    "structured control boundary: %s",
    (middle) => {
      test.each([false, true])("preserves order with flag=%s", (flag) => {
        const source = `local first=makeFirst() ${middle} local second=makeSecond() use(first,second)`;
        const disabled = minify(source, {
          runtimeProfile: "stormworks",
          localDeclarationHoisting: false,
        });
        const enabled = minify(source, { runtimeProfile: "stormworks" });

        expect(Buffer.byteLength(enabled)).toBeLessThan(
          Buffer.byteLength(disabled),
        );
        expect(() =>
          Parser.parse(enabled, { luaVersion: "5.3" }),
        ).not.toThrow();
        const prelude = `flag=${flag ? "true" : "false"} function makeFirst() print("first") return 1 end function tick() print("tick") end function makeSecond() print("second") return 2 end function use(a,b) print(a,b) end\n`;
        const expected = {
          status: 0,
          stdout: `first\n${flag ? "tick\n" : ""}second\n1\t2\n`,
          stderr: "",
        };
        expect(executeLua(prelude + source), "original program").toEqual(
          expected,
        );
        expect(executeLua(prelude + enabled), "hoisting enabled").toEqual(
          expected,
        );
        expect(executeLua(prelude + disabled), "hoisting disabled").toEqual(
          expected,
        );
      });
    },
  );

  test("does not grow after Rename crosses the one-character name range", () => {
    const names = Array.from(
      { length: 60 },
      (_, index) => `value${String(index)}`,
    );
    const declarations = names
      .map((name, index) => `local ${name}=make(${String(index)})\ntick()`)
      .join("\n");
    const source = `${declarations}\nuse(${names.join(",")})`;
    const disabled = minify(source, {
      runtimeProfile: "stormworks",
      statementOptimizations: false,
    });
    const enabled = minify(source, { runtimeProfile: "stormworks" });

    expect(Buffer.byteLength(enabled)).toBeLessThanOrEqual(
      Buffer.byteLength(disabled),
    );
    expect(() => Parser.parse(enabled, { luaVersion: "5.3" })).not.toThrow();
  }, 15_000);
});
