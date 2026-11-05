import path from "path";
import { describe, expect, test } from "vitest";
import { Minifier } from "../src/minifier";
import { CompilationProgress } from "../src/progress";

class RecordingProgress implements CompilationProgress {
  total = 0;
  current = 0;
  ticks = 0;
  readonly steps: { current: number; total: number }[] = [];

  addSteps(count: number): void {
    this.total += count;
    this.steps.push({ current: this.current, total: this.total });
  }

  startStep(): void {
    this.current++;
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
    "reports valid work without changing $fixture output or source map",
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
      for (const step of progress.steps) {
        expect(Number.isInteger(step.current)).toBe(true);
        expect(Number.isInteger(step.total)).toBe(true);
        expect(step.current).toBeGreaterThanOrEqual(0);
        expect(step.current).toBeLessThanOrEqual(step.total);
      }
      expect(progress.steps.length + progress.ticks).toBeGreaterThan(0);
    },
  );
});
