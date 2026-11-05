import { SourceNode } from "source-map";
import { describe, expect, test, vi } from "vitest";
import { AnalysisConvergenceError } from "../src/analysisConvergenceError";
import { Minifier } from "../src/minifier";
import { executeLua } from "./lib/luaExecution";
import {
  createTemporaryLuaProject,
  minifyLuaProject,
} from "./lib/minifierHarness";

// Inject at the candidate boundary without exposing a production testing hook.
// Every candidate enters here, including ones that reuse a cached prefix.
const prototype = Minifier.prototype as unknown as {
  parseCostSnapshot(...args: unknown[]): SourceNode;
};
// eslint-disable-next-line @typescript-eslint/unbound-method -- Each injected call supplies the candidate as this explicitly.
const parseCostSnapshot = prototype.parseCostSnapshot;
const failures = [
  {
    error: new AnalysisConvergenceError("did not converge"),
    kind: "analysis-nonconvergence",
    name: "AnalysisConvergenceError",
    message: "did not converge",
  },
  {
    error: new TypeError("broken invariant"),
    kind: "unexpected-error",
    name: "TypeError",
    message: "broken invariant",
  },
  { error: null, kind: "non-error-thrown" },
];

describe("cost gate failure diagnostics", () => {
  describe.each(["full-trial", "ablation"] as const)("%s failures", (stage) => {
    test.each(failures)(
      "classifies $kind and preserves execution and source maps",
      (failure) => {
        const source = "return 1";
        const project = createTemporaryLuaProject({ "main.lua": source });
        const run = (collectOptimizationDiagnostics: boolean) => {
          let calls = 0;
          const spy = vi
            .spyOn(prototype, "parseCostSnapshot")
            .mockImplementation(function (this: Minifier, ...args: unknown[]) {
              calls++;
              if (calls === (stage === "full-trial" ? 2 : 3))
                // eslint-disable-next-line @typescript-eslint/only-throw-error -- Exercise JavaScript non-Error throws as well.
                throw failure.error;
              return parseCostSnapshot.apply(this, args);
            });
          try {
            return minifyLuaProject(project, {
              runtimeProfile: "stormworks",
              requireWrapper: false,
              collectOptimizationDiagnostics,
            });
          } finally {
            spy.mockRestore();
          }
        };
        const disabled = run(false);
        const enabled = run(true);
        expect(enabled.code).toBe(disabled.code);
        expect(enabled.map).toEqual(disabled.map);
        const observe = (code: string) =>
          executeLua(`print(pcall(function()\n${code}\nend))`);
        const expected = { status: 0, stdout: "true\t1\n", stderr: "" };
        expect(observe(source), "original program").toEqual(expected);
        expect(observe(disabled.code), "diagnostics disabled").toEqual(
          expected,
        );
        expect(observe(enabled.code), "diagnostics enabled").toEqual(expected);
        expect(disabled.minifier.optimizationDiagnostics).toEqual([]);
        const records = enabled.minifier.optimizationDiagnostics.filter(
          (item) => item.failure,
        );
        expect(records).toHaveLength(1);
        expect(records[0]).toMatchObject({
          pass: "optimizer-cost-failure",
          reason: "trial-failed",
          decision: "rejected",
          failure: { stage, kind: failure.kind },
        });
        expect(records[0].failure?.name).toBe(failure.name);
        expect(records[0].failure?.message).toBe(failure.message);
        expect(records[0].failure?.gate).toBe(
          stage === "ablation" ? "fieldRename" : undefined,
        );
        expect(enabled.minifier.optimizationDiagnostics).toContainEqual(
          expect.objectContaining({
            pass: "optimizer-final-cost",
            reason:
              stage === "full-trial"
                ? "trial-failed"
                : "final-output-not-shorter",
          }),
        );
        expect(JSON.parse(JSON.stringify(records))).toEqual(records);
      },
    );
  });
  test("propagates baseline failures", () => {
    const project = createTemporaryLuaProject({ "main.lua": "return 1" });
    const error = new AnalysisConvergenceError("baseline failed");
    const spy = vi
      .spyOn(prototype, "parseCostSnapshot")
      .mockImplementation(() => {
        throw error;
      });
    try {
      expect(() =>
        minifyLuaProject(project, {
          runtimeProfile: "stormworks",
          collectOptimizationDiagnostics: true,
        }),
      ).toThrow(error);
    } finally {
      spy.mockRestore();
    }
  });
});
