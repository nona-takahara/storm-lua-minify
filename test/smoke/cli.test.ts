import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Parser from "luaparse";
import { afterEach, describe, expect, test } from "vitest";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("installed command smoke test", () => {
  test("minifies one Lua file and emits a usable source map", () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "storm-lua-minify-smoke-"),
    );
    temporaryDirectories.push(directory);
    const input = path.join(directory, "main.lua");
    fs.writeFileSync(input, "local answer = 40 + 2\nprint(answer)\n");

    execFileSync(process.execPath, [path.resolve("dist/cli.js"), input], {
      cwd: directory,
      encoding: "utf8",
      stdio: "pipe",
      timeout: 4_000,
    });

    const output = path.join(directory, "main.min.lua");
    const sourceMap = path.join(directory, "main.lua.map");
    expect(fs.existsSync(output)).toBe(true);
    expect(fs.existsSync(sourceMap)).toBe(true);
    expect(() =>
      Parser.parse(fs.readFileSync(output, "utf8"), { luaVersion: "5.3" }),
    ).not.toThrow();
    expect(JSON.parse(fs.readFileSync(sourceMap, "utf8"))).toMatchObject({
      file: "main.min.lua",
      sources: ["main.lua"],
    });
  });
});
