import { SourceMapConsumer } from "source-map";
import { describe, expect, test } from "vitest";
import { minifyTemporaryLuaProject } from "./lib/minifierHarness";

const mode = {
  moduleLikeLua: true,
  runtimeProfile: "stormworks" as const,
  mergeLocals: false,
  effectAwareLocalHoist: false,
  effectAwareTableReads: false,
  globalAlias: false,
  rename: false,
  collectOptimizationDiagnostics: true,
};

function minify(
  dependency: string,
  main: string,
  overrides: Partial<typeof mode> = {},
) {
  return minifyTemporaryLuaProject(
    { "dependency.lua": dependency, "main.lua": main },
    { ...mode, ...overrides },
  );
}

describe("whole-program module export reachability", () => {
  test("unifies require sites and removes unreachable fields with their private helper", () => {
    const result = minify(
      `
local exports={}
local function private_helper_only_for_dead_export() return 99 end
function exports.used() return 1 end
function exports.dead_function() return private_helper_only_for_dead_export() end
exports.dead_constant=3
return exports
`,
      `
local first=require("dependency")
local second=require("dependency")
return first.used()+second.used()
`,
    );

    expect(result.code).toContain("exports.used");
    expect(result.code).not.toContain("dead_function");
    expect(result.code).not.toContain("dead_constant");
    expect(result.code).not.toContain("private_helper_only_for_dead_export");
    expect(result.minifier.wholeProgramExports?.generation).toBe(
      result.minifier.wholeProgramObjects?.generation,
    );
    expect(result.minifier.optimizationDiagnostics).toContainEqual(
      expect.objectContaining({
        pass: "whole-program-export-dce",
        decision: "accepted",
        reason: "field-removed",
      }),
    );
    expect(result.minifier.optimizationDiagnostics).toContainEqual(
      expect.objectContaining({
        pass: "module-export-dce-final-cost",
        decision: "accepted",
        reason: "final-output-shorter",
      }),
    );
  });

  test("preserves an effectful dead assignment initializer in module order", () => {
    const result = minify(
      `local exports={} exports.dead=mark("initializer") return exports`,
      `local log={} function mark(value) log[#log+1]=value return value end require("dependency") return table.concat(log,",")`,
    );
    expect(result.code).toContain('mark("initializer")');
    expect(result.code).not.toContain("exports.dead=");
    expect(result.minifier.optimizationDiagnostics).toContainEqual(
      expect.objectContaining({
        pass: "whole-program-export-dce",
        reason: "field-effect-preserved",
      }),
    );
  });

  test.each([
    ["dynamic-key", "return dependency[key]"],
    ["shape-observation", "return next(dependency)"],
    ["shape-observation", "return #dependency"],
    ["shape-observation", "return getmetatable(dependency)"],
    ["export-escape", "return consume(dependency)"],
  ] as const)("keeps the complete export shape for %s", (reason, use) => {
    const result = minify(
      `local exports={first=1,second=2} return exports`,
      `local dependency=require("dependency") ${use}`,
    );
    expect(result.code).toContain("first=1");
    expect(result.code).toContain("second=2");
    expect(result.minifier.optimizationDiagnostics).toContainEqual(
      expect.objectContaining({
        pass: "whole-program-export-reachability",
        reason,
      }),
    );
  });

  test("keeps entry exports and storm-protected dependency exports as roots", () => {
    const dependency = `
local exports={}
--@storm export
function exports.protected() return 1 end
function exports.dead() return 2 end
return exports
`;
    const result = minify(
      dependency,
      `local dependency=require("dependency") local entry={visible=dependency.protected} return entry`,
    );
    expect(result.code).toContain("protected");
    expect(result.code).not.toContain("exports.dead");
    expect(result.code).toContain("visible=");
  });

  test("follows live export functions through private helpers to dependent fields", () => {
    const result = minify(
      `
local exports={constant=7,dead=8}
local function helper() return exports.constant end
function exports.used() return helper() end
return exports
`,
      `local dependency=require("dependency") return dependency.used()`,
    );
    expect(result.code).toContain("constant=7");
    expect(result.code).toContain("helper");
    expect(result.code).not.toContain("dead=8");
  });

  test("keeps the full target shape when a live field re-exports another module", () => {
    const result = minifyTemporaryLuaProject(
      {
        "leaf.lua": `local exports={used=1,shape_visible=2} return exports`,
        "dependency.lua": `local exports={sub=require("leaf"),dead=3} return exports`,
        "main.lua": `local dependency=require("dependency") return dependency.sub.used`,
      },
      mode,
    );
    expect(result.code).toContain("shape_visible=2");
    expect(result.code).not.toContain("dead=3");
  });

  test("follows a required module-return function through the shared call graph", () => {
    const result = minifyTemporaryLuaProject(
      {
        "leaf.lua": `local exports={used=1,dead=2} return exports`,
        "dependency.lua": `local Leaf=require("leaf") return function() return Leaf.used end`,
        "main.lua": `local apply=require("dependency") return apply()`,
      },
      mode,
    );
    expect(result.code).toContain("used=1");
    expect(result.code).not.toContain("dead=2");
  });

  test("keeps every field and reports multiple return allocations", () => {
    const result = minify(
      `local first={a=1} local second={b=2} return choose and first or second`,
      `require("dependency") return 1`,
    );
    expect(result.code).toContain("a=1");
    expect(result.code).toContain("b=2");
    expect(result.minifier.optimizationDiagnostics).toContainEqual(
      expect.objectContaining({
        pass: "whole-program-export-reachability",
        reason: "multiple-return-allocations",
      }),
    );
  });

  test("reports and retains an effectful table field that cannot be split safely", () => {
    const result = minify(
      `local exports={dead=1+side()} return exports`,
      `require("dependency") return 1`,
    );
    expect(result.code).toContain("dead=1+side()");
    expect(result.minifier.optimizationDiagnostics).toContainEqual(
      expect.objectContaining({
        pass: "whole-program-export-dce",
        decision: "rejected",
        reason: "effectful-initializer",
      }),
    );
  });

  test("reports an unresolved dynamic re-export without guessing its shape", () => {
    const result = minify(
      `local exports={plugin=require(name),dead=1} return exports`,
      `local dependency=require("dependency") return dependency.plugin`,
    );
    expect(result.code).toContain("require(name)");
    expect(result.minifier.optimizationDiagnostics).toContainEqual(
      expect.objectContaining({
        pass: "whole-program-export-reachability",
        reason: "unresolved-re-export",
      }),
    );
  });

  test("applies keep-name only to a helper that remains live", () => {
    const result = minify(
      `
local exports={}
--@storm keep-name
local descriptive_helper=7
function exports.used() return descriptive_helper end
function exports.dead() return 2 end
return exports
`,
      `local dependency=require("dependency") return dependency.used()`,
      { rename: true },
    );
    expect(result.code).toContain("descriptive_helper");
    expect(result.code).not.toContain("exports.dead");
  });

  test("keeps diagnostics observational and preserves surviving source provenance", async () => {
    const dependency = `local exports={used=1,unused=2} return exports`;
    const main = `local dependency=require("dependency") return dependency.used`;
    const withDiagnostics = minify(dependency, main);
    const withoutDiagnostics = minify(dependency, main, {
      collectOptimizationDiagnostics: false,
    });
    expect(withDiagnostics.code).toBe(withoutDiagnostics.code);
    expect(withDiagnostics.map).toEqual(withoutDiagnostics.map);
    await SourceMapConsumer.with(withDiagnostics.map, null, (consumer) => {
      expect(consumer.hasContentsOfAllSources()).toBe(true);
      expect(consumer.sources).toEqual(
        expect.arrayContaining(["dependency.lua", "main.lua"]),
      );
      const names: { name: string | null; source: string | null }[] = [];
      consumer.eachMapping((mapping) => {
        if (mapping.name === "used" || mapping.name === "unused")
          names.push({ name: mapping.name, source: mapping.source });
      });
      expect(names).toContainEqual({ name: "used", source: "dependency.lua" });
      expect(names).not.toContainEqual({
        name: "unused",
        source: "dependency.lua",
      });
    });
  });

  test("re-resolves shadowed bindings after field and helper DCE", () => {
    const result = minify(
      `
local exports={}
local value=1
function exports.used() local value=2 return value end
function exports.dead() return value end
return exports
`,
      `local dependency=require("dependency") return dependency.used()`,
    );
    expect(result.code).toMatch(/local\s+value=2\s+return\s+value/);
    expect(result.code).not.toContain("value=1");
    expect(result.code).not.toContain("exports.dead");
  });

  test.each([true, false])(
    "preserves require caching and output semantics with moduleLikeLua=%s",
    (moduleLikeLua) => {
      const result = minify(
        `count=count+1 local exports={used=count,unused=2} return exports`,
        `count=0 local first=require("dependency") local second=require("dependency") return first.used,second.used,count`,
        { moduleLikeLua },
      );
      expect(result.code).toContain("count=count+1");
      expect(result.code).not.toContain("unused=2");
    },
  );

  test("treats array and computed literal fields as shape boundaries", () => {
    const arrayResult = minify(
      `local exports={10,named=20} return exports`,
      `require("dependency") return 1`,
    );
    expect(arrayResult.code).toContain("named=20");
    expect(arrayResult.minifier.optimizationDiagnostics).toContainEqual(
      expect.objectContaining({ reason: "shape-observation" }),
    );

    const dynamicResult = minify(
      `local exports={[key]=10,named=20} return exports`,
      `require("dependency") return 1`,
    );
    expect(dynamicResult.code).toContain("named=20");
    expect(dynamicResult.minifier.optimizationDiagnostics).toContainEqual(
      expect.objectContaining({ reason: "dynamic-key" }),
    );
  });

  test("recognizes static index assignments as export definitions", () => {
    const result = minify(
      `local exports={} exports["used"]=1 exports["dead"]=2 return exports`,
      `local dependency=require("dependency") return dependency["used"]`,
    );
    expect(result.code).toContain('exports["used"]=1');
    expect(result.code).not.toContain('exports["dead"]=2');
  });

  test("keeps only the field read by a non-escaping internal consumer", () => {
    const result = minify(
      `local exports={used=1,dead=2} local function consume(value) return value.used end consume(exports) return exports`,
      `require("dependency") return 1`,
    );
    expect(result.code).toContain("used=1");
    expect(result.code).not.toContain("dead=2");
  });

  test("removes a nested export assignment from its owning block", () => {
    const result = minify(
      `local exports={} do exports.dead=1 end return exports`,
      `require("dependency") return 1`,
    );
    expect(result.code).not.toContain("exports.dead=1");
  });
});
