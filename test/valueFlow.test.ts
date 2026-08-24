import Parser from "luaparse";
import { describe, expect, test } from "vitest";
import { resolveScopes } from "../src/resolver";
import { analyzeValueFlow } from "../src/valueFlow";

function analyze(source: string) {
  const chunk = Parser.parse(source, { luaVersion: "5.3" });
  const resolved = resolveScopes(chunk);
  return { chunk, resolved, flow: analyzeValueFlow(chunk, resolved) };
}

describe("linear allocation value flow", () => {
  test("tracks allocation identity through an alias and kills it on reassignment", () => {
    const { chunk, resolved, flow } = analyze(
      "local t={} local alias=t use(alias) alias={} use(alias) use(t)",
    );
    const original = flow.allocations[0];
    const replacement = flow.allocations[1];
    const aliasDeclaration = chunk.body[1];
    const firstUse = chunk.body[2];
    const secondUse = chunk.body[4];
    if (
      aliasDeclaration.type !== "LocalStatement" ||
      firstUse.type !== "CallStatement" ||
      secondUse.type !== "CallStatement"
    ) {
      throw new Error("unexpected fixture shape");
    }
    const alias = resolved.symbolOf(aliasDeclaration.variables[0]);
    const firstPoint = flow.controlFlow.pointOf(firstUse);
    const secondPoint = flow.controlFlow.pointOf(secondUse);
    if (!alias || !firstPoint || !secondPoint) throw new Error("missing facts");

    expect(flow.valueBefore(firstPoint, alias)).toMatchObject({
      kind: "allocations",
    });
    expect(flow.aliasesBefore(firstPoint, original).has(alias)).toBe(true);
    expect(flow.aliasesBefore(secondPoint, original).has(alias)).toBe(false);
    expect(flow.aliasesBefore(secondPoint, replacement).has(alias)).toBe(true);
  });

  test("does not carry an allocation across a control-flow barrier", () => {
    const { chunk, resolved, flow } = analyze(
      "local t={} if flag then use(t) end use(t)",
    );
    const declaration = chunk.body[0];
    const use = chunk.body[2];
    if (declaration.type !== "LocalStatement" || use.type !== "CallStatement") {
      throw new Error("unexpected fixture shape");
    }
    const symbol = resolved.symbolOf(declaration.variables[0]);
    const point = flow.controlFlow.pointOf(use);
    if (!symbol || !point) throw new Error("missing facts");

    expect(flow.valueBefore(point, symbol)).toEqual({
      kind: "unknown",
      reason: "region-entry",
    });
  });

  test("assigns a distinct identity to each table constructor", () => {
    const { flow } = analyze("local a={} local b={} a=b");
    expect(flow.allocations.map((allocation) => allocation.id)).toEqual([0, 1]);
    expect(flow.allocations[0].origin).not.toBe(flow.allocations[1].origin);
  });
});
