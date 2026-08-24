import { describe, expect, test } from "vitest";
import {
  analyzeLocalResourceUsage,
  checkParallelEvaluation,
  checkParallelValueCount,
  runtimeEnvironmentOf,
} from "../src/runtimeEnvironment";
import Parser from "luaparse";

describe("runtime environment capabilities", () => {
  test("separates semantics from compiler resource policy", () => {
    const lua = runtimeEnvironmentOf("lua53");
    const stormworks = runtimeEnvironmentOf("stormworks");

    expect(lua.semantics).toEqual({
      mutableMetatables: true,
      debugLocalIntrospection: true,
    });
    expect(stormworks.semantics).toEqual({
      mutableMetatables: false,
      debugLocalIntrospection: false,
    });
    expect(stormworks.resources).toEqual(lua.resources);
  });

  test("labels the 50-value boundary as a conservative policy", () => {
    const environment = runtimeEnvironmentOf("stormworks");

    expect(checkParallelValueCount(environment, 49)).toMatchObject({
      allowed: true,
      confidence: "conservative-policy",
    });
    expect(checkParallelValueCount(environment, 50).allowed).toBe(true);
    expect(checkParallelValueCount(environment, 51)).toEqual({
      allowed: false,
      reason: "parallel-value-limit",
      limit: 50,
      estimatedPeakRegisters: 51,
    });
  });

  test("derives parallel headroom from active locals", () => {
    const environment = runtimeEnvironmentOf("lua53");
    expect(
      checkParallelEvaluation(environment, {
        activeLocalsBefore: 150,
        parallelValueCount: 50,
      }),
    ).toMatchObject({ allowed: true, limit: 50 });
    expect(
      checkParallelEvaluation(environment, {
        activeLocalsBefore: 151,
        parallelValueCount: 50,
      }),
    ).toEqual({
      allowed: false,
      reason: "local-limit",
      limit: 49,
      estimatedPeakRegisters: 201,
    });
  });

  test("counts active locals per lexical block and function", () => {
    const chunk = Parser.parse(
      "local a=1 do local b=2 use(a,b) end local function f(p) local q=1 use(p,q) end",
      { luaVersion: "5.3" },
    );
    const usage = analyzeLocalResourceUsage(chunk);
    const doStatement = chunk.body[1];
    const nestedLocal =
      doStatement.type === "DoStatement" ? doStatement.body[0] : undefined;
    const nestedUse =
      doStatement.type === "DoStatement" ? doStatement.body[1] : undefined;
    const fn = chunk.body[2];
    if (!nestedLocal || !nestedUse || fn.type !== "FunctionDeclaration") {
      throw new Error("unexpected fixture shape");
    }
    expect(usage.activeLocalsBefore(nestedLocal)).toBe(1);
    expect(usage.activeLocalsBefore(nestedUse)).toBe(2);
    expect(usage.activeLocalsBefore(fn.body[0])).toBe(1);
    expect(usage.activeLocalsBefore(fn.body[1])).toBe(2);
  });
});
