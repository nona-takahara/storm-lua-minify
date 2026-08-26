import { describe, expect, test } from "vitest";
import { SourceMapConsumer } from "source-map";
import { minifyTemporaryLuaProject } from "./lib/minifierHarness";

const objectModule = `
local Object={}
function Object.create_instance(target,prototype)
  for key,value in pairs(prototype) do target[key]=value end
  return target
end
return Object
`;

function minify(
  main: string,
  constructor = "self.enabled=enabled",
  assumeAnnotations = false,
  collectOptimizationDiagnostics = true,
) {
  return minifyTemporaryLuaProject(
    {
      "object.lua": objectModule,
      "class.lua": `
local Object=require("object")
local Class={}
---@param enabled true
function Class.new(enabled)
  local self=Object.create_instance({},Class)
  ${constructor}
  return self
end
return Class
`,
      "main.lua": main,
    },
    {
      moduleLikeLua: true,
      runtimeProfile: "stormworks",
      mergeLocals: false,
      effectAwareLocalHoist: false,
      effectAwareTableReads: false,
      removeUnused: false,
      rename: false,
      collectOptimizationDiagnostics,
      assumeAnnotations,
    },
  );
}

describe("whole-program constructor field facts", () => {
  test("keeps independent call allocations and replaces their stable reads", () => {
    const result = minify(`
local Class=require("class")
local enabled=Class.new(true)
local disabled=Class.new(false)
return enabled.enabled,disabled.enabled
`);
    expect(result.minifier.optimizationDiagnostics).toContainEqual(
      expect.objectContaining({
        pass: "whole-program-constructor-fields",
        decision: "accepted",
        reason: "field-fact",
      }),
    );
    expect(result.minifier.optimizationDiagnostics).not.toContainEqual(
      expect.objectContaining({
        pass: "constructor-field-final-cost",
        reason: "trial-failed",
      }),
    );
    expect(result.code).toMatch(/return\s+true,false/);
    expect(result.code).not.toContain(".enabled=enabled");
    expect(result.minifier.optimizationDiagnostics).toContainEqual(
      expect.objectContaining({
        pass: "constructor-field-final-cost",
        decision: "accepted",
        reason: "final-output-shorter",
      }),
    );
  });

  test("preserves an effectful unread initializer as an expression statement", () => {
    const result = minify(
      `local Class=require("class") Class.new(true) return 1`,
      "self.unused=effect()",
    );
    expect(result.code).toContain("effect()");
    expect(result.code).not.toContain(".unused=");
  });

  test("feeds a finite field value into branch folding", () => {
    const result = minify(
      `local Class=require("class") local value=Class.new(true) if value.enabled then return 1 else return 2 end`,
    );
    expect(result.code).toMatch(/return\s+1/);
    expect(result.code).not.toContain("return 2");
  });

  test("revokes only the reassigned field", () => {
    const result = minify(`
local Class=require("class")
local value=Class.new(true)
value.enabled=false
return value.enabled
`);
    expect(result.code).toContain("value.enabled");
    expect(result.minifier.optimizationDiagnostics).toContainEqual(
      expect.objectContaining({
        pass: "whole-program-constructor-fields",
        reason: "field-reassignment",
      }),
    );
  });

  test("does not treat a conditional constructor write as unconditional", () => {
    const result = minify(
      `local Class=require("class") local value=Class.new(true) return value.enabled`,
      "if enabled then self.enabled=true end",
    );
    expect(result.code).toContain("value.enabled");
  });

  test("revokes a field written by a resolved method summary", () => {
    const result = minifyTemporaryLuaProject(
      {
        "object.lua": objectModule,
        "class.lua": `local Object=require("object") local Class={} function Class.new() local self=Object.create_instance({},Class) self.enabled=true return self end function Class:disable() self.enabled=false end return Class`,
        "main.lua": `local Class=require("class") local value=Class.new() value:disable() return value.enabled`,
      },
      {
        moduleLikeLua: true,
        runtimeProfile: "stormworks",
        mergeLocals: false,
        effectAwareLocalHoist: false,
        effectAwareTableReads: false,
        rename: false,
      },
    );
    expect(result.code).toContain("value.enabled");
  });

  test.each([
    ["unknown-call", "consume(value)"],
    ["alias-escape", "escaped=value"],
    ["dynamic-key", "value[key]=1"],
    ["metatable-mutation", "setmetatable(value,{})"],
  ] as const)(
    "reports %s without replacing the affected read",
    (reason, mutation) => {
      const result = minify(
        `local Class=require("class") local value=Class.new(true) ${mutation} return value.enabled`,
      );
      expect(result.code).toContain("value.enabled");
      expect(result.minifier.optimizationDiagnostics).toContainEqual(
        expect.objectContaining({
          pass: "whole-program-constructor-fields",
          reason,
        }),
      );
    },
  );

  test("uses annotations only under the explicit contract and revokes contradictions", () => {
    const source = `local Class=require("class") local value=Class.new() return value.enabled`;
    const ordinary = minify(source);
    expect(ordinary.code).toContain("value.enabled");
    expect(ordinary.minifier.wholeProgramFields?.annotationFacts).toEqual(
      expect.arrayContaining([expect.objectContaining({ authorized: false })]),
    );
    const trusted = minify(source, undefined, true);
    expect(trusted.code).toMatch(/return\s+true/);
    expect(trusted.minifier.optimizationDiagnostics).toContainEqual(
      expect.objectContaining({
        pass: "constructor-field-final-cost",
        decision: "accepted",
      }),
    );

    const contradiction = minify(
      `local Class=require("class") local value=Class.new(false) return value.enabled`,
      undefined,
      true,
    );
    expect(contradiction.code).toContain("value.enabled");
    expect(contradiction.minifier.optimizationDiagnostics).toContainEqual(
      expect.objectContaining({
        pass: "whole-program-constructor-fields",
        reason: "contradictory-annotation",
      }),
    );
  });

  test("publishes a stored function identity for the callback consumer", () => {
    const result = minify(
      `local Class=require("class") local function callback() return 1 end local value=Class.new(callback) return value.callback`,
      "self.callback=enabled",
    );
    expect(
      result.minifier.wholeProgramFields?.facts.some(
        (fact) => fact.field === "callback" && fact.value?.kind === "function",
      ),
    ).toBe(true);
    expect(result.minifier.wholeProgramFields?.generation).toBe(
      result.minifier.wholeProgramObjects?.generation,
    );
  });

  test("connects a stable callback field call to aggregate specialization", () => {
    const result = minifyTemporaryLuaProject(
      {
        "object.lua": objectModule,
        "class.lua": `local Object=require("object") local Class={} function Class.new(callback) local self=Object.create_instance({},Class) self.callback=callback return self end function Class:run(enabled) return self.callback(enabled)+self.callback(enabled)+self.callback(enabled) end return Class`,
        "main.lua": `local Class=require("class") local function callback(enabled) if enabled then return 1 end return 2 end local value=Class.new(callback) return value:run(true)`,
      },
      {
        moduleLikeLua: true,
        runtimeProfile: "stormworks",
        mergeLocals: false,
        effectAwareLocalHoist: false,
        effectAwareTableReads: false,
        foldConstants: true,
        collectOptimizationDiagnostics: true,
      },
    );
    expect(result.minifier.optimizationDiagnostics).toContainEqual(
      expect.objectContaining({
        pass: "aggregate-function-specialization",
        decision: "accepted",
        reason: "variant-created",
      }),
    );
    expect(result.minifier.optimizationDiagnostics).toContainEqual(
      expect.objectContaining({
        pass: "aggregate-function-specialization",
        decision: "accepted",
        reason: "dead-field-write",
      }),
    );
  });

  test("reports callback reassignment as a conservative aggregate plan", () => {
    const result = minify(
      `local Class=require("class") local function callback() return 1 end local value=Class.new(callback) value.callback=other return value.callback()`,
      "self.callback=enabled",
    );
    expect(result.minifier.optimizationDiagnostics).toContainEqual(
      expect.objectContaining({
        pass: "aggregate-function-specialization",
        decision: "rejected",
        reason: "callback-reassignment",
      }),
    );
  });

  test("publishes an observable empty-table identity without replacing it", () => {
    const result = minify(
      `local Class=require("class") local cache={} local value=Class.new(cache) return value.cache==cache`,
      "self.cache=enabled",
    );
    expect(result.code).toContain("value.cache");
    expect(
      result.minifier.wholeProgramFields?.facts.some(
        (fact) => fact.field === "cache" && fact.value?.kind === "empty-table",
      ),
    ).toBe(true);
  });

  test("inherits an independently tracked base-instance field", () => {
    const result = minifyTemporaryLuaProject(
      {
        "object.lua": objectModule,
        "base.lua": `local Object=require("object") local Base={} function Base.new() local self=Object.create_instance({},Base) self.kind="base" return self end return Base`,
        "derived.lua": `local Object=require("object") local Base=require("base") local Derived={} function Derived.new() local self=Object.create_instance(Base.new(),Derived) return self end return Derived`,
        "main.lua": `local Derived=require("derived") local value=Derived.new() return value.kind`,
      },
      {
        moduleLikeLua: true,
        runtimeProfile: "stormworks",
        mergeLocals: false,
        effectAwareLocalHoist: false,
        effectAwareTableReads: false,
        rename: false,
      },
    );
    expect(result.code).toMatch(/return\s*"base"/);
  });

  test("keeps diagnostics observational and maps replaced reads to their source", async () => {
    const source = `local Class=require("class") local value=Class.new(true) return value.enabled`;
    const withDiagnostics = minify(source);
    const withoutDiagnostics = minify(source, undefined, false, false);
    expect(withDiagnostics.code).toBe(withoutDiagnostics.code);
    expect(withDiagnostics.map).toEqual(withoutDiagnostics.map);

    const literalOffset = withDiagnostics.code.lastIndexOf("true");
    const before = withDiagnostics.code.slice(0, literalOffset).split("\n");
    await SourceMapConsumer.with(withDiagnostics.map, null, (consumer) => {
      const original = consumer.originalPositionFor({
        line: before.length,
        column: before.at(-1)?.length ?? 0,
      });
      expect(original.source).toBe("main.lua");
      expect(original.line).toBe(1);
    });
  });
});
