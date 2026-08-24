import fs from "fs";
import os from "os";
import path from "path";
import Parser from "luaparse";
import { afterEach, describe, expect, test } from "vitest";
import { Minifier, MinifierMode } from "../src/minifier";

const temporaryDirectories: string[] = [];

afterEach(() => {
  temporaryDirectories.splice(0).forEach((directory) => {
    fs.rmSync(directory, { recursive: true, force: true });
  });
});

function minifyExact(source: string, mode: MinifierMode): string {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "storm-table-read-merge-test-"),
  );
  temporaryDirectories.push(directory);
  const entry = path.join(directory, "main.lua");
  fs.writeFileSync(entry, source);
  return new Minifier(
    entry,
    { locations: true, luaVersion: "5.3", ranges: true, scope: true },
    mode,
  )
    .parse()
    .toStringWithSourceMap({ file: "main.min.lua" }).code;
}

function minify(source: string, mode: Partial<MinifierMode> = {}): string {
  return minifyExact(source, {
    moduleLikeLua: false,
    runtimeProfile: "stormworks",
    ...mode,
  });
}

describe("effect-aware table read merge pipeline", () => {
  test("merges stable fresh-table reads and shortens valid output", () => {
    const source = `
local tableValue={x=1,y=2}
local first=tableValue.x
tick()
local second=tableValue.y
use(first,second)
`;
    const enabled = minify(source, { effectAwareLocalHoist: false });
    const disabled = minify(source, {
      effectAwareTableReads: false,
      effectAwareLocalHoist: false,
    });

    expect(Buffer.byteLength(enabled)).toBeLessThan(
      Buffer.byteLength(disabled),
    );
    expect(() => Parser.parse(enabled, { luaVersion: "5.3" })).not.toThrow();
  });

  test("field-sensitive mode crosses a different-key write", () => {
    const source = `
local tableValue={x=1}
local first=tableValue.x
tableValue.y=2
local second=tableValue.x
use(first,second)
`;
    const fieldSensitive = minify(source, { effectAwareLocalHoist: false });
    const wholeTable = minify(source, {
      fieldSensitiveTableEffects: false,
      effectAwareLocalHoist: false,
    });

    expect(Buffer.byteLength(fieldSensitive)).toBeLessThan(
      Buffer.byteLength(wholeTable),
    );
  });

  test("does not move reads for an escaped table", () => {
    const source = `
local tableValue={x=1,y=2}
local first=tableValue.x
consume(tableValue)
local second=tableValue.y
use(first,second)
`;
    expect(minify(source)).toBe(
      minify(source, { effectAwareTableReads: false }),
    );
  });

  test("master safe opt-out disables table read movement", () => {
    const source = `
local tableValue={x=1,y=2}
local first=tableValue.x
tick()
local second=tableValue.y
use(first,second)
`;
    expect(minify(source, { effectAwareTransforms: false })).toBe(
      minify(source, {
        effectAwareTableReads: false,
        effectAwareLocalHoist: false,
      }),
    );
  });

  test("keeps the API default conservative for pure Lua", () => {
    const source = `
local tableValue={x=1,y=2}
local first=tableValue.x
tick()
local second=tableValue.y
use(first,second)
`;
    const apiDefault = minifyExact(source, {
      moduleLikeLua: false,
      effectAwareLocalHoist: false,
    });
    const explicitLua = minifyExact(source, {
      moduleLikeLua: false,
      runtimeProfile: "lua53",
      effectAwareLocalHoist: false,
    });
    const optedInLua = minifyExact(source, {
      moduleLikeLua: false,
      runtimeProfile: "lua53",
      allowLocalLifetimeChanges: true,
      effectAwareLocalHoist: false,
    });

    expect(apiDefault).toBe(explicitLua);
    expect(Buffer.byteLength(optedInLua)).toBeLessThan(
      Buffer.byteLength(apiDefault),
    );
  });
});
