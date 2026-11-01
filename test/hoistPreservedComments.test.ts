import Parser from "luaparse";
import { SourceMapConsumer } from "source-map";
import { describe, expect, test } from "vitest";
import { createCliProgram } from "../src/cliOptions";
import { parseConfiguration } from "../src/config";
import { minifyTemporaryLuaProject } from "./lib/minifierHarness";

const files = {
  "dependency.lua": `--# dependency header
local M={}
function M.run() return 1 end --# dependency trailing
return M
`,
  "main.lua": `--# entry header
--
--# entry header, second
local dependency=require("dependency")

--# separated by a blank line
print(dependency.run()) --# after call
--# after module
`,
};

const mode = { requireWrapper: true, localDeclarationMerging: false };

function commentLines(code: string): string[] {
  return code.match(/--#[^\n]*/g) ?? [];
}

describe("hoisting preserved comments from the head of the entry file", () => {
  test("moves the unbroken comment run at the top of the entry file before the require wrapper", () => {
    const { code } = minifyTemporaryLuaProject(files, mode);

    const head = ["--# entry header", "--# entry header, second"];
    expect(code.startsWith(head.join("\n") + "\n")).toBe(true);
    // コメント、require関数の定義、本文の順に並ぶ
    expect(code.slice(head.join("\n").length + 1)).toMatch(
      /^function\s+require\(/,
    );
    // 移すのはエントリのファイルの先頭の塊だけで、残りは元の場所に残る
    expect(commentLines(code)).toEqual([
      ...head,
      "--# dependency header",
      "--# dependency trailing",
      "--# separated by a blank line",
      "--# after call",
      "--# after module",
    ]);
    expect(code.indexOf("--# dependency header")).toBeGreaterThan(
      code.indexOf("package.loaded"),
    );
    expect(code.indexOf("--# separated by a blank line")).toBeGreaterThan(
      code.indexOf("package.loaded"),
    );
    expect(() => Parser.parse(code, { luaVersion: "5.3" })).not.toThrow();
  });

  test("ends the run at a blank line", () => {
    const { code } = minifyTemporaryLuaProject(
      {
        "dependency.lua": `return {}`,
        "main.lua": `--# first
--# second

--# third
local d=require("dependency")
print(d)
`,
      },
      mode,
    );
    expect(code.startsWith("--# first\n--# second\nfunction")).toBe(true);
    expect(code.indexOf("--# third")).toBeGreaterThan(
      code.indexOf("package.loaded"),
    );
  });

  test("keeps going through plain comments and does not move one that follows code", () => {
    const { code } = minifyTemporaryLuaProject(
      {
        "dependency.lua": `return {}`,
        "main.lua": `-- plain
--# kept in the run
local d=require("dependency")
--# later
print(d)
`,
      },
      mode,
    );
    expect(code.startsWith("--# kept in the run\nfunction")).toBe(true);
    expect(code.indexOf("--# later")).toBeGreaterThan(
      code.indexOf("package.loaded"),
    );
  });

  test("starts the run even after leading blank lines", () => {
    const { code } = minifyTemporaryLuaProject(
      {
        "dependency.lua": `return {}`,
        "main.lua": `\n\n--# header\nlocal d=require("dependency")\nprint(d)\n`,
      },
      mode,
    );
    expect(code.startsWith("--# header\nfunction")).toBe(true);
  });

  test("maps a hoisted comment back to where it was written", async () => {
    const { code, map } = minifyTemporaryLuaProject(files, mode);
    const line = code.split("\n").indexOf("--# entry header, second") + 1;
    expect(line).toBeGreaterThan(0);
    await SourceMapConsumer.with(map, null, (consumer) => {
      const origin = consumer.originalPositionFor({ line, column: 0 });
      expect(origin.source).toBe("main.lua");
      expect(origin.line).toBe(3);
    });
  });

  test("keeps every comment where it was written when hoisting is off", () => {
    const { code } = minifyTemporaryLuaProject(files, {
      ...mode,
      hoistPreservedComments: false,
    });

    expect(code.startsWith("--#")).toBe(false);
    expect(code.indexOf("--# entry header")).toBeGreaterThan(
      code.indexOf("package.loaded"),
    );
    expect(() => Parser.parse(code, { luaVersion: "5.3" })).not.toThrow();
  });

  test("is configurable from the command line and a configuration file", () => {
    const parse = (...args: string[]) =>
      createCliProgram().parse(args, { from: "user" }).opts();
    expect(parse("main.lua").hoistPreservedComments).toBeUndefined();
    expect(parse("--hoist-preserved-comments").hoistPreservedComments).toBe(
      true,
    );
    expect(parse("--no-hoist-preserved-comments").hoistPreservedComments).toBe(
      false,
    );
    expect(
      parseConfiguration({ "hoist-preserved-comments": false }).mode
        .hoistPreservedComments,
    ).toBe(false);
  });
});
