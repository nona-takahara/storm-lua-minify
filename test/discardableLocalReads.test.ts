import { describe, expect, test } from "vitest";
import Parser from "luaparse";
import { analyzeOptimizerFacts } from "../src/optimizerFacts";
import { resolveScopes } from "../src/resolver";
import { runtimeEnvironmentOf } from "../src/runtimeEnvironment";
import { minifyTemporaryLuaSource } from "./lib/minifierHarness";

const mode = {
  runtimeProfile: "stormworks" as const,
  requiredWhitespace: " " as const,
  globalAliasing: false,
  functionInlining: false,
  functionSpecialization: false,
  localDeclarationMerging: false,
  localDeclarationHoisting: false,
  tableReadMerging: false,
  identifierOptimizations: false,
};
const source =
  "local function f(p)local unused=p return 1 end return f(external())";
const compile = (text: string, options = {}) =>
  minifyTemporaryLuaSource(text, { ...mode, ...options }).code;

describe("discardable local reads", () => {
  test("discards unknown local, parameter, and upvalue reads without claiming known values", () => {
    const chunk = Parser.parse(
      "local x=external() local function f(p)local a=p local b=x local c=a return 1 end return f(x)",
    );
    const facts = analyzeOptimizerFacts(chunk, resolveScopes(chunk), {
      runtime: runtimeEnvironmentOf("stormworks"),
    });
    for (const kind of ["local", "parameter", "upvalue"]) {
      const read = facts.operations.find(
        (op) => op.kind === "read" && op.location.kind === kind,
      );
      expect(read).toBeDefined();
      if (!read) throw new Error(`Missing ${kind} read`);
      const expression = read.origin as Parser.Expression;
      expect(facts.expressionFact(expression)?.value.kind).toBe("unknown");
      expect(facts.discardabilityOf(expression).discardable).toBe(true);
    }
  });

  test("removes an unused parameter copy and prunes its parameter while retaining the actual call", () => {
    const output = compile(source);
    const baseline = compile(source, { unusedLocalRemoval: false });
    expect(output.length).toBeLessThan(baseline.length);
    expect(output).toContain("function f()");
    expect(output).not.toContain("unused");
    expect(output).toContain("f(external())");
    expect(compile(output)).toBe(output);
  });

  test("removes unknown local and nil-initialized upvalue copies", () => {
    for (const text of [
      "local x=external() local unused=x return x",
      "local u local function f()local unused=u return 1 end return f()",
    ])
      expect(compile(text)).not.toContain("unused");
  });

  test("preserves global and binding-before-declaration reads", () => {
    for (const text of [
      "local unused=external return 1",
      "local f=function()local unused=f return 1 end return f()",
    ])
      expect(compile(text)).toContain("unused=");
  });

  test("resolves a shadowing initializer to its outer local", () => {
    expect(
      compile("local x=external() do local x=x end return x"),
    ).not.toContain("do local");
  });

  test("preserves identifier copies with introspection and removes them only with explicit opt-in", () => {
    const preserved = compile(source, { runtimeProfile: "lua53" });
    expect(preserved).toContain("local unused=p");
    expect(preserved).toContain("function f(p)");
    const allowed = compile(source, {
      runtimeProfile: "lua53",
      allowIntrospectionChanges: true,
    });
    expect(allowed).not.toContain("unused");
    expect(allowed).toContain("function f()");
  });

  test("rejects unindexed identifiers and defaults to preserving introspection", () => {
    const chunk = Parser.parse("local p=external() local unused=p");
    const facts = analyzeOptimizerFacts(chunk, resolveScopes(chunk));
    const expression = (chunk.body[1] as Parser.LocalStatement).init[0];
    expect(facts.discardabilityOf(expression).discardable).toBe(false);
    expect(
      facts.discardabilityOf({ type: "Identifier", name: "p" }).discardable,
    ).toBe(false);
  });
});
