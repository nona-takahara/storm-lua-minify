import { describe, expect, test } from "vitest";
import {
  minifyTemporaryLuaProject,
  minifyTemporaryLuaSource,
} from "./lib/minifierHarness";

const mode = {
  moduleLikeLua: true,
  runtimeProfile: "stormworks" as const,
  mergeLocals: false,
  effectAwareTransforms: false,
  globalAlias: false,
  collectOptimizationDiagnostics: true,
};

describe("whole-program field key shortening", () => {
  test("shares one key across member, colon, table, and static-index syntax", () => {
    const result = minifyTemporaryLuaSource(
      `
local object={long_value=4}
function object:long_method() return self.long_value end
local a=object.long_value
local b=object["long_value"]
return object:long_method()+a+b
`,
      mode,
    );

    expect(result.code).not.toContain("long_method");
    expect(result.code).not.toContain("long_value");
    expect(result.minifier.wholeProgramFieldRenames?.shortenedFields).toBe(2);
    expect(result.minifier.wholeProgramFieldRenames?.generation).toBe(
      result.minifier.wholeProgramObjects?.generation,
    );
    expect(result.minifier.optimizationDiagnostics).toContainEqual(
      expect.objectContaining({
        pass: "whole-program-field-rename-final-cost",
        decision: "accepted",
        reason: "final-output-shorter",
      }),
    );
  });

  test("shortens an internal-public field through a static require alias", () => {
    const result = minifyTemporaryLuaProject(
      {
        "dependency.lua": `local api={internal_public_name=7} return api`,
        "main.lua": `local api=require("dependency") return api.internal_public_name`,
      },
      mode,
    );
    expect(result.code).not.toContain("internal_public_name");
  });

  test("connects prototype and instance keys through a key-preserving factory", () => {
    const result = minifyTemporaryLuaProject(
      {
        "object.lua": `
local Object={}
function Object.create_instance(target,prototype)
  for key,value in pairs(prototype) do
    if key~="new" and type(value)=="function" then target[key]=value end
  end
  return target
end
return Object`,
        "class.lua": `
local Object=require("object") local Class={}
function Class.new() local instance=Object.create_instance({},Class) return instance end
function Class:long_method_name() return self.long_field_name end
return Class`,
        "main.lua": `
local Class=require("class") local instance=Class.new()
instance.long_field_name=9
return instance:long_method_name()`,
      },
      mode,
    );
    expect(result.code).not.toContain("long_method_name");
    expect(result.code).not.toContain("long_field_name");
    expect(result.code).not.toContain('~="new"');
    expect(
      result.minifier.wholeProgramFieldRenames?.keyTransfers,
    ).toBeGreaterThan(0);
  });

  test("tracks generic next and source-index key transfer", () => {
    const result = minifyTemporaryLuaSource(
      `
local source={long_field_name=3}
local target={}
for key,value in next,source do target[key]=source[key] end
return target.long_field_name
`,
      mode,
    );
    expect(result.code).not.toContain("long_field_name");
    expect(result.minifier.optimizationDiagnostics).toContainEqual(
      expect.objectContaining({
        pass: "whole-program-field-rename",
        decision: "accepted",
        reason: "key-transfer",
      }),
    );
  });

  test("separates coexisting keys and reuses a key for proved non-aliases", () => {
    const result = minifyTemporaryLuaSource(
      `
local first={first_long_name=1,second_long_name=2}
local second={third_long_name=3}
return first.first_long_name+first.second_long_name+second.third_long_name
`,
      mode,
    );
    expect(result.code).toMatch(/\{a=1,b=2\}|\{b=1,a=2\}/);
    expect(result.code).toContain("{a=3}");
    expect(
      result.minifier.wholeProgramFieldRenames?.reusedKeys,
    ).toBeGreaterThan(0);
  });

  test("avoids fixed-key collisions and unifies a proved multi-object base", () => {
    const collision = minifyTemporaryLuaSource(
      `local object={a=1,long_field_name=2} return object.a+object.long_field_name`,
      mode,
    );
    expect(collision.code).toContain("{a=1,b=2}");

    const multiObject = minifyTemporaryLuaSource(
      `
local first={long_field_name=1}
local second={long_field_name=2}
local selected=condition and first or second
return selected.long_field_name
`,
      mode,
    );
    expect(multiObject.code).not.toContain("long_field_name");
  });

  test.each([
    [
      "object-escape",
      `local object={long_field_name=1} consume(object) return object.long_field_name`,
    ],
    [
      "metatable-observation",
      `local object={long_field_name=1} setmetatable(object,{}) return object.long_field_name`,
    ],
  ] as const)("preserves a shape at the %s boundary", (reason, source) => {
    const result = minifyTemporaryLuaSource(source, mode);
    expect(result.code).toContain("long_field_name");
    expect(result.minifier.optimizationDiagnostics).toContainEqual(
      expect.objectContaining({
        pass: "whole-program-field-rename",
        decision: "rejected",
        reason,
      }),
    );
  });

  test("preserves entry contracts, dynamic-key shapes, and rename false", () => {
    const external = minifyTemporaryLuaSource(
      `local api={external_name=1} return api`,
      mode,
    );
    expect(external.code).toContain("external_name");

    const dynamic = minifyTemporaryLuaSource(
      `local object={long_name=1} local key=get_key() return object[key]`,
      mode,
    );
    expect(dynamic.code).toContain("long_name");

    const disabled = minifyTemporaryLuaSource(
      `local object={long_name=1} return object.long_name`,
      { ...mode, rename: false },
    );
    expect(disabled.code).toContain("long_name");

    const escaped = minifyTemporaryLuaSource(
      `local object={long_name=1} return object["long\\x5fname"]`,
      mode,
    );
    expect(escaped.code).toContain("long_name");
  });

  test("preserves keep-name and observable enumeration", () => {
    const kept = minifyTemporaryLuaSource(
      `
local object={}
--@storm keep-name
function object:long_method_name() return 1 end
return object:long_method_name()
`,
      mode,
    );
    expect(kept.code).toContain("long_method_name");

    const keyOutput = minifyTemporaryLuaSource(
      `
local object={long_field_name=1}
for key,value in pairs(object) do print(key,value) end
return object.long_field_name
`,
      mode,
    );
    expect(keyOutput.code).toContain("long_field_name");
    expect(keyOutput.minifier.optimizationDiagnostics).toContainEqual(
      expect.objectContaining({
        pass: "whole-program-field-rename",
        decision: "rejected",
        reason: "iteration-order-observation",
      }),
    );

    const customIterator = minifyTemporaryLuaSource(
      `
local object={long_field_name=1}
local function custom(source) return next,source,nil end
for key,value in custom(object) do print(key,value) end
return object.long_field_name
`,
      mode,
    );
    expect(customIterator.code).toContain("long_field_name");
  });

  test("keeps diagnostics observational and the result parseable", () => {
    const source = `local object={long_field_name=1} return object["long_field_name"]`;
    const withDiagnostics = minifyTemporaryLuaSource(source, mode);
    const withoutDiagnostics = minifyTemporaryLuaSource(source, {
      ...mode,
      collectOptimizationDiagnostics: false,
    });
    expect(withDiagnostics.code).toBe(withoutDiagnostics.code);
    expect(withDiagnostics.map).toEqual(withoutDiagnostics.map);
    const repeated = minifyTemporaryLuaSource(source, mode);
    expect(repeated.minifier.optimizationDiagnostics).toEqual(
      withDiagnostics.minifier.optimizationDiagnostics,
    );
    expect(() =>
      minifyTemporaryLuaSource(withDiagnostics.code, {
        ...mode,
        collectOptimizationDiagnostics: false,
      }),
    ).not.toThrow();
  });

  test("plans from only the fields surviving export DCE", () => {
    const result = minifyTemporaryLuaProject(
      {
        "dependency.lua":
          "local api={used_long_name=1,dead_long_name=2} return api",
        "main.lua": 'local api=require("dependency") return api.used_long_name',
      },
      { ...mode, effectAwareTransforms: true },
    );
    expect(result.code).not.toContain("dead_long_name");
    expect(
      result.minifier.wholeProgramFieldRenames?.diagnostics.some(
        (diagnostic) => diagnostic.field === "dead_long_name",
      ),
    ).toBe(false);
  });

  test("keeps original field names in the source map", () => {
    const result = minifyTemporaryLuaSource(
      `local object={long_field_name=1} return object.long_field_name`,
      mode,
    );
    expect(result.code).not.toContain("long_field_name");
    expect(result.map.names).toContain("long_field_name");
  });
});
