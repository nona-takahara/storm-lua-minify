import Parser from "luaparse";
import { describe, expect, test } from "vitest";
import { analyzeOptimizer } from "../src/optimizerAnalysis";
import { resolveScopes } from "../src/resolver";
import {
  applyStatementSchedule,
  planStatementSchedule,
} from "../src/statementScheduler";

function plan(source: string) {
  const chunk = Parser.parse(source, {
    luaVersion: "5.3",
    locations: true,
    ranges: true,
  });
  const resolved = resolveScopes(chunk);
  const analysis = analyzeOptimizer(chunk, resolved);
  const schedule = planStatementSchedule(chunk, resolved, {
    facts: analysis.facts,
    dataflow: analysis.statementDataflow,
    outputNameLengthOf: () => 1,
    preserveRequireSplice: false,
  });
  return { chunk, schedule };
}

describe("statement scheduler local packing", () => {
  test("reserves adjacent declarations for the cheaper lexical merge", () => {
    const { schedule } = plan("local first=f() local second=g()");

    expect(schedule.localGroups).toHaveLength(1);
    expect(schedule.localGroups[0]).toMatchObject({
      indexes: [0, 1],
      mode: "merge-initializers",
      byteSavings: 5,
    });
  });

  test("schedules a nested function as its own execution unit", () => {
    const { schedule } = plan(
      "local function nested() local first=f() local second=g() end",
    );

    expect(schedule.localGroups).toHaveLength(1);
    expect(schedule.localGroups[0]).toMatchObject({
      indexes: [0, 1],
      mode: "merge-initializers",
    });
  });

  test("schedules a function expression as its own execution unit", () => {
    const { schedule } = plan(
      "local nested=function() local first=f() local second=g() end",
    );

    expect(schedule.localGroups).toHaveLength(1);
    expect(schedule.localGroups[0]).toMatchObject({
      indexes: [0, 1],
      mode: "merge-initializers",
    });
  });

  test.each([
    "local first=f() if flag then tick() end local second=g()",
    "local first=f() while flag do tick() end local second=g()",
  ])(
    "splits initializers while crossing structured control flow: %s",
    (source) => {
      const { chunk, schedule } = plan(source);
      expect(schedule.localGroups).toHaveLength(1);
      expect(schedule.localGroups[0]).toMatchObject({
        indexes: [0, 2],
        mode: "split-initializers",
        byteSavings: 4,
      });

      expect(applyStatementSchedule(schedule)).toEqual({
        changed: true,
        invalidatesResolve: true,
      });
      expect(chunk.body.map((statement) => statement.type)).toEqual([
        "LocalStatement",
        source.includes("if") ? "IfStatement" : "WhileStatement",
        "AssignmentStatement",
      ]);
    },
  );

  test("does not widen a declaration across a reference that it would shadow", () => {
    const { schedule } = plan(
      "local first=f() if flag then use(second) end local second=g()",
    );
    expect(schedule.localGroups).toEqual([]);
  });

  test("keeps labels and gotos as hard scope boundaries", () => {
    const { schedule } = plan(
      "local first=f() goto done ::done:: local second=g()",
    );
    expect(schedule.localGroups).toEqual([]);
  });
});
