import Parser from "luaparse";
import { describe, expect, test } from "vitest";
import { analyzeBindingEffects } from "../src/effectAnalysis";
import { resolveScopes } from "../src/resolver";
import { Symbol } from "../src/resolver";

function analyze(source: string) {
  const chunk = Parser.parse(source, { luaVersion: "5.3" });
  const resolved = resolveScopes(chunk);
  return { chunk, resolved, analysis: analyzeBindingEffects(chunk, resolved) };
}

function requiredSymbol(
  symbols: readonly Symbol[],
  predicate: (symbol: Symbol) => boolean,
): Symbol {
  const symbol = symbols.find(predicate);
  if (!symbol) throw new Error("expected symbol was not resolved");
  return symbol;
}

describe("binding effect analysis", () => {
  test("separates declaration, read, and write for one symbol", () => {
    const { resolved, analysis } = analyze("local x=1 x=x+1 return x");
    const x = resolved.symbols[0];

    expect(analysis.accessesOf(x).map((effect) => effect.access)).toEqual([
      "declare",
      "read",
      "write",
      "read",
    ]);
  });

  test("keeps outer and shadowing locals distinct in local x=x", () => {
    const { resolved, analysis } = analyze(
      "local x=1 do local x=x return x end",
    );
    const [outer, inner] = resolved.symbols;

    expect(analysis.accessesOf(outer).map((effect) => effect.access)).toEqual([
      "declare",
      "read",
    ]);
    expect(analysis.accessesOf(inner).map((effect) => effect.access)).toEqual([
      "declare",
      "read",
    ]);
  });

  test("classifies global reads and writes without treating field names as globals", () => {
    const { resolved, analysis } = analyze("target=source.field return target");
    const globals = analysis.effects
      .filter((effect) => effect.binding.kind === "global")
      .map((effect) => [effect.identifier.name, effect.access]);

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

    expect(analysis.effectsOf(localF).map((effect) => effect.access)).toEqual([
      "declare",
    ]);
    expect(analysis.accessesOf(outer).map((effect) => effect.access)).toEqual([
      "declare",
      "read",
    ]);
    expect(analysis.accessesOf(f).map((effect) => effect.access)).toEqual([
      "declare",
    ]);
    expect(analysis.accessesOf(arg).map((effect) => effect.access)).toEqual([
      "declare",
      "read",
    ]);
  });

  test("records table assignment address identifiers as reads", () => {
    const { resolved, analysis } = analyze("local t,k={},1 t[k]=value");
    const [t, k] = resolved.symbols;

    expect(analysis.accessesOf(t).map((effect) => effect.access)).toEqual([
      "declare",
      "read",
    ]);
    expect(analysis.accessesOf(k).map((effect) => effect.access)).toEqual([
      "declare",
      "read",
    ]);
  });
});
