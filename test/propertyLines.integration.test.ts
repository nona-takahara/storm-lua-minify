import assert from "node:assert/strict";
import { describe, test } from "vitest";
import Parser from "luaparse";
import { SourceMapConsumer } from "source-map";
import { walkBlockDeep } from "../src/astWalk";
import { resolveScopes } from "../src/resolver";
import { MinifierMode } from "../src/minifier";
import { LUAPARSE_SETTINGS } from "./lib/helpers";
import { executeLua } from "./lib/luaExecution";
import {
  minifyTemporaryLuaProject,
  minifyTemporaryLuaSource,
} from "./lib/minifierHarness";

const settings = `g_savedata = {
  recommendedSettings = property.checkbox("Start with no wind and damage", true),
  cheatBattery = property.checkbox("Enable cheat_battery feature", true)
}`;
const mode: MinifierMode = {
  runtimeProfile: "stormworks",
  requireWrapper: false,
  requiredWhitespace: " ",
};

function propertyCallLines(code: string): number[] {
  const ast = Parser.parse(code, LUAPARSE_SETTINGS);
  const resolved = resolveScopes(ast);
  const lines: number[] = [];
  walkBlockDeep(ast.body, {
    onExpression(expression) {
      if (
        (expression.type === "CallExpression" ||
          expression.type === "TableCallExpression" ||
          expression.type === "StringCallExpression") &&
        (expression.base.type === "MemberExpression" ||
          expression.base.type === "IndexExpression") &&
        expression.base.base.type === "Identifier" &&
        expression.base.base.name === "property" &&
        resolved.isGlobalReference(expression.base.base)
      ) {
        assert.ok(expression.loc);
        lines.push(expression.loc.start.line);
      }
    },
  });
  return lines;
}

function assertSeparated(code: string, count: number): void {
  const lines = propertyCallLines(code);
  assert.equal(lines.length, count, code);
  assert.equal(new Set(lines).size, count, code);
}

describe("Stormworks property call lines", () => {
  for (const variant of [
    { name: "default whitespace", options: { requiredWhitespace: undefined } },
    { name: "space whitespace", options: {} },
    { name: "all optimizations", options: { optimizations: true } },
    { name: "no optimizations", options: { optimizations: false } },
  ]) {
    test(`separates settings without a trailing comma: ${variant.name}`, () => {
      const { code } = minifyTemporaryLuaSource(settings, {
        ...mode,
        ...variant.options,
      });
      assertSeparated(code, 2);
      assert.doesNotMatch(code, /,\s*}/);
    });
  }

  test("separates calls within a field, nested tables, keys, arguments and statements", () => {
    const { code } = minifyTemporaryLuaSource(
      `result = {
        combined = property.slider("a", 1) + property.slider("b", 2),
        nested = {property.checkbox("c", true), property.checkbox("d", false)},
        [property.getText("key")] = consume(property.getNumber("e"), property.getBool("f")),
        outer = property.checkbox(property.getText("g"), true)
      }
      property.checkbox("h", true)
      property.slider("i", 3)`,
      { ...mode, optimizations: true },
    );
    assertSeparated(code, 11);
  });

  test("separates string, table, colon and indexed call syntax without rewriting it", () => {
    const { code } = minifyTemporaryLuaSource(
      `consume(property.getText "a", property.checkbox{}, property:slider(1), property["checkbox"]("b", true))`,
      mode,
    );
    assertSeparated(code, 4);
    assert.match(code, /property\["checkbox"\]/);
    assert.match(code, /property:slider/);
  });

  test("keeps frequent property references out of generated global aliases", () => {
    const { code } = minifyTemporaryLuaSource(
      Array.from(
        { length: 10 },
        (_, i) => `property.checkbox("${String(i)}", true)`,
      ).join("\n"),
      { ...mode, globalAliasing: true, optimizations: true },
    );
    assertSeparated(code, 10);
    assert.doesNotMatch(code, /local\s+\w+\s*=\s*property/);
  });

  test("keeps property spelling when the global is assigned and global renaming is enabled", () => {
    const { code } = minifyTemporaryLuaSource(
      `property = suppliedProperty\n${settings}`,
      { ...mode, globalRenaming: true },
    );
    assertSeparated(code, 2);
    assert.match(code, /property=suppliedProperty/);
  });

  test("separates calls after function inlining and declaration packing", () => {
    const { code } = minifyTemporaryLuaSource(
      `local function firstSetting() return property.checkbox("first",true) end
       local function secondSetting() return property.checkbox("second",true) end
       local first=firstSetting()
       local second=secondSetting()
       consume(first,second)`,
      { ...mode, optimizations: true },
    );
    assertSeparated(code, 2);
    assert.doesNotMatch(code, /function/);
  });

  for (const requireWrapper of [false, true]) {
    test(`separates calls across linked modules (wrapper=${String(requireWrapper)})`, () => {
      const { code } = minifyTemporaryLuaProject(
        {
          "main.lua": `local first=require("settings")\nconsume(first,property.checkbox("main",true))`,
          "settings.lua": `return {property.checkbox("dep1",true),property.checkbox("dep2",true)}`,
        },
        { ...mode, requireWrapper, optimizations: true },
      );
      assertSeparated(code, 3);
    });
  }

  test("does not apply the line constraint to the Lua profile", () => {
    const { code } = minifyTemporaryLuaSource(settings, {
      ...mode,
      runtimeProfile: "lua53",
    });
    assert.equal(new Set(propertyCallLines(code)).size, 1);
    assert.doesNotMatch(code, /,\s*}/);
  });

  test("distinguishes local and parameter shadowing, member names, strings and comments", () => {
    const source = `--# property.checkbox("comment", true)
      local property = supplied
      result = {property.checkbox("a", true), property.checkbox("b", true)}
      function run(property) return property.checkbox("c", true), property.checkbox("d", true) end
      result2 = {object.property.checkbox("e",true), "property.checkbox('text')"}`;
    const options = { ...mode, optimizations: false, localRenaming: false };
    const storm = minifyTemporaryLuaSource(source, options).code;
    const lua = minifyTemporaryLuaSource(source, {
      ...options,
      runtimeProfile: "lua53",
    }).code;
    assert.equal(storm, lua);
    assert.equal(propertyCallLines(storm).length, 0);
    assert.doesNotMatch(storm, /,\s*}/);
  });

  test("does not add trailing commas for strings or local property calls", () => {
    const { code } = minifyTemporaryLuaSource(
      `local property=supplied\nconsume({"property"},{property.checkbox("a",true)})`,
      { ...mode, optimizations: false },
    );
    assert.doesNotMatch(code, /,\s*}/);
  });

  test("maps both calls to their original tokens after inserting newlines", async () => {
    const { code, map } = minifyTemporaryLuaSource(settings, mode);
    assertSeparated(code, 2);
    await SourceMapConsumer.with(map, null, (consumer) => {
      for (const [i, originalLine] of [2, 3].entries()) {
        const generatedLine = propertyCallLines(code)[i];
        const column = code.split("\n")[generatedLine - 1].indexOf("property");
        const origin = consumer.originalPositionFor({
          line: generatedLine,
          column,
        });
        assert.equal(origin.source, "main.lua");
        assert.equal(origin.line, originalLine);
        assert.equal(
          origin.column,
          settings.split("\n")[originalLine - 1].indexOf("property"),
        );
        assert.equal(origin.name, "property");
      }
    });
  });

  test("preserves Lua evaluation order, side effects and multiple return values", () => {
    const source = `local function identity(...) return ... end
      local a,b=property.slider("first",1),property.slider("second",2)
      local nested=property.checkbox(property.getText("nested"),true)
      local x,y=identity(property.slider("third",3),property.slider("fourth",4))
      print(a,b,nested,x,y)`;
    const result = minifyTemporaryLuaSource(source, {
      ...mode,
      optimizations: true,
    });
    assertSeparated(result.code, 6);
    const prelude = `property=setmetatable({}, {__index=function(_,method)
      return function(name,value) print(method,name,value) return value or name,99 end
    end})\n`;
    const stdout =
      "slider\tfirst\t1\nslider\tsecond\t2\ngetText\tnested\tnil\ncheckbox\tnested\ttrue\nslider\tthird\t3\nslider\tfourth\t4\n1\t2\ttrue\t3\t4\n";
    const expected = { status: 0, stdout, stderr: "" };
    assert.deepEqual(executeLua(prelude + source), expected);
    assert.deepEqual(executeLua(prelude + result.code), expected);
  });
});
