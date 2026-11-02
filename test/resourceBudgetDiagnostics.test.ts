import { describe, expect, test } from "vitest";
import { applyAggregateSpecialization } from "../src/aggregateSpecialization";
import {
  analyzeLocalResourceUsage,
  runtimeEnvironmentOf,
} from "../src/runtimeEnvironment";
import { SourceMetadata } from "../src/sourceMetadata";
import { analyzeWholeProgramObjects } from "../src/wholeProgramObjects";
import { analyzeWholeProgramFields } from "../src/wholeProgramFields";
import { analyzeLua } from "./lib/optimizerHarness";

function specialize(values: number[], activeLocals = 0) {
  const locals =
    activeLocals === 0
      ? ""
      : `local ${Array.from({ length: activeLocals }, (_, index) => `v${String(index)}`).join(",")} `;
  const source = `${locals}local function f(x) return x end consume(${values.map((value) => `f(${String(value)})`).join(",")})`;
  const { chunk, resolved, analysis } = analyzeLua(source);
  const objects = analyzeWholeProgramObjects(
    [{ name: "main", chunk, resolved, analysis }],
    0,
  );
  const usage = analyzeLocalResourceUsage(chunk);
  return applyAggregateSpecialization(
    objects,
    analyzeWholeProgramFields(objects),
    [
      {
        name: "main",
        chunk,
        resolved,
        metadata: new SourceMetadata(chunk, source),
        maxIntroducedLocalsAt: (statement) =>
          Math.max(
            0,
            runtimeEnvironmentOf("lua53").resources.maxActiveLocalsPerFunction -
              (usage.activeLocalsBefore(statement) ?? 0),
          ),
      },
    ],
  );
}

describe("resource budget diagnostics", () => {
  test("reports the 128 variant cap separately from runtime limits", () => {
    const result = specialize(
      Array.from({ length: 129 }, (_, index) => [index, index]).flat(),
    );
    expect(result.createdVariants).toBe(128);
    expect(
      result.diagnostics
        .filter((item) => item.reason !== "variant-created")
        .map((item) => item.reason),
    ).toEqual(["specialization-variant-limit"]);
  });
  test("shares a variant above the former 2048 site cap", () => {
    const result = specialize(Array<number>(2049).fill(1));
    expect(result.createdVariants).toBe(1);
    expect(result.replacedCalls).toBe(2049);
    expect(result.diagnostics.map((item) => item.reason)).toEqual([
      "variant-created",
    ]);
  });
  test("reports Lua local exhaustion separately from search caps", () => {
    // f occupies one local; another 199 locals are live at the insertion site.
    const result = specialize([1, 1], 199);
    expect(result.createdVariants).toBe(0);
    expect(result.diagnostics.map((item) => item.reason)).toEqual([
      "runtime-resource-limit",
    ]);
  });
});
