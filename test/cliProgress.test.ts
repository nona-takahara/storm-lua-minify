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
  test("redraws a TTY spinner only after 200 ms", () => {
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
    expect(output.writes).toEqual([
      "\r\x1b[2K| [1/2 files] main.lua — Step 1/3: Parse modules",
    ]);

    for (let index = 0; index < 100; index++) progress.tick();
    now = CLI_PROGRESS_INTERVAL_MS - 1;
    progress.tick();
    expect(output.writes).toHaveLength(1);

    now = CLI_PROGRESS_INTERVAL_MS;
    progress.tick();
    expect(output.writes.at(-1)).toContain(
      "/ [1/2 files] main.lua — Step 1/3: Parse modules",
    );
  });

  test("cycles through the ASCII spinner frames", () => {
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
      progress.tick();
    }

    expect(output.writes.map((write) => write[5])).toEqual([
      "|",
      "/",
      "-",
      "\\",
      "|",
    ]);
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
    progress.tick();
    progress.tick();
    progress.finish(["main.min.lua", "main.lua.map"], 1250);

    expect(output.writes).toEqual([
      "| [1/1 files] main.lua — Step 1/1: Compile\n",
      "[done] [1/1 files] main.lua (1.3 s) -> main.min.lua, main.lua.map\n",
    ]);
  });

  test("lets an explicit switch override TTY detection", () => {
    expect(progressEnabled(undefined, new Output(true))).toBe(true);
    expect(progressEnabled(undefined, new Output(false))).toBe(false);
    expect(progressEnabled(false, new Output(true))).toBe(false);
    expect(progressEnabled(true, new Output(false))).toBe(true);
  });

  test("allows the discovered total to grow without rewinding the current step", () => {
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
    progress.startStep("Baseline");

    expect(output.writes).toEqual([
      "| [1/1 files] main.lua — Step 1/1: Trial\n",
      "| [1/1 files] main.lua — Step 2/3: Baseline\n",
    ]);
  });
});
