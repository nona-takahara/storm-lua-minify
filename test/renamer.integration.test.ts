import { describe, expect, test } from "vitest";
import { SourceMapConsumer } from "source-map";
import { minifyTemporaryLuaSource } from "./lib/minifierHarness";
import { runMinifier, WORKING_CASES } from "./lib/helpers";

const SOURCE = `local first = 1
use(first)
local second = 2
use(second)
`;

const BASE_MODE = {
  moduleLikeLua: false,
  mergeLocals: false,
  effectAwareLocalHoist: false,
  effectAwareTableReads: false,
  globalAlias: false,
  removeUnused: false,
} as const;

describe("liveness-based identifier coloring", () => {
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
      allowLocalLifetimeChanges: true,
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
          mergeLocals: false,
          effectAwareTransforms: false,
          globalAlias: false,
          removeUnused: false,
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
