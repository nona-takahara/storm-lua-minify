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

function minify(source: string, mode: Partial<MinifierMode>): string {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "storm-effect-locals-test-"),
  );
  temporaryDirectories.push(directory);
  const entry = path.join(directory, "main.lua");
  fs.writeFileSync(entry, source);
  return new Minifier(
    entry,
    { locations: true, luaVersion: "5.3", ranges: true, scope: true },
    { moduleLikeLua: false, ...mode },
  )
    .parse()
    .toStringWithSourceMap({ file: "main.min.lua" }).code;
}

const SOURCE = `
local first = makeFirst()
tick()
local second = makeSecond()
value = 1
local third = makeThird()
use(first, second, third)
`;

describe("effect-aware non-adjacent locals pipeline", () => {
  test("is enabled by default for Stormworks and produces shorter valid Lua", () => {
    const disabled = minify(SOURCE, {
      runtimeProfile: "stormworks",
      effectAwareTransforms: false,
    });
    const enabled = minify(SOURCE, { runtimeProfile: "stormworks" });

    expect(Buffer.byteLength(enabled)).toBeLessThan(
      Buffer.byteLength(disabled),
    );
    expect(() => Parser.parse(enabled, { luaVersion: "5.3" })).not.toThrow();
  });

  test("can be opted out in Stormworks", () => {
    expect(
      minify(SOURCE, {
        runtimeProfile: "stormworks",
        effectAwareTransforms: false,
      }),
    ).toBe(minify(SOURCE, { runtimeProfile: "lua53" }));
  });

  test("requires a separate local-lifetime opt-in for pure Lua", () => {
    const defaultLua = minify(SOURCE, { runtimeProfile: "lua53" });
    const optedInLua = minify(SOURCE, {
      runtimeProfile: "lua53",
      allowLocalLifetimeChanges: true,
    });

    expect(Buffer.byteLength(optedInLua)).toBeLessThan(
      Buffer.byteLength(defaultLua),
    );
  });

  test("does not run the lifetime opt-in when the safe transform master is off", () => {
    const output = minify(SOURCE, {
      runtimeProfile: "lua53",
      allowLocalLifetimeChanges: true,
      effectAwareTransforms: false,
    });

    expect(output).toBe(minify(SOURCE, { runtimeProfile: "lua53" }));
  });
});
