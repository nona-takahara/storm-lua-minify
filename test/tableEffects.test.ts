import Parser from "luaparse";
import { describe, expect, test } from "vitest";
import { resolveScopes } from "../src/resolver";
import { analyzeTableEffects } from "../src/tableEffects";

function analyze(source: string) {
  const chunk = Parser.parse(source, { luaVersion: "5.3" });
  return analyzeTableEffects(chunk, resolveScopes(chunk));
}

describe("fresh table effect analysis", () => {
  test("normalizes member and simple string index keys", () => {
    const analysis = analyze('local t={} local a=t.x t["x"]=1 local b=t[key]');

    expect(
      analysis.effects.map((effect) => [
        effect.access,
        effect.staticKey ?? "dynamic",
      ]),
    ).toEqual([
      ["read", "78"],
      ["write", "78"],
      ["read", "dynamic"],
    ]);
  });

  test("normalizes escaped and long-bracket keys by Lua bytes", () => {
    const analysis = analyze(
      'local t={} local a=t.x local b=t["\\120"] local c=t[ [[x]] ]',
    );
    expect(analysis.effects.map((effect) => effect.staticKey)).toEqual([
      "78",
      "78",
      "78",
    ]);
  });

  test("keeps a fresh table nonescaping across unrelated calls", () => {
    const analysis = analyze("local t={x=1} tick() local value=t.x");
    expect(analysis.freshTables).toHaveLength(1);
    expect(analysis.isNonescaping(analysis.freshTables[0])).toBe(true);
  });

  test.each([
    ["call", "local t={} consume(t)", "call"],
    ["return", "local t={} return t", "return"],
    ["store", "local t={} global=t", "store"],
    ["capture", "local t={} local f=function() return t.x end", "capture"],
  ] as const)("marks %s as an escape", (_label, source, reason) => {
    const analysis = analyze(source);
    expect(analysis.escapes.map((escape) => escape.reason)).toContain(reason);
    expect(analysis.isNonescaping(analysis.freshTables[0])).toBe(false);
  });

  test("tracks a local alias as the same nonescaping allocation", () => {
    const analysis = analyze(
      "local t={} local alias=t alias.x=1 local value=t.x",
    );
    expect(analysis.freshTables).toHaveLength(1);
    expect(analysis.escapes).toEqual([]);
    expect(
      analysis.effects.map((effect) => effect.table.allocation.id),
    ).toEqual([0, 0]);
    expect(analysis.effects.map((effect) => effect.baseSymbol.name)).toEqual([
      "alias",
      "t",
    ]);
  });

  test("keeps writes to different static keys distinct", () => {
    const analysis = analyze("local t={} t.x=1 t.y=2");
    expect(
      analysis.effects.map((effect) => [effect.access, effect.staticKey]),
    ).toEqual([
      ["write", "78"],
      ["write", "79"],
    ]);
  });
});
