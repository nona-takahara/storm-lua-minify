import { describe, expect, test } from "vitest";
import {
  checkParallelValueCount,
  runtimeEnvironmentOf,
} from "../src/runtimeEnvironment";

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
    });
  });
});
