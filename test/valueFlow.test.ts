import Parser from "luaparse";
import { describe, expect, test } from "vitest";
import { resolveScopes } from "../src/resolver";
import { analyzeOptimizer } from "../src/optimizerAnalysis";

function analyze(source: string) {
  const chunk = Parser.parse(source, { luaVersion: "5.3" });
  const resolved = resolveScopes(chunk);
  return { chunk, resolved, flow: analyzeOptimizer(chunk, resolved).valueFlow };
}

describe("CFG allocation value flow", () => {
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

  test("carries an unchanged allocation through a branch join", () => {
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

    expect(flow.valueBefore(point, symbol)).toMatchObject({
      kind: "allocations",
    });
    expect(flow.aliasesBefore(point, flow.allocations[0]).has(symbol)).toBe(
      true,
    );
  });

  test("joins branch definitions and reaches a loop fixed point", () => {
    const { chunk, resolved, flow } = analyze(
      "local t={} while again do if replace then t={} end use(t) end use(t)",
    );
    const declaration = chunk.body[0] as Parser.LocalStatement;
    const finalUse = chunk.body[2] as Parser.CallStatement;
    const symbol = resolved.symbolOf(declaration.variables[0]);
    const point = flow.controlFlow.pointOf(finalUse);
    if (!symbol || !point) throw new Error("missing facts");

    const value = flow.valueBefore(point, symbol);
    expect(value.kind).toBe("allocations");
    if (value.kind !== "allocations") throw new Error("unexpected value");
    expect(value.allocations.size).toBe(2);
  });

  test("assigns a distinct identity to each table constructor", () => {
    const { flow } = analyze("local a={} local b={} a=b");
    expect(flow.allocations.map((allocation) => allocation.id)).toEqual([0, 1]);
    expect(flow.allocations[0].origin).not.toBe(flow.allocations[1].origin);
  });

  test("uses shared Lua value adjustment facts for nil padding", () => {
    const { chunk, resolved, flow } = analyze(
      "local first,missing={} local useMissing=missing",
    );
    const declaration = chunk.body[0] as Parser.LocalStatement;
    const use = chunk.body[1] as Parser.LocalStatement;
    const missing = resolved.symbolOf(declaration.variables[1]);
    const point = flow.controlFlow.pointOf(use);
    if (!missing || !point) throw new Error("missing facts");

    expect(flow.valueBefore(point, missing)).toEqual({ kind: "nil" });
  });

  test("keeps an expanded tail unknown instead of assigning one RHS by index", () => {
    const { chunk, resolved, flow } = analyze(
      "local first,second=values() local useSecond=second",
    );
    const declaration = chunk.body[0] as Parser.LocalStatement;
    const use = chunk.body[1] as Parser.LocalStatement;
    const second = resolved.symbolOf(declaration.variables[1]);
    const point = flow.controlFlow.pointOf(use);
    if (!second || !point) throw new Error("missing facts");

    expect(flow.valueBefore(point, second)).toEqual({
      kind: "unknown",
      reason: "multi-value-tail",
    });
  });

  test("instantiates a distinct fresh allocation for each proven factory call", () => {
    const { chunk, resolved, flow } = analyze(`
local function factory() return {} end
local first=factory()
local second=factory()
use(first,second)
`);
    const firstDeclaration = chunk.body[1] as Parser.LocalStatement;
    const secondDeclaration = chunk.body[2] as Parser.LocalStatement;
    const use = chunk.body[3] as Parser.CallStatement;
    const first = resolved.symbolOf(firstDeclaration.variables[0]);
    const second = resolved.symbolOf(secondDeclaration.variables[0]);
    const point = flow.controlFlow.pointOf(use);
    if (!first || !second || !point) throw new Error("missing facts");

    const firstValue = flow.valueBefore(point, first);
    const secondValue = flow.valueBefore(point, second);
    expect(firstValue.kind).toBe("allocations");
    expect(secondValue.kind).toBe("allocations");
    if (firstValue.kind !== "allocations" || secondValue.kind !== "allocations")
      throw new Error("unexpected values");
    expect([...firstValue.allocations]).not.toEqual([
      ...secondValue.allocations,
    ]);
  });

  test("keeps branch-joined fresh factory alternatives as one call-instance identity", () => {
    const { chunk, resolved, flow } = analyze(`
local function factory(flag)
  if flag then return {x=1} else return {x=2} end
end
local value=factory(condition)
use(value)
`);
    const declaration = chunk.body[1] as Parser.LocalStatement;
    const use = chunk.body[2] as Parser.CallStatement;
    const symbol = resolved.symbolOf(declaration.variables[0]);
    const point = flow.controlFlow.pointOf(use);
    if (!symbol || !point) throw new Error("missing facts");
    const value = flow.valueBefore(point, symbol);
    expect(value.kind).toBe("allocations");
    if (value.kind !== "allocations") throw new Error("unexpected value");
    expect(value.allocations.size).toBe(1);
  });

  test("substitutes a parameter return alias with the caller allocation", () => {
    const { chunk, resolved, flow } = analyze(`
local function identity(value) return value end
local original={}
local alias=identity(original)
use(alias)
`);
    const originalDeclaration = chunk.body[1] as Parser.LocalStatement;
    const aliasDeclaration = chunk.body[2] as Parser.LocalStatement;
    const use = chunk.body[3] as Parser.CallStatement;
    const original = resolved.symbolOf(originalDeclaration.variables[0]);
    const alias = resolved.symbolOf(aliasDeclaration.variables[0]);
    const point = flow.controlFlow.pointOf(use);
    if (!original || !alias || !point) throw new Error("missing facts");
    expect(flow.valueBefore(point, alias)).toEqual(
      flow.valueBefore(point, original),
    );
  });

  test("does not instantiate captured shared storage or metatable-dependent values as fresh", () => {
    for (const source of [
      `
local shared={}
local function factory() return shared end
local value=factory()
use(value)
`,
      `
local function factory() return setmetatable({},meta) end
local value=factory()
use(value)
`,
    ]) {
      const { chunk, resolved, flow } = analyze(source);
      const declaration = chunk.body.at(-2) as Parser.LocalStatement;
      const use = chunk.body.at(-1) as Parser.CallStatement;
      const symbol = resolved.symbolOf(declaration.variables[0]);
      const point = flow.controlFlow.pointOf(use);
      if (!symbol || !point) throw new Error("missing facts");
      expect(flow.valueBefore(point, symbol).kind).toBe("unknown");
    }
  });
});
