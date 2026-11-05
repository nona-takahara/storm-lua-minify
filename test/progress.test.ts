import path from "path";
import { describe, expect, test } from "vitest";
import { Minifier } from "../src/minifier";
import { CompilationProgress } from "../src/progress";

class RecordingProgress implements CompilationProgress {
  total = 0;
  current = 0;
  ticks = 0;
  readonly labels: string[] = [];
  readonly steps: { current: number; total: number }[] = [];

  addSteps(count: number): void {
    this.total += count;
    this.steps.push({ current: this.current, total: this.total });
  }

  startStep(label: string): void {
    this.current++;
    this.labels.push(label);
    this.steps.push({ current: this.current, total: this.total });
  }

  tick(): void {
    this.ticks++;
  }
}

describe("minifier progress", () => {
  test.each([
    { fixture: "single-file", requireWrapper: false },
    { fixture: "require-call", requireWrapper: true },
  ])(
    "reports monotonic work without changing $fixture output or source map",
    ({ fixture, requireWrapper }) => {
      const input = path.join(__dirname, "fixtures", fixture, "main.lua");
      const parseSettings = {
        locations: true,
        luaVersion: "5.3" as const,
        ranges: true,
        scope: true,
      };
      const progress = new RecordingProgress();
      const mode = {
        runtimeProfile: "stormworks" as const,
        allowIntrospectionChanges: true,
        requireWrapper,
      };

      const observed = new Minifier(input, parseSettings, mode, progress)
        .parse()
        .toStringWithSourceMap({ file: "main.min.lua" });
      const unobserved = new Minifier(input, parseSettings, mode)
        .parse()
        .toStringWithSourceMap({ file: "main.min.lua" });

      expect(observed.code).toBe(unobserved.code);
      expect(observed.map.toJSON()).toEqual(unobserved.map.toJSON());
      let previous = { current: 0, total: 0 };
      for (const step of progress.steps) {
        expect(step.current).toBeGreaterThanOrEqual(previous.current);
        expect(step.total).toBeGreaterThanOrEqual(previous.total);
        expect(step.current).toBeLessThanOrEqual(step.total);
        previous = step;
      }
      expect(progress.current).toBe(progress.total);
      expect(progress.ticks).toBeGreaterThan(0);
      expect(progress.labels).toContain("Load and parse modules");
      expect(progress.labels).toContain("Generate Lua and source map");
      expect(progress.labels).toContain("Evaluate joint cost-gated trial");
      const evaluatedVariants = progress.labels.filter(
        (label) => label === "Load and parse modules",
      ).length;
      expect(evaluatedVariants).toBe(1);
    },
  );
});
