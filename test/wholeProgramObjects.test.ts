import Parser from "luaparse";
import { SourceMapConsumer } from "source-map";
import { describe, expect, test } from "vitest";
import { analyzeOptimizer } from "../src/optimizerAnalysis";
import { resolveScopes } from "../src/resolver";
import { minifyTemporaryLuaProject } from "./lib/minifierHarness";
import {
  analyzeWholeProgramObjects,
  WholeProgramModule,
} from "../src/wholeProgramObjects";

function programOf(sources: Readonly<Record<string, string>>) {
  const modules: WholeProgramModule[] = Object.entries(sources).map(
    ([name, source]) => {
      const chunk = Parser.parse(source, {
        luaVersion: "5.3",
        ranges: true,
        locations: true,
      });
      const resolved = resolveScopes(chunk);
      return {
        name,
        chunk,
        resolved,
        analysis: analyzeOptimizer(chunk, resolved),
      };
    },
  );
  return analyzeWholeProgramObjects(modules, 0);
}

const objectModule = `
local Object={}
function Object.create_instance(target,prototype)
  for key,value in pairs(prototype) do
    if key~="new" and type(value)=="function" then target[key]=value end
  end
  return target
end
return Object
`;

describe("whole-program object identity", () => {
  test("resolves a colon method through static require and a fresh factory allocation", () => {
    const analysis = programOf({
      object: objectModule,
      class: `
local Object=require("object")
local Class={}
function Class.new() local instance=Object.create_instance({},Class) return instance end
function Class:method(value,unused) self.value=value return self.value end
return Class
`,
      main: `local Class=require("class") local instance=Class.new() return instance:method(1,side())`,
    });

    expect(analysis.resolvedMethods).toHaveLength(1);
    expect(analysis.resolvedConstructors).toHaveLength(1);
    expect(analysis.resolvedConstructors[0].object).toBe(
      analysis.resolvedMethods[0].object,
    );
    expect(
      analysis.resolvedMethods[0].target.declaration.parameters,
    ).toHaveLength(2);
    expect(analysis.resolvedMethods[0].object.id).toContain("main:call:");
    const edge = analysis.callGraph.calls.find(
      (call) => analysis.methodCallOf(call) !== undefined,
    );
    expect(edge?.hasUnknownTarget).toBe(false);
    expect(edge?.targets).toContain(analysis.resolvedMethods[0].target);
    if (!edge) throw new Error("Resolved method edge is missing");
    expect(analysis.summaryOfMethodCall(edge)).toBeDefined();
    expect(analysis.effectsOfMethodCall(edge)).toEqual(
      expect.arrayContaining([
        { parameterIndex: 0, access: "write", staticKey: "76616c7565" },
        { parameterIndex: 0, access: "read", staticKey: "76616c7565" },
      ]),
    );
    expect(analysis.diagnostics).toContainEqual(
      expect.objectContaining({ reason: "resolved-method-target" }),
    );
  });

  test("combines methods from a returned base instance and a derived prototype", () => {
    const analysis = programOf({
      object: objectModule,
      base: `
local Object=require("object") local Base={}
function Base.new() local instance=Object.create_instance({},Base) return instance end
function Base:base_method() return 1 end
return Base
`,
      derived: `
local Object=require("object") local Base=require("base") local Derived={}
function Derived.new() local instance=Object.create_instance(Base.new(),Derived) return instance end
function Derived:derived_method() return 2 end
return Derived
`,
      main: `local Derived=require("derived") local value=Derived.new() return value:base_method(),value:derived_method()`,
    });

    expect(
      analysis.resolvedMethods.map(
        (method) =>
          method.call.call.type === "CallExpression" &&
          method.call.call.base.type === "MemberExpression" &&
          method.call.call.base.identifier.name,
      ),
    ).toEqual(["base_method", "derived_method"]);
  });

  test("publishes self as parameter zero while retaining existing effects, escapes, and returns", () => {
    const analysis = programOf({
      object: objectModule,
      class: `
local Object=require("object") local Class={}
function Class.new() local instance=Object.create_instance({},Class) return instance end
function Class:method(other) self.value=other.value consume(other) return self,other.value end
return Class
`,
      main: `local Class=require("class") local value=Class.new() return value:method({value=1})`,
    });
    const edge = analysis.callGraph.calls.find(
      (call) => analysis.methodCallOf(call) !== undefined,
    );
    if (!edge) throw new Error("Resolved method edge is missing");
    const summary = analysis.summaryOfMethodCall(edge);

    expect(summary?.effects).toEqual(
      expect.arrayContaining([
        { parameterIndex: 0, access: "write", staticKey: "76616c7565" },
        { parameterIndex: 1, access: "read", staticKey: "76616c7565" },
      ]),
    );
    expect(summary?.escapes).toEqual(
      expect.arrayContaining([
        { parameterIndex: 0, reason: "return" },
        { parameterIndex: 1, reason: "unknown-call" },
      ]),
    );
    expect(summary?.returns.prefix).toHaveLength(2);
  });

  test("propagates instance identity through a required module-return function", () => {
    const analysis = programOf({
      object: objectModule,
      class: `
local Object=require("object") local Class={}
function Class.new() local instance=Object.create_instance({},Class) return instance end
function Class:method() return 1 end
return Class
`,
      apply: `return function(instance) return instance:method() end`,
      main: `local Class=require("class") local apply=require("apply") local value=Class.new() return apply(value)`,
    });

    expect(analysis.resolvedMethods).toHaveLength(1);
    const applyCall = analysis.callGraph.calls.find(
      (call) =>
        call.call.type === "CallExpression" &&
        call.call.base.type === "Identifier" &&
        call.call.base.name === "apply",
    );
    expect(applyCall?.hasUnknownTarget).toBe(false);
  });

  test("keeps the colon receiver as the single implicit parameter-zero evaluation", () => {
    const analysis = programOf({
      object: objectModule,
      class: `
local Object=require("object") local Class={}
function Class.new() local instance=Object.create_instance({},Class) return instance end
function Class:method(value) return value end
return Class
`,
      main: `local Class=require("class") return Class.new():method(mark())`,
    });
    const method = analysis.resolvedMethods[0];

    expect(method.receiver.type).toBe("CallExpression");
    expect(method.call.call.type).toBe("CallExpression");
    if (method.call.call.type !== "CallExpression") return;
    expect(method.call.call.arguments).toHaveLength(1);
    expect(
      analysis.summaryOfMethodCall(method.call)?.callable.parameters[0].name,
    ).toBe("self");
  });

  test("keeps a changed method field unknown and reports the invalidation", () => {
    const analysis = programOf({
      object: objectModule,
      class: `
local Object=require("object") local Class={}
function Class.new() local instance=Object.create_instance({},Class) return instance end
function Class:method() return 1 end
Class.method=external
return Class
`,
      main: `local Class=require("class") local value=Class.new() return value:method()`,
    });

    expect(analysis.resolvedMethods).toHaveLength(0);
    expect(analysis.diagnostics).toContainEqual(
      expect.objectContaining({ reason: "method-field-mutation" }),
    );
  });

  test("treats a static index overwrite of a method as method mutation", () => {
    const analysis = programOf({
      object: objectModule,
      class: `
local Object=require("object") local Class={}
function Class.new() local instance=Object.create_instance({},Class) return instance end
function Class:method() return 1 end
Class["method"]=external
return Class
`,
      main: `local Class=require("class") return Class.new():method()`,
    });
    expect(analysis.resolvedMethods).toHaveLength(0);
    expect(analysis.diagnostics).toContainEqual(
      expect.objectContaining({ reason: "method-field-mutation" }),
    );
  });

  test.each([
    ["dynamic-key" as const, "value[key]=replacement"],
    ["metatable-mutation" as const, "setmetatable(value,{})"],
    ["instance-escape" as const, "external(value)"],
  ])("keeps %s across an unknown object boundary", (reason, mutation) => {
    const analysis = programOf({
      object: objectModule,
      class: `
local Object=require("object") local Class={}
function Class.new() local instance=Object.create_instance({},Class) return instance end
function Class:method() return 1 end
return Class
`,
      main: `local Class=require("class") local value=Class.new() ${mutation} return value:method()`,
    });

    expect(analysis.resolvedMethods).toHaveLength(0);
    expect(analysis.diagnostics).toContainEqual(
      expect.objectContaining({ reason }),
    );
  });

  test("keeps a receiver with multiple allocation targets unknown", () => {
    const analysis = programOf({
      object: objectModule,
      class: `
local Object=require("object") local Class={}
function Class.new() local instance=Object.create_instance({},Class) return instance end
function Class:method() return 1 end
return Class
`,
      main: `
local Class=require("class")
local function invoke(value) return value:method() end
return invoke(Class.new()),invoke(Class.new())
`,
    });

    expect(analysis.resolvedMethods).toHaveLength(0);
    expect(analysis.diagnostics).toContainEqual(
      expect.objectContaining({ reason: "multiple-targets" }),
    );
  });

  test("reports dynamic and external module boundaries deterministically", () => {
    const analysis = programOf({
      main: `local dynamic=require(name) local external=require("outside") return dynamic,external`,
    });
    expect(analysis.diagnostics.map((diagnostic) => diagnostic.reason)).toEqual(
      ["dynamic-module-boundary", "external-module-boundary"],
    );
  });

  test("binds every snapshot to the supplied linked generation", () => {
    expect(programOf({ main: "return {}" }).generation).toBe(0);
  });

  test("connects final linked edges to parameter pruning without removing actual evaluation", async () => {
    const result = minifyTemporaryLuaProject(
      {
        "object.lua": objectModule,
        "class.lua": `
local Object=require("object") local Class={}
function Class.new() local instance=Object.create_instance({},Class) return instance end
function Class:method(value,unused) self.value=value return self.value end
return Class
`,
        "main.lua": `local Class=require("class") local value=Class.new() return value:method(1,side())`,
      },
      {
        moduleLikeLua: true,
        runtimeProfile: "stormworks",
        mergeLocals: false,
        effectAwareLocalHoist: false,
        effectAwareTableReads: false,
        collectOptimizationDiagnostics: true,
      },
    );

    expect(result.code).toContain("side()");
    expect(result.minifier.wholeProgramObjects?.resolvedMethods).toHaveLength(
      1,
    );
    expect(result.minifier.wholeProgramObjects?.generation).toBeGreaterThan(0);
    expect(result.minifier.optimizationDiagnostics).toContainEqual(
      expect.objectContaining({
        pass: "whole-program-method-resolution",
        decision: "accepted",
        reason: "resolved-method-target",
      }),
    );
    const method = result.minifier.moduleAST
      .get("class")
      ?.body.find(
        (statement): statement is Parser.FunctionDeclaration =>
          statement.type === "FunctionDeclaration" &&
          statement.identifier?.type === "MemberExpression" &&
          statement.identifier.identifier.name === "method",
      );
    const methodParameters = method?.parameters.length;
    expect(methodParameters).toBe(1);

    await SourceMapConsumer.with(result.map, null, (consumer) => {
      expect(consumer.hasContentsOfAllSources()).toBe(true);
      const sideMappings: {
        source: string | null;
        name: string | null;
      }[] = [];
      consumer.eachMapping((mapping) => {
        if (mapping.name === "side")
          sideMappings.push({ source: mapping.source, name: mapping.name });
      });
      expect(sideMappings).toContainEqual({
        source: "main.lua",
        name: "side",
      });
    });
  });

  test("does not rewrite an invalidated method target", () => {
    const files = {
      "object.lua": objectModule,
      "class.lua": `
local Object=require("object") local Class={}
function Class.new() local instance=Object.create_instance({},Class) return instance end
function Class:method(value,unused) return value end
Class.method=external
return Class
`,
      "main.lua": `local Class=require("class") local value=Class.new() return value:method(1,side())`,
    };
    const mode = {
      moduleLikeLua: true,
      runtimeProfile: "stormworks" as const,
      mergeLocals: false,
      effectAwareLocalHoist: false,
      effectAwareTableReads: false,
    };
    const enabled = minifyTemporaryLuaProject(files, mode);
    const disabled = minifyTemporaryLuaProject(files, {
      ...mode,
      effectAwareTransforms: false,
    });

    expect(enabled.code).toBe(disabled.code);
    const method = enabled.minifier.moduleAST
      .get("class")
      ?.body.find(
        (statement): statement is Parser.FunctionDeclaration =>
          statement.type === "FunctionDeclaration" &&
          statement.identifier?.type === "MemberExpression" &&
          statement.identifier.identifier.name === "method",
      );
    expect(method?.parameters).toHaveLength(2);
  });

  test("specializes resolved method sites while preserving self and surplus effects", () => {
    const result = minifyTemporaryLuaProject(
      {
        "object.lua": objectModule,
        "class.lua": `local Object=require("object") local Class={} function Class.new() local self=Object.create_instance({},Class) self.value=7 return self end function Class:read(enabled,fallback) if enabled then return self.value end return fallback end return Class`,
        "main.lua": `local Class=require("class") local value=Class.new() return ${Array.from({ length: 12 }, () => "value:read(true,side())").join("+")}`,
      },
      {
        moduleLikeLua: true,
        runtimeProfile: "stormworks",
        mergeLocals: false,
        effectAwareLocalHoist: false,
        effectAwareTableReads: false,
        globalAlias: false,
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
        pass: "aggregate-specialization-final-cost",
        decision: "accepted",
        reason: "final-output-shorter",
      }),
    );
    expect(result.code.match(/side\(\)/g)).toHaveLength(12);
  });
});
