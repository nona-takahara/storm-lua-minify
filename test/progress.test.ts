import path from "path";
import { describe, expect, test } from "vitest";
import { Minifier } from "../src/minifier";
import { CompilationProgress } from "../src/progress";

class RecordingProgress implements CompilationProgress {
  total = 0;
  current = 0;
  ticks = 0;
  readonly labels: string[] = [];

  addSteps(count: number): void {
    this.total += count;
  }

  startStep(label: string): void {
    this.current++;
    this.labels.push(label);
  }

  tick(): void {
    this.ticks++;
  }
}

describe("minifier progress", () => {
  test("reports monotonic work without changing generated output", () => {
    const input = path.join(__dirname, "fixtures", "single-file", "main.lua");
    const parseSettings = {
      locations: true,
      luaVersion: "5.3" as const,
      ranges: true,
      scope: true,
    };
    const progress = new RecordingProgress();

    const observed = new Minifier(input, parseSettings, {}, progress)
      .parse()
      .toString();
    const unobserved = new Minifier(input, parseSettings, {})
      .parse()
      .toString();

    expect(observed).toBe(unobserved);
    expect(progress.current).toBe(progress.total);
    expect(progress.ticks).toBeGreaterThan(0);
    expect(progress.labels).toContain("Load and parse modules");
    expect(progress.labels).toContain("Generate Lua and source map");
  });
});
