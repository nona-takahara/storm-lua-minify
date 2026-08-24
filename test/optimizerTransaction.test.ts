import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, test } from "vitest";
import { selectTransactionalMinifierVariant } from "../src/optimizerTransaction";

const temporaryDirectories: string[] = [];

afterEach(() => {
  temporaryDirectories.splice(0).forEach((directory) => {
    fs.rmSync(directory, { recursive: true, force: true });
  });
});

function fixture(source: string): string {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "storm-optimizer-transaction-"),
  );
  temporaryDirectories.push(directory);
  const entry = path.join(directory, "main.lua");
  fs.writeFileSync(entry, source);
  return entry;
}

describe("transactional final-output selection", () => {
  test("selects a strictly shorter effect-aware final artifact", () => {
    const entryFilePath = fixture(`
local t={x=1,y=2}
local first=t.x
tick()
local second=t.y
use(first,second)
`);
    const result = selectTransactionalMinifierVariant({
      entryFilePath,
      luaParseSettings: { luaVersion: "5.3" },
      baselineMode: {
        moduleLikeLua: false,
        runtimeProfile: "stormworks",
        effectAwareTransforms: false,
      },
      trialMode: {
        moduleLikeLua: false,
        runtimeProfile: "stormworks",
      },
    });
    expect(result.accepted).toBe(true);
    expect(result.byteSavings).toBeGreaterThan(0);
    expect(result.selected).toEqual(result.trial);
  });

  test("keeps baseline and its source map when trial is not shorter", () => {
    const entryFilePath = fixture(
      "--# preserved\nlocal descriptive=1 return descriptive",
    );
    const result = selectTransactionalMinifierVariant({
      entryFilePath,
      luaParseSettings: { luaVersion: "5.3" },
      baselineMode: { moduleLikeLua: false, rename: true },
      trialMode: { moduleLikeLua: false, rename: false },
    });
    expect(result).toMatchObject({ accepted: false, reason: "not-shorter" });
    expect(result.selected).toEqual(result.baseline);
    expect(result.selected.code).toContain("--# preserved");
    expect(JSON.parse(result.selected.sourceMap).sources).toContain("main.lua");
  });

  test("remains deterministic across modules", () => {
    const entryFilePath = fixture('local child=require("child") return child');
    fs.writeFileSync(
      path.join(path.dirname(entryFilePath), "child.lua"),
      "local value=1 return value",
    );
    const request = {
      entryFilePath,
      luaParseSettings: { luaVersion: "5.3" as const },
      baselineMode: { moduleLikeLua: true },
      trialMode: { moduleLikeLua: true },
    };
    const first = selectTransactionalMinifierVariant(request);
    const second = selectTransactionalMinifierVariant(request);
    expect(first).toEqual(second);
    expect(first).toMatchObject({ accepted: false, reason: "not-shorter" });
  });

  test("isolates a trial failure from the selected baseline", () => {
    const entryFilePath = fixture("local value=1 return value");
    const failingReservedNames = {
      [Symbol.iterator](): Iterator<string> {
        throw new Error("trial-only failure");
      },
    } as ReadonlySet<string>;
    const result = selectTransactionalMinifierVariant({
      entryFilePath,
      luaParseSettings: { luaVersion: "5.3" },
      baselineMode: { moduleLikeLua: false },
      trialMode: {
        moduleLikeLua: false,
        neverRenameGlobals: failingReservedNames,
      },
    });
    expect(result).toMatchObject({ accepted: false, reason: "trial-failed" });
    expect(result.selected).toEqual(result.baseline);
  });
});
