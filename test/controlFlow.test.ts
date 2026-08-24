import Parser from "luaparse";
import { describe, expect, test } from "vitest";
import { analyzeControlFlow } from "../src/controlFlow";

describe("certified linear control-flow regions", () => {
  test("keeps calls and assignments in a region and splits at control flow", () => {
    const chunk = Parser.parse(
      "local a=f() tick() a=2 if flag then local b=g() tick() end local c=h() return c",
      { luaVersion: "5.3" },
    );
    const flow = analyzeControlFlow(chunk, 7);

    expect(flow.complete).toBe(false);
    expect(flow.version).toBe(7);
    expect(flow.regions.map((region) => region.points.length)).toEqual([
      3, 2, 1,
    ]);
    expect(flow.units).toHaveLength(1);
    expect(flow.pointsBetween(chunk.body[0], chunk.body[2])).toHaveLength(3);
    expect(flow.pointsBetween(chunk.body[0], chunk.body[4])).toBeUndefined();
  });

  test("creates a separate execution unit for each nested function", () => {
    const chunk = Parser.parse(
      "local outer=1 local f=function() local inner=2 tick() return inner end use(outer,f)",
      { luaVersion: "5.3" },
    );
    const flow = analyzeControlFlow(chunk);

    expect(flow.units.map((unit) => unit.kind)).toEqual(["chunk", "function"]);
    expect(flow.regions.map((region) => region.unit.id)).toEqual([1, 0]);
  });

  test("does not certify label, goto, loop, or return statements", () => {
    const chunk = Parser.parse(
      "::again:: local a=1 while flag do a=2 end goto again",
      { luaVersion: "5.3" },
    );
    const flow = analyzeControlFlow(chunk);

    expect(chunk.body.map((statement) => flow.pointOf(statement))).toEqual([
      undefined,
      expect.any(Object),
      undefined,
      undefined,
    ]);
  });
});
