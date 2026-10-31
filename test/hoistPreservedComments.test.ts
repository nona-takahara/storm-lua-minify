import Parser from "luaparse";
import { SourceMapConsumer } from "source-map";
import { describe, expect, test } from "vitest";
import { createCliProgram } from "../src/cliOptions";
import { parseConfiguration } from "../src/config";
import { minifyTemporaryLuaProject } from "./lib/minifierHarness";

const files = {
  "dependency.lua": `
--# dependency header
local M={}
function M.run() return 1 end --# dependency trailing
return M
`,
  "main.lua": `
--# entry header
local dependency=require("dependency")
--# before call
print(dependency.run()) --# after call
--# after module
`,
};

function headLines(code: string): string[] {
  return code.split("\n").filter((line) => line.startsWith("--#"));
}

describe("hoisting preserved comments", () => {
  test("moves --# comments to the top, entry module first", () => {
    const { code } = minifyTemporaryLuaProject(files, {
      requireWrapper: true,
      localDeclarationMerging: false,
    });

    const comments = [
      "--# entry header",
      "--# before call",
      "--# after call",
      "--# after module",
      "--# dependency header",
      "--# dependency trailing",
    ];
    expect(code.startsWith(comments.join("\n") + "\n")).toBe(true);
    expect(headLines(code)).toEqual(comments);
    // コメント、require関数の定義、本文の順に並ぶ
    expect(code.slice(comments.join("\n").length + 1)).toMatch(
      /^function\s+require\(/,
    );
    expect(code.indexOf("print(")).toBeGreaterThan(
      code.indexOf("package.loaded"),
    );
    expect(() => Parser.parse(code, { luaVersion: "5.3" })).not.toThrow();
  });

  test("maps a hoisted comment back to where it was written", async () => {
    const { code, map } = minifyTemporaryLuaProject(files, {
      requireWrapper: true,
      localDeclarationMerging: false,
    });
    const lines = code.split("\n");
    const line = lines.indexOf("--# before call") + 1;
    expect(line).toBeGreaterThan(0);
    await SourceMapConsumer.with(map, null, (consumer) => {
      const origin = consumer.originalPositionFor({ line, column: 0 });
      expect(origin.source).toBe("main.lua");
      // files["main.lua"]は改行で始まるため、`--# before call`は4行目にある
      expect(origin.line).toBe(4);
    });
  });

  test("keeps each comment where it was written when hoisting is off", () => {
    const { code } = minifyTemporaryLuaProject(files, {
      requireWrapper: true,
      hoistPreservedComments: false,
      localDeclarationMerging: false,
    });

    expect(code.startsWith("--#")).toBe(false);
    expect(code).toMatch(/--# before call\nprint\(/);
    expect(code.indexOf("--# dependency header")).toBeLessThan(
      code.indexOf("--# entry header"),
    );
    expect(() => Parser.parse(code, { luaVersion: "5.3" })).not.toThrow();
  });

  test("emits a comment once when a module is printed more than once", () => {
    const { code } = minifyTemporaryLuaProject(
      {
        "dependency.lua": `--# once\nprint(1)`,
        "main.lua": `dofile("dependency")\ndofile("dependency")`,
      },
      { requireWrapper: false },
    );
    expect(code.match(/--# once/g)).toHaveLength(1);
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
