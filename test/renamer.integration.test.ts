import { describe, expect, test } from "vitest";
import { SourceMapConsumer } from "source-map";
import { minifyTemporaryLuaSource } from "./lib/minifierHarness";
import { runMinifier, WORKING_CASES } from "./lib/helpers";
import { executeLua } from "./lib/luaExecution";

const SOURCE = `local first = 1
use(first)
local second = 2
use(second)
`;

const BASE_MODE = {
  requireWrapper: false,
  localDeclarationMerging: false,
  localDeclarationHoisting: false,
  tableReadMerging: false,
  globalAliasing: false,
  unusedCodeRemoval: false,
} as const;

describe("liveness-based identifier coloring", () => {
  test.each([
    {
      name: "a revived captured binding",
      source:
        "local revived local function read()return revived end local intervening=true revived=7 print(read(),intervening)",
      stdout: "7\ttrue\n",
    },
    {
      name: "capture through a nested block",
      source:
        "local captured=1 do local nested=2 local function read()return captured end print(nested,read()) end",
      stdout: "2\t1\n",
    },
    {
      name: "simultaneously live values across a loop back-edge",
      source:
        "local left,right=1,2 for i=1,3 do left,right=right,left end print(left,right)",
      stdout: "2\t1\n",
    },
  ])("preserves $name", ({ source, stdout }) => {
    const { code } = minifyTemporaryLuaSource(source, {
      ...BASE_MODE,
      runtimeProfile: "stormworks",
      functionOptimizations: false,
    });
    const expected = { status: 0, stdout, stderr: "" };
    expect(executeLua(source), "original program").toEqual(expected);
    expect(executeLua(code), "colored program").toEqual(expected);
  });

  test("reuses a same-scope name and preserves each Source Map origin", async () => {
    const result = minifyTemporaryLuaSource(SOURCE, {
      ...BASE_MODE,
      runtimeProfile: "stormworks",
    });

    expect(result.code.replaceAll("\n", " ")).toBe(
      "local a=1 use(a)local a=2 use(a)",
    );
    expect(result.map.names).toEqual(
      expect.arrayContaining(["first", "second"]),
    );
    const prelude = "function use(value) print(value) end\n";
    const expected = { status: 0, stdout: "1\n2\n", stderr: "" };
    expect(executeLua(prelude + SOURCE)).toEqual(expected);
    expect(executeLua(prelude + result.code)).toEqual(expected);
    await SourceMapConsumer.with(result.map, null, (consumer) => {
      const first = consumer.generatedPositionFor({
        source: "main.lua",
        line: 1,
        column: 6,
      });
      const second = consumer.generatedPositionFor({
        source: "main.lua",
        line: 3,
        column: 6,
      });
      if (
        first.line === null ||
        first.column === null ||
        second.line === null ||
        second.column === null
      )
        throw new Error("renamed declarations must have generated mappings");
      expect(
        consumer.originalPositionFor({
          line: first.line,
          column: first.column,
        }).name,
      ).toBe("first");
      expect(
        consumer.originalPositionFor({
          line: second.line,
          column: second.column,
        }).name,
      ).toBe("second");
    });
  });

  test("preserves distinct same-scope names in introspection mode", () => {
    const preserved = minifyTemporaryLuaSource(SOURCE, {
      ...BASE_MODE,
      runtimeProfile: "lua53",
    });
    const optedIn = minifyTemporaryLuaSource(SOURCE, {
      ...BASE_MODE,
      runtimeProfile: "lua53",
      allowIntrospectionChanges: true,
    });

    expect(preserved.code.replaceAll("\n", " ")).toBe(
      "local a=1 use(a)local b=2 use(b)",
    );
    expect(optedIn.code.replaceAll("\n", " ")).toBe(
      "local a=1 use(a)local a=2 use(a)",
    );
  });

  test("never lengthens the existing fixture corpus", () => {
    WORKING_CASES.forEach((fixture) => {
      const common = {
        ...fixture,
        mode: {
          ...fixture.mode,
          localDeclarationMerging: false,
          optimizations: false,
          identifierOptimizations: true,
          globalAliasing: false,
          unusedCodeRemoval: false,
        },
      };
      const colored = runMinifier({
        ...common,
        mode: { ...common.mode, runtimeProfile: "stormworks" },
      }).code;
      const conservative = runMinifier({
        ...common,
        mode: { ...common.mode, runtimeProfile: "lua53" },
      }).code;
      expect(Buffer.byteLength(colored), fixture.label).toBeLessThanOrEqual(
        Buffer.byteLength(conservative),
      );
    });
  });
});
