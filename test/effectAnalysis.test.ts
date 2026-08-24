import Parser from "luaparse";
import { describe, expect, test } from "vitest";
import { analyzeOptimizerFacts } from "../src/optimizerFacts";
import { resolveScopes } from "../src/resolver";
import { Symbol } from "../src/resolver";
import { runtimeEnvironmentOf } from "../src/runtimeEnvironment";

function analyze(source: string) {
  const chunk = Parser.parse(source, { luaVersion: "5.3" });
  const resolved = resolveScopes(chunk);
  return { chunk, resolved, analysis: analyzeOptimizerFacts(chunk, resolved) };
}

function requiredSymbol(
  symbols: readonly Symbol[],
  predicate: (symbol: Symbol) => boolean,
): Symbol {
  const symbol = symbols.find(predicate);
  if (!symbol) throw new Error("expected symbol was not resolved");
  return symbol;
}

describe("shared optimizer operation facts", () => {
  test("separates declaration, read, and write for one symbol", () => {
    const { resolved, analysis } = analyze("local x=1 x=x+1 return x");
    const x = resolved.symbols[0];

    expect(analysis.operationsOfSymbol(x).map((effect) => effect.kind)).toEqual(
      ["declare", "read", "write", "read"],
    );
  });

  test("keeps outer and shadowing locals distinct in local x=x", () => {
    const { resolved, analysis } = analyze(
      "local x=1 do local x=x return x end",
    );
    const [outer, inner] = resolved.symbols;

    expect(
      analysis.operationsOfSymbol(outer).map((effect) => effect.kind),
    ).toEqual(["declare", "read"]);
    expect(
      analysis.operationsOfSymbol(inner).map((effect) => effect.kind),
    ).toEqual(["declare", "read"]);
  });

  test("classifies global reads and writes without treating field names as globals", () => {
    const { resolved, analysis } = analyze("target=source.field return target");
    const globals = analysis.operations
      .filter(
        (operation) =>
          "location" in operation && operation.location.kind === "global",
      )
      .map((operation) => [
        "location" in operation && operation.location.kind === "global"
          ? operation.location.binding.name
          : "",
        operation.kind,
      ]);

    expect(globals).toEqual([
      ["source", "read"],
      ["target", "write"],
      ["target", "read"],
    ]);
    expect(resolved.globals.has("field")).toBe(false);
  });

  test("does not flatten a closure body into its containing local statement", () => {
    const { chunk, resolved, analysis } = analyze(
      "local outer=1 local f=function(arg) return outer+arg end",
    );
    const localF = chunk.body[1];
    const outer = requiredSymbol(
      resolved.symbols,
      (symbol) => symbol.name === "outer",
    );
    const f = requiredSymbol(resolved.symbols, (symbol) => symbol.name === "f");
    const arg = requiredSymbol(
      resolved.symbols,
      (symbol) => symbol.kind === "param",
    );

    expect(analysis.operationsOf(localF).map((effect) => effect.kind)).toEqual([
      "allocate",
      "declare",
    ]);
    expect(
      analysis.operationsOfSymbol(outer).map((effect) => effect.kind),
    ).toEqual(["declare", "read"]);
    expect(analysis.operationsOfSymbol(f).map((effect) => effect.kind)).toEqual(
      ["declare"],
    );
    expect(
      analysis.operationsOfSymbol(arg).map((effect) => effect.kind),
    ).toEqual(["declare", "read"]);
  });

  test("records table assignment address identifiers as reads", () => {
    const { resolved, analysis } = analyze("local t,k={},1 t[k]=value");
    const [t, k] = resolved.symbols;

    expect(analysis.operationsOfSymbol(t).map((effect) => effect.kind)).toEqual(
      ["declare", "read"],
    );
    expect(analysis.operationsOfSymbol(k).map((effect) => effect.kind)).toEqual(
      ["declare", "read"],
    );
  });

  test("classifies captured bindings as upvalues", () => {
    const { resolved, analysis } = analyze(
      "local outer=1 local f=function() return outer end",
    );
    const outer = requiredSymbol(
      resolved.symbols,
      (symbol) => symbol.name === "outer",
    );
    const read = analysis
      .operationsOfSymbol(outer)
      .find((operation) => operation.kind === "read");

    expect(read).toMatchObject({
      kind: "read",
      location: { kind: "upvalue" },
    });
  });

  test("normalizes table locations and preserves may-error evidence", () => {
    const { analysis } = analyze('local t={} return t.x+t["x"]');
    const tableReads = analysis.operations.filter(
      (operation) => operation.kind === "table-read",
    );
    expect(
      tableReads.map((operation) =>
        operation.kind === "table-read" ? operation.location.key : undefined,
      ),
    ).toEqual([
      { kind: "static", value: "78" },
      { kind: "static", value: "78" },
    ]);
    const returnStatement = tableReads[0].owner as Parser.ReturnStatement;
    expect(
      analysis.expressionFact(returnStatement.arguments[0])?.effects.mayError,
    ).toMatchObject({
      value: "may",
      evidence: { kind: "language" },
    });
  });

  test("records a field function declaration as a table write", () => {
    const { analysis } = analyze("local api={} function api.run() end");
    const access = analysis.operations.find(
      (operation) =>
        (operation.kind === "table-read" || operation.kind === "table-write") &&
        operation.location.key.kind === "static",
    );

    expect(access).toMatchObject({
      kind: "table-write",
      location: { key: { kind: "static", value: "72756e" } },
    });
  });

  test.each([
    ["local a,b,c=one(),2", ["expression", "expression", "nil-padding"]],
    [
      "local a,b,c=1,many()",
      ["expression", "tail-expansion", "tail-expansion"],
    ],
    ["local a,b,c=...", ["tail-expansion", "tail-expansion", "tail-expansion"]],
  ])("models Lua value adjustment for %s", (source, expected) => {
    const { chunk, analysis } = analyze(source);
    expect(
      analysis.valueSlotsOf(chunk.body[0]).map((slot) => slot.source.kind),
    ).toEqual(expected);
  });

  test("keeps runtime capabilities and aggressive assumptions separate", () => {
    const chunk = Parser.parse("return object.value", { luaVersion: "5.3" });
    const resolved = resolveScopes(chunk);
    const assumptions = new Map([
      ["ignore-metamethods", "explicit aggressive opt-in"],
    ]);
    const analysis = analyzeOptimizerFacts(chunk, resolved, {
      runtime: runtimeEnvironmentOf("stormworks"),
      assumptions,
    });
    const expression = (chunk.body[0] as Parser.ReturnStatement).arguments[0];

    expect(analysis.policy.runtime?.profile).toBe("stormworks");
    expect(analysis.policy.assumptions).toEqual(assumptions);
    expect(
      analysis.expressionFact(expression)?.effects.mayInvokeMetamethod,
    ).toMatchObject({
      value: "no",
      evidence: { kind: "runtime", profile: "stormworks" },
    });
  });

  test("includes computed table keys in constructor effects", () => {
    const { chunk, analysis } = analyze("return {[erroring()]=1}");
    const constructor = (chunk.body[0] as Parser.ReturnStatement)
      .arguments[0] as Parser.TableConstructorExpression;

    expect(analysis.expressionFact(constructor)?.effects.mayError.value).toBe(
      "may",
    );
  });

  test("keeps deterministic unknown reasons and source correspondence", () => {
    const source = "local value=external() return value";
    const chunk = Parser.parse(source, {
      luaVersion: "5.3",
      ranges: true,
    });
    const resolved = resolveScopes(chunk);
    const first = analyzeOptimizerFacts(chunk, resolved);
    const second = analyzeOptimizerFacts(chunk, resolved);

    expect(
      first.unknowns.map(({ domain, reason }) => [domain, reason]),
    ).toEqual(second.unknowns.map(({ domain, reason }) => [domain, reason]));
    expect(first.operations.every((operation) => operation.sourceRange)).toBe(
      true,
    );
  });
});
