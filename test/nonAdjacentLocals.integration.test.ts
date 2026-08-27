import Parser from "luaparse";
import { describe, expect, test } from "vitest";
import { MinifierMode } from "../src/minifier";
import { minifyTemporaryLuaSource } from "./lib/minifierHarness";

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
    expect(
      minify(SOURCE, {
        runtimeProfile: "stormworks",
        statementOptimizations: false,
      }),
    ).toBe(minify(SOURCE, { runtimeProfile: "lua53" }));
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

    expect(output).toBe(minify(SOURCE, { runtimeProfile: "lua53" }));
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
    expect(enabled).toBe(disabled);
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

  test.each(["if flag then tick() end", "while flag do tick() break end"])(
    "shortens across a proven structured control boundary: %s",
    (middle) => {
      const source = `local first=makeFirst() ${middle} local second=makeSecond() use(first,second)`;
      const disabled = minify(source, {
        runtimeProfile: "stormworks",
        localDeclarationHoisting: false,
      });
      const enabled = minify(source, { runtimeProfile: "stormworks" });

      expect(Buffer.byteLength(enabled)).toBeLessThan(
        Buffer.byteLength(disabled),
      );
      expect(() => Parser.parse(enabled, { luaVersion: "5.3" })).not.toThrow();
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
