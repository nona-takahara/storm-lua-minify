import { SourceMapConsumer } from "source-map";
import { describe, expect, test } from "vitest";
import { MinifierMode } from "../src/minifier";
import {
  minifyTemporaryLuaProject,
  minifyTemporaryLuaSource,
} from "./lib/minifierHarness";

const mode: MinifierMode = {
  runtimeProfile: "stormworks",
  requiredWhitespace: " ",
  globalAliasing: false,
};

function fixedPoint(source: string, options: MinifierMode = {}) {
  const first = minifyTemporaryLuaSource(source, { ...mode, ...options });
  const second = minifyTemporaryLuaSource(first.code, { ...mode, ...options });
  expect(second.code).toBe(first.code);
  return first;
}

describe("transform reentry", () => {
  test("revisits deferred tail inline with a new Resolve", () => {
    const result = fixedPoint(
      "local function a(x)return x+1 end local function b(x)return a(x) end return b(2)",
    );
    expect(result.code).toBe("do return 2+1 end");
  });
  test("revisits inline after fold and unused local removal", () => {
    expect(
      fixedPoint("local function f()local x=1+2 return x end return f()+0", {
        constantOptimizations: true,
      }).code,
    ).toBe("return 3");
  });
  test("revisits summary constants with function rewrites disabled", () => {
    expect(
      fixedPoint("local function a()return 1+2 end local x=a() return x", {
        constantOptimizations: true,
        functionOptimizations: false,
      }).code,
    ).toBe("return 3");
  });
  test("revisits specialization after actual arguments become constant", () => {
    const result = fixedPoint(
      "local flag=true local function f(x)if x then return 1 end return 2 end return f(flag)+f(flag)",
      { constantOptimizations: true },
    );
    expect(result.code).toContain("if true then");
    expect(result.code).not.toContain("(true)");
  });
  test("finishes specialization of multiple constant parameters", () => {
    const result = fixedPoint(
      "local flag=true local function f(x,y)if x then return y end return 2 end return f(flag,3)+f(flag,3)",
      { constantOptimizations: true },
    );
    expect(result.code).not.toContain("(true");
  });
  test("reuses an existing specialization when more actuals become constant", () => {
    const result = fixedPoint(
      "local flag=true local function f(x)if x then return 1 end return 2 end return f(true)+f(true)+f(flag)+f(flag)",
      { constantOptimizations: true },
    );
    expect(result.code.match(/function/g)).toHaveLength(1);
    expect(result.code).not.toContain("(true)");
  });
  test("revisits a nested callable copied by tail inline without creating a new root", () => {
    const result = fixedPoint(
      "local function outer()local flag=true local function f(x)if x then return 1 end return 2 end return f(flag)+f(flag) end return outer()",
      { constantOptimizations: true },
    );
    expect(result.code).not.toContain("(true)");
  });
  test("preserves annotations and source origins across reentry", async () => {
    const source =
      "--# preserved\n--@storm keep\nlocal function kept(x)return x end\nlocal function a(x)return x+1 end\nlocal function b(x)return a(x) end\nreturn b(2)";
    const result = minifyTemporaryLuaSource(source, mode);
    expect(result.code).toContain("--# preserved");
    expect(result.code).toContain("function");
    await SourceMapConsumer.with(result.map, null, (consumer) => {
      expect(
        consumer.sources.map((name) => consumer.sourceContentFor(name)),
      ).toContain(source);
      const line = result.code
        .split("\n")
        .findIndex((text) => text.includes("2+1"));
      const column = result.code.split("\n")[line].indexOf("+1");
      expect(
        consumer.originalPositionFor({ line: line + 1, column }).line,
      ).toBe(4);
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
    expect(result.code).not.toContain("1+2");
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
      const result = fixedPoint(
        `local flag=1 local function f(${parameters.join(",")})${body} return 2 end return f(${arguments_})+f(${arguments_})`,
        { constantOptimizations: true },
      );
      expect(result.code).toMatch(/function \w+\(\)/);
      expect(result.code).not.toContain("(true");
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
      expect(
        fixedPoint(
          `${functions.join(" ")} local x=f${String(depth - 1)}() return x`,
          { constantOptimizations: true, functionOptimizations: false },
        ).code,
      ).toBe("return 3");
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
      const result = fixedPoint(
        `${functions.join(" ")} return f${String(depth - 1)}(2)`,
        { constantOptimizations: true },
      );
      expect(result.code).not.toContain("function");
    },
  );
});
