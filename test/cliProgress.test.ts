import { describe, expect, test } from "vitest";
import {
  CLI_PROGRESS_INTERVAL_MS,
  CliProgress,
  progressEnabled,
} from "../src/cliProgress";

class Output {
  readonly writes: string[] = [];

  constructor(readonly isTTY: boolean) {}

  write(text: string): void {
    this.writes.push(text);
  }
}

describe("CLI compilation progress", () => {
  test("throttles TTY redraws using the configured interval", () => {
    let now = 0;
    const output = new Output(true);
    const progress = new CliProgress({
      fileName: "/project/main.lua",
      fileIndex: 1,
      fileCount: 2,
      output,
      now: () => now,
    });

    progress.addSteps(3);
    progress.startStep("Parse modules");
    const initialWrites = [...output.writes];
    expect(initialWrites.length).toBeGreaterThan(0);
    expect(initialWrites.join("").trim()).not.toBe("");

    for (let index = 0; index < 100; index++) progress.tick();
    now = CLI_PROGRESS_INTERVAL_MS - 1;
    progress.tick();
    expect(output.writes).toEqual(initialWrites);

    now = CLI_PROGRESS_INTERVAL_MS;
    progress.tick();
    expect(output.writes.length).toBeGreaterThan(initialWrites.length);
    expect(output.writes.at(-1)?.trim()).not.toBe("");
  });

  test("continues redrawing an unchanged step while compilation advances", () => {
    let now = 0;
    const output = new Output(true);
    const progress = new CliProgress({
      fileName: "main.lua",
      fileIndex: 1,
      fileCount: 1,
      output,
      now: () => now,
    });
    progress.addSteps(1);
    progress.startStep("Compile");

    for (const timestamp of [1, 2, 3, 4].map(
      (frame) => frame * CLI_PROGRESS_INTERVAL_MS,
    )) {
      now = timestamp;
      const before = output.writes.length;
      progress.tick();
      expect(output.writes.length).toBeGreaterThan(before);
    }

    expect(output.writes.every((write) => write.trim().length > 0)).toBe(true);
  });

  test("logs step boundaries but ignores ticks outside a TTY", () => {
    const output = new Output(false);
    const progress = new CliProgress({
      fileName: "main.lua",
      fileIndex: 1,
      fileCount: 1,
      output,
      now: () => 1000,
    });

    progress.addSteps(1);
    progress.startStep("Compile");
    const beforeTicks = [...output.writes];
    progress.tick();
    progress.tick();
    expect(output.writes).toEqual(beforeTicks);
    progress.finish(["main.min.lua", "main.lua.map"], 1250);
    expect(output.writes.length).toBeGreaterThan(beforeTicks.length);
    const text = output.writes.join("");
    expect(text).not.toContain("\r");
    expect(text).not.toContain("\x1b");
    expect(text.endsWith("\n")).toBe(true);
  });

  test("lets an explicit switch override TTY detection", () => {
    expect(progressEnabled(undefined, new Output(true))).toBe(true);
    expect(progressEnabled(undefined, new Output(false))).toBe(false);
    expect(progressEnabled(false, new Output(true))).toBe(false);
    expect(progressEnabled(true, new Output(false))).toBe(true);
  });

  test("accepts more discovered work and reports subsequent steps", () => {
    const output = new Output(false);
    const progress = new CliProgress({
      fileName: "main.lua",
      fileIndex: 1,
      fileCount: 1,
      output,
    });

    progress.addSteps(1);
    progress.startStep("Trial");
    progress.addSteps(2);
    const beforeStep = output.writes.length;
    progress.startStep("Baseline");
    expect(output.writes.length).toBeGreaterThan(beforeStep);
    expect(output.writes.at(-1)?.trim()).not.toBe("");
  });

  test.each(["finish", "fail"] as const)(
    "%s closes an active terminal line",
    (outcome) => {
      const output = new Output(true);
      const progress = new CliProgress({
        fileName: "main.lua",
        fileIndex: 1,
        fileCount: 1,
        output,
      });
      progress.startStep("Compile");
      output.writes.length = 0;
      if (outcome === "finish") progress.finish(["main.min.lua"], 10);
      else progress.fail();
      expect(output.writes.join("").trim()).not.toBe("");
      expect(output.writes.join("").endsWith("\n")).toBe(true);
    },
  );
});
