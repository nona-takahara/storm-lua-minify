import fs from "fs";
import os from "os";
import path from "path";
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
    path.join(os.tmpdir(), "storm-local-run-planner-test-"),
  );
  temporaryDirectories.push(directory);
  const entry = path.join(directory, "main.lua");
  fs.writeFileSync(entry, source);
  return new Minifier(
    entry,
    { locations: true, luaVersion: "5.3", ranges: true, scope: true },
    { moduleLikeLua: false, requiredWhitespace: " ", ...mode },
  )
    .parse()
    .toStringWithSourceMap({ file: "main.min.lua" }).code;
}

describe("Issue #42 local-run planner profiles", () => {
  test("keeps pure-Lua independent merging as an opt-out", () => {
    const source = "local first=f() local second=g() use(first,second)";
    const enabled = minify(source, {
      runtimeProfile: "lua53",
      rename: false,
    });
    const disabled = minify(source, {
      runtimeProfile: "lua53",
      rename: false,
      mergeLocals: false,
    });

    expect(enabled).toBe("local first,second=f(),g()use(first,second)");
    expect(Buffer.byteLength(enabled)).toBeLessThan(
      Buffer.byteLength(disabled),
    );
  });

  test("separates dependent initializers by default only in Stormworks", () => {
    const source = "local a=f() local b=g(a) use(a,b)";
    const stormworks = minify(source, {
      runtimeProfile: "stormworks",
      rename: false,
    });
    const optedOut = minify(source, {
      runtimeProfile: "stormworks",
      rename: false,
      effectAwareLocalHoist: false,
    });
    const lua = minify(source, { runtimeProfile: "lua53", rename: false });

    expect(stormworks).toBe("local a,b=f()b=g(a)use(a,b)");
    expect(optedOut).toBe(lua);
    expect(Buffer.byteLength(stormworks)).toBeLessThan(
      Buffer.byteLength(optedOut),
    );
  });

  test("moves dirty table reads only with the explicit aggressive opt-in", () => {
    const source =
      "local tableValue={x=1} local before=tableValue.x tableValue.x=2 local after=tableValue.x use(before,after)";
    const safe = minify(source, {
      runtimeProfile: "stormworks",
      rename: false,
    });
    const aggressive = minify(source, {
      runtimeProfile: "stormworks",
      rename: false,
      aggressiveTableReadMerges: true,
    });

    expect(safe.replace(/\s+/g, " ")).toContain(
      "tableValue.x=2 local after=tableValue.x",
    );
    expect(aggressive.replace(/\s+/g, " ")).toContain(
      "local before,after=tableValue.x,tableValue.x tableValue.x=2",
    );
    expect(Buffer.byteLength(aggressive)).toBeLessThan(Buffer.byteLength(safe));
  });
});
