import Parser from "luaparse";
import { describe, expect, test } from "vitest";
import {
  applyNonAdjacentLocalPlan,
  planNonAdjacentLocals,
} from "../src/nonAdjacentLocals";
import { resolveScopes, Symbol } from "../src/resolver";
import { SourceMetadata } from "../src/sourceMetadata";

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
      "local first=first tick() local second=g() tick() local third=h() tick() local fourth=i()",
    );

    expect(result.groups).toHaveLength(1);
    expect(result.groups[0].indexes).toEqual([2, 4, 6]);
  });

  test("leaves adjacent declarations to the existing local merge", () => {
    expect(
      plan("local first=f() local second=g() local third=h()").groups,
    ).toEqual([]);
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

  test("hoists declarations while leaving initializers at their original points", () => {
    const source =
      "local first=f() tick() local second=g() value=1 local third=h()";
    const chunk = Parser.parse(source, {
      luaVersion: "5.3",
      locations: true,
      ranges: true,
    });
    const resolved = resolveScopes(chunk);
    const result = applyNonAdjacentLocalPlan(
      planNonAdjacentLocals(chunk, resolved, {
        outputNameLengthOf: () => 1,
        preserveRequireSplice: false,
      }),
    );

    expect(result).toEqual({ changed: true, invalidatesResolve: true });
    expect(chunk.body.map((statement) => statement.type)).toEqual([
      "LocalStatement",
      "AssignmentStatement",
      "CallStatement",
      "AssignmentStatement",
      "AssignmentStatement",
      "AssignmentStatement",
    ]);
    const declaration = chunk.body[0] as Parser.LocalStatement;
    expect(declaration.variables.map((variable) => variable.name)).toEqual([
      "first",
      "second",
      "third",
    ]);
    expect(declaration.init).toEqual([]);

    const after = resolveScopes(chunk);
    const writes = chunk.body
      .filter(
        (statement): statement is Parser.AssignmentStatement =>
          statement.type === "AssignmentStatement" &&
          statement.variables[0]?.type === "Identifier",
      )
      .map(
        (statement) =>
          after.symbolOf(statement.variables[0] as Parser.Identifier)?.name,
      );
    expect(writes).toEqual(["first", "second", undefined, "third"]);
  });

  test("preserves statement comments at the replacement boundaries", () => {
    const source = `--# first
local first=f()
tick()
--# second
local second=g()
tick()
--# third
local third=h() --# trailing`;
    const chunk = Parser.parse(source, {
      luaVersion: "5.3",
      comments: true,
      locations: true,
      ranges: true,
    });
    const metadata = new SourceMetadata(chunk, source);
    const resolved = resolveScopes(chunk);
    applyNonAdjacentLocalPlan(
      planNonAdjacentLocals(chunk, resolved, {
        outputNameLengthOf: () => 1,
        preserveRequireSplice: false,
      }),
      metadata,
    );

    expect(
      metadata.beforeOf(chunk.body[0]).map((comment) => comment.raw),
    ).toEqual(["--# first"]);
    expect(
      metadata.beforeOf(chunk.body[3]).map((comment) => comment.raw),
    ).toEqual(["--# second"]);
    expect(
      metadata.trailingOf(chunk.body[5]).map((comment) => comment.raw),
    ).toEqual(["--# trailing"]);
  });
});
