import Parser from "luaparse";
import { describe, expect, test } from "vitest";
import { analyzeBindingEffects } from "../src/effectAnalysis";
import { resolveScopes } from "../src/resolver";
import { analyzeTableEffects } from "../src/tableEffects";
import {
  applyTableReadMergePlan,
  planTableReadMerges,
} from "../src/tableReadMerge";

function plan(
  source: string,
  dirtyGranularity: "table" | "static-key" = "table",
) {
  const chunk = Parser.parse(source, { luaVersion: "5.3" });
  const resolved = resolveScopes(chunk);
  return {
    chunk,
    plan: planTableReadMerges(
      chunk,
      analyzeBindingEffects(chunk, resolved),
      analyzeTableEffects(chunk, resolved),
      { dirtyGranularity },
    ),
  };
}

describe("fresh table read merge planner", () => {
  test("moves stable reads across an unrelated call", () => {
    const result = plan(
      "local t={x=1,y=2} local first=t.x tick() local second=t.y",
    );
    expect(result.plan.groups).toHaveLength(1);
    expect(result.plan.groups[0].indexes).toEqual([1, 3]);
    expect(result.plan.groups[0].estimatedByteSavings).toBe(5);
  });

  test("rejects all movement for an escaping table", () => {
    const result = plan(
      "local t={x=1,y=2} local first=t.x consume(t) local second=t.y",
    );
    expect(result.plan.groups).toEqual([]);
  });

  test("treats every write as dirty in whole-table mode", () => {
    const result = plan("local t={x=1} local first=t.x t.y=2 local second=t.x");
    expect(result.plan.groups).toEqual([]);
  });

  test("crosses a write to a different key in static-key mode", () => {
    const result = plan(
      "local t={x=1} local first=t.x t.y=2 local second=t.x",
      "static-key",
    );
    expect(result.plan.groups).toHaveLength(1);
    expect(result.plan.groups[0].indexes).toEqual([1, 3]);
  });

  test("does not cross a write to the same canonical static key", () => {
    const result = plan(
      'local t={x=1} local first=t.x t["x"]=2 local second=t.x',
      "static-key",
    );
    expect(result.plan.groups).toEqual([]);
  });

  test("treats a dynamic-key write as dirty for every static key", () => {
    const result = plan(
      "local t={x=1} local first=t.x t[key]=2 local second=t.x",
      "static-key",
    );
    expect(result.plan.groups).toEqual([]);
  });

  test("rejects movement across a table binding reassignment", () => {
    const result = plan("local t={x=1} local first=t.x t={} local second=t.x");
    expect(result.plan.groups).toEqual([]);
  });

  test("rejects reads after the symbol was replaced before the group", () => {
    const result = plan(
      "local t={x=1} t=external local first=t.x tick() local second=t.x",
      "static-key",
    );
    expect(result.plan.groups).toEqual([]);
  });

  test("rejects a replacement with a metatable-bearing table in pure Lua", () => {
    const result = plan(
      "local t={x=1} t=setmetatable({x=2},{}) local first=t.x tick() local second=t.x",
      "static-key",
    );
    expect(result.plan.groups).toEqual([]);
  });

  test("merges planned declarations and keeps expressions", () => {
    const result = plan(
      "local t={x=1,y=2} local first=t.x tick() local second=t.y",
    );
    expect(applyTableReadMergePlan(result.plan)).toEqual({
      changed: true,
      invalidatesResolve: true,
    });
    expect(result.chunk.body.map((statement) => statement.type)).toEqual([
      "LocalStatement",
      "LocalStatement",
      "CallStatement",
    ]);
    const merged = result.chunk.body[1] as Parser.LocalStatement;
    expect(merged.variables.map((variable) => variable.name)).toEqual([
      "first",
      "second",
    ]);
    expect(merged.init.map((expression) => expression.type)).toEqual([
      "MemberExpression",
      "MemberExpression",
    ]);
    expect(() => resolveScopes(result.chunk)).not.toThrow();
  });

  test("splits large groups to preserve Lua register headroom", () => {
    const reads = Array.from(
      { length: 120 },
      (_, index) => `local value${String(index)}=t.x`,
    ).join(" tick() ");
    const result = plan(`local t={x=1} ${reads}`);

    expect(result.plan.groups.map((group) => group.statements.length)).toEqual([
      50, 50, 20,
    ]);
  });
});
