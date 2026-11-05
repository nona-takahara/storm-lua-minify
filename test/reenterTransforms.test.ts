import { SourceMapConsumer } from "source-map";
import { describe, expect, test } from "vitest";
import { MinifierMode } from "../src/minifier";
import { executeLua } from "./lib/luaExecution";
import { expectLuaProjectOutput } from "./lib/luaProjectAssertions";
import Parser from "luaparse";
import { walkBlockDeep } from "../src/astWalk";
import {
  minifyTemporaryLuaProject,
  minifyTemporaryLuaSource,
} from "./lib/minifierHarness";

const mode: MinifierMode = {
  runtimeProfile: "stormworks",
  requiredWhitespace: " ",
  globalAliasing: false,
};

function fixedPoint(
  source: string,
  stdout: string,
  options: MinifierMode = {},
) {
  const first = minifyTemporaryLuaSource(source, { ...mode, ...options });
  const second = minifyTemporaryLuaSource(first.code, { ...mode, ...options });
  expect(second.code).toBe(first.code);
  const expected = { status: 0, stdout, stderr: "" };
  const observe = (code: string) =>
    executeLua(`print(pcall(function()\n${code}\nend))`);
  expect(observe(source), "original program").toEqual(expected);
  expect(observe(first.code), "first compilation").toEqual(expected);
  expect(observe(second.code), "second compilation").toEqual(expected);
  return first;
}

describe("transform reentry", () => {
  test("revisits deferred tail inline with a new Resolve", () => {
    fixedPoint(
      "local function a(x)return x+1 end local function b(x)return a(x) end return b(2)",
      "true\t3\n",
    );
  });
  test("revisits inline after fold and unused local removal", () => {
    fixedPoint(
      "local function f()local x=1+2 return x end return f()+0",
      "true\t3\n",
      {
        constantOptimizations: true,
      },
    );
  });
  test("revisits summary constants with function rewrites disabled", () => {
    fixedPoint(
      "local function a()return 1+2 end local x=a() return x",
      "true\t3\n",
      {
        constantOptimizations: true,
        functionOptimizations: false,
      },
    );
  });
  test("revisits specialization after actual arguments become constant", () => {
    fixedPoint(
      "local flag=true local function f(x)if x then return 1 end return 2 end return f(flag)+f(flag)",
      "true\t2\n",
      { constantOptimizations: true },
    );
  });
  test("finishes specialization of multiple constant parameters", () => {
    fixedPoint(
      "local flag=true local function f(x,y)if x then return y end return 2 end return f(flag,3)+f(flag,3)",
      "true\t6\n",
      { constantOptimizations: true },
    );
  });
  test("preserves repeated calls when more actuals become constant", () => {
    fixedPoint(
      "local flag=true local function f(x)if x then return 1 end return 2 end return f(true)+f(true)+f(flag)+f(flag)",
      "true\t4\n",
      { constantOptimizations: true },
    );
  });
  test("preserves a nested callable copied by tail inline across recompilation", () => {
    fixedPoint(
      "local function outer()local flag=true local function f(x)if x then return 1 end return 2 end return f(flag)+f(flag) end return outer()",
      "true\t2\n",
      { constantOptimizations: true },
    );
  });
  test("preserves annotations and source origins across reentry", async () => {
    const source =
      "--# preserved\n--@storm keep\nlocal function kept(x)return x end\nlocal function a(x)return external(x) end\nlocal function b(x)return a(x) end\nreturn b(2)";
    const result = minifyTemporaryLuaSource(source, mode);
    expect(result.code).toContain("--# preserved");
    const ast = Parser.parse(result.code, {
      luaVersion: "5.3",
      locations: true,
    });
    expect(
      ast.body.some((statement) => statement.type === "FunctionDeclaration"),
    ).toBe(true);
    expectLuaProjectOutput(result, "true\t3\n", {
      prelude: "function external(x)return x+1 end",
    });
    await SourceMapConsumer.with(result.map, null, (consumer) => {
      expect(
        consumer.sources.map((name) => consumer.sourceContentFor(name)),
      ).toContain(source);
      let external: Parser.Identifier | undefined;
      walkBlockDeep(ast.body, {
        onIdentifierReference: (id) => {
          if (id.name === "external") external = id;
        },
      });
      if (!external?.loc) throw new Error("Missing observable external call");
      expect(consumer.originalPositionFor(external.loc.start)).toMatchObject({
        source: "main.lua",
        line: 4,
        name: "external",
        column: source.split("\n")[3].indexOf("external"),
      });
    });
  });
  test("keeps reentry inside the linked AST before module wrapping", () => {
    const result = minifyTemporaryLuaProject(
      {
        "main.lua": 'local value=require("value") return value',
        "value.lua": "local function f()local x=1+2 return x end return f()+0",
      },
      { ...mode, constantOptimizations: true, requireWrapper: true },
    );
    expectLuaProjectOutput(result, "true\t3\n");
    expect(result.map.sourcesContent).toHaveLength(2);
  });
  test.each([3, 10])(
    "finishes a %i-parameter specialization lineage without a pass limit",
    (depth) => {
      const parameters = Array.from(
        { length: depth },
        (_, i) => `p${String(i)}`,
      );
      const body = parameters
        .map((name) => `if ${name} then return 1 end`)
        .join(" ");
      const arguments_ = parameters.map(() => "flag").join(",");
      fixedPoint(
        `local flag=1 local function f(${parameters.join(",")})${body} return 2 end return f(${arguments_})+f(${arguments_})`,
        "true\t2\n",
        { constantOptimizations: true },
      );
    },
  );
  test.each([3, 10])(
    "finishes a %i-level summary and DCE chain with inline disabled",
    (depth) => {
      const functions = ["local function f0()return 1+2 end"];
      for (let i = 1; i < depth; i++)
        functions.push(
          `local function f${String(i)}()local x=f${String(i - 1)}()return x end`,
        );
      fixedPoint(
        `${functions.join(" ")} local x=f${String(depth - 1)}() return x`,
        "true\t3\n",
        { constantOptimizations: true, functionOptimizations: false },
      );
    },
  );
  test.each([3, 10])(
    "finishes a %i-level inline chain without a pass limit",
    (depth) => {
      const functions = ["local function f0(x)return x+1 end"];
      for (let i = 1; i < depth; i++)
        functions.push(
          `local function f${String(i)}(x)return f${String(i - 1)}(x) end`,
        );
      fixedPoint(
        `${functions.join(" ")} return f${String(depth - 1)}(2)`,
        "true\t3\n",
        { constantOptimizations: true },
      );
    },
  );
});
