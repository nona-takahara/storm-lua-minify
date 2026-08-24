import Parser from "luaparse";
import { describe, expect, test } from "vitest";
import { planNonAdjacentLocals } from "../src/nonAdjacentLocals";
import { resolveScopes, Symbol } from "../src/resolver";

function plan(
  source: string,
  outputNameLengthOf: (symbol: Symbol) => number | undefined = () => 1,
  preserveRequireSplice = false,
) {
  const chunk = Parser.parse(source, { luaVersion: "5.3" });
  const resolved = resolveScopes(chunk);
  return planNonAdjacentLocals(chunk, resolved, {
    outputNameLengthOf,
    preserveRequireSplice,
  });
}

describe("non-adjacent local planner", () => {
  test("plans a profitable group across calls and assignments", () => {
    const result = plan(
      "local first=f() tick() local second=g() value=1 local third=h()",
    );

    expect(result.groups).toHaveLength(1);
    expect(result.groups[0].indexes).toEqual([0, 2, 4]);
    expect(result.groups[0].estimatedByteSavings).toBe(3);
  });

  test("rejects a two-local group whose separator-aware cost is not smaller", () => {
    expect(plan("local first=f() tick() local second=g()").groups).toEqual([]);
  });

  test("rejects hoisting when it would shadow an intervening reference", () => {
    const result = plan(
      "local first=f() print(third) local second=g() local third=h() local fourth=i()",
    );

    expect(result.groups).toEqual([]);
  });

  test("excludes a self-shadowing initializer without losing the next group", () => {
    const result = plan(
      "local first=first local second=g() local third=h() local fourth=i()",
    );

    expect(result.groups).toHaveLength(1);
    expect(result.groups[0].indexes).toEqual([1, 2, 3]);
  });

  test("uses control flow and unsupported local shapes as boundaries", () => {
    const result = plan(
      "local a=f() if flag then use() end local b,c=g() local d=h() local e=i()",
    );

    expect(result.groups).toEqual([]);
  });

  test("preserves SL require splice when requested", () => {
    const result = plan(
      'local a=f() local b=require("m") local c=g() local d=h()',
      () => 1,
      true,
    );

    expect(result.groups).toEqual([]);
  });

  test("rejects a group when predicted rename lengths cannot prove savings", () => {
    const result = plan(
      "local first=f() local second=g() local third=h()",
      () => 2,
    );

    expect(result.groups).toEqual([]);
  });
});
