import { SourceNode } from "source-map";
import { afterEach, expect, test, vi } from "vitest";
import { Minifier } from "../../src/minifier";
import { executeLua } from "../lib/luaExecution";
import { matchesCostCandidate } from "../lib/costCandidate";
import { minifyTemporaryLuaSource } from "../lib/minifierHarness";

afterEach(() => vi.restoreAllMocks());

test("a failed optimization trial still produces a functioning program", () => {
  // Same candidate boundary as the detailed failure-diagnostics tests.
  const prototype = Minifier.prototype as unknown as {
    parseCostSnapshot(...args: unknown[]): SourceNode;
  };
  // eslint-disable-next-line @typescript-eslint/unbound-method -- Called below with the candidate as this.
  const parseCostSnapshot = prototype.parseCostSnapshot;
  let injected = false;
  vi.spyOn(prototype, "parseCostSnapshot").mockImplementation(function (
    this: Minifier,
    ...args: unknown[]
  ) {
    if (matchesCostCandidate(args, "full-trial")) {
      injected = true;
      throw new Error("trial-only failure");
    }
    return parseCostSnapshot.apply(this, args);
  });

  const source =
    "local function answer(value) return value+1 end print(answer(41))";
  const { code } = minifyTemporaryLuaSource(source, {
    runtimeProfile: "stormworks",
    requireWrapper: false,
  });
  // Verify the fixture exercised recovery; do not require a shorter artifact.
  expect(injected).toBe(true);
  const expected = { status: 0, stdout: "42\n", stderr: "" };
  expect(executeLua(source), "original program").toEqual(expected);
  expect(executeLua(code), "recovered program").toEqual(expected);
});
