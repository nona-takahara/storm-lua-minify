import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import Parser from "luaparse";
import { describe, test } from "vitest";
import { resolveScopes, Symbol } from "../src/resolver";
import { analyzeControlFlow } from "../src/controlFlow";
import { analyzeOptimizerFacts } from "../src/optimizerFacts";
import { analyzeSymbolLiveness } from "../src/symbolLiveness";
import {
  addLiveInterference,
  buildVariableInterference,
  selectLiveInterferenceStrategy,
} from "../src/renamer";

function analyze(source: string) {
  const chunk = Parser.parse(source, { luaVersion: "5.3" });
  const resolved = resolveScopes(chunk);
  const facts = analyzeOptimizerFacts(chunk, resolved);
  const liveness = analyzeSymbolLiveness(
    analyzeControlFlow(chunk, resolved),
    facts,
  );
  const symbols = resolved.symbols.filter(
    (s) => s.kind !== "label" && !s.implicit,
  );
  return { chunk, resolved, facts, liveness, symbols };
}
function symbolNamed(symbols: readonly Symbol[], name: string) {
  const symbol = symbols.find((s) => s.name === name);
  assert.ok(symbol);
  return symbol;
}
function edges(graph: ReadonlyMap<Symbol, ReadonlySet<Symbol>>) {
  return [...graph].map(([s, neighbors]) => [
    s.id,
    [...neighbors].map((n) => n.id).sort((a, b) => a - b),
  ]);
}
function compare(source: string) {
  const result = analyze(source);
  const { chunk, resolved, liveness, symbols } = result;
  // Compare live edges alone too: lexical edges must not mask missing edges.
  for (const selected of [symbols, symbols.filter((_, i) => i % 2 === 0)]) {
    const live = (["clique", "bitset", "auto"] as const).map((strategy) => {
      const graph = new Map(selected.map((s) => [s, new Set<Symbol>()]));
      addLiveInterference(graph, liveness, strategy);
      return edges(graph);
    });
    assert.deepEqual(live[1], live[0]);
    assert.deepEqual(live[2], live[0]);
    for (const reuse of [false, true]) {
      const graphs = (["clique", "bitset", "auto"] as const).map((strategy) =>
        edges(
          buildVariableInterference(
            chunk,
            resolved,
            selected,
            reuse,
            result,
            strategy,
          ),
        ),
      );
      assert.deepEqual(graphs[1], graphs[0]);
      assert.deepEqual(graphs[2], graphs[0]);
    }
  }
  return result;
}
function dense(count: number) {
  return `${Array.from({ length: count }, (_, i) => `local v${String(i)}=source(${String(i)})`).join("\n")}\nreturn ${Array.from({ length: count }, (_, i) => `v${String(i)}`).join("+")}`;
}
describe("interference edge equivalence", () => {
  test("all existing Lua fixtures have identical live-point and complete edge sets", () => {
    const files = fs
      .readdirSync(path.resolve("test/fixtures"), {
        recursive: true,
        withFileTypes: true,
      })
      .filter((e) => e.isFile() && e.name.endsWith(".lua"));
    assert.ok(files.length > 0);
    for (const file of files) {
      const filename = path.join(file.parentPath, file.name);
      try {
        compare(fs.readFileSync(filename, "utf8"));
      } catch (error) {
        throw new Error(filename, { cause: error });
      }
    }
  }, 30_000);
  test("dense synthetic locals and word boundaries have identical edge sets", () => {
    for (const count of [0, 1, 15, 16, 17, 31, 32, 33, 64, 180, 400])
      compare(count === 0 ? "return" : dense(count));
  }, 60_000);
  test("live-in and live-out stay distinct across signed bit and word boundaries", () => {
    const r = analyze(dense(40));
    const [a, b, c, d, e, f] = r.symbols;
    const points = new Map<number, ReadonlySet<Symbol>>([
      [0, new Set([a])],
      [1, new Set([b])],
      [31, new Set([c, d])],
      [32, new Set([d, e])],
      [63, new Set([a, f])],
      [64, new Set([b, e])],
    ]);
    const indices = new Map(r.liveness.controlFlow.nodes.map((n, i) => [n, i]));
    const liveness = {
      ...r.liveness,
      liveIn: (n: (typeof r.liveness.controlFlow.nodes)[number]) =>
        points.get(2 * (indices.get(n) ?? -1)) ?? new Set<Symbol>(),
      liveOut: (n: (typeof r.liveness.controlFlow.nodes)[number]) =>
        points.get(2 * (indices.get(n) ?? -1) + 1) ?? new Set<Symbol>(),
    };
    const graph = new Map(r.symbols.map((s) => [s, new Set<Symbol>()]));
    addLiveInterference(graph, liveness, "bitset");
    assert.deepEqual(graph.get(a), new Set([f]));
    assert.deepEqual(graph.get(b), new Set([e]));
    assert.deepEqual(graph.get(c), new Set([d]));
    assert.deepEqual(graph.get(d), new Set([c, e]));
    assert.deepEqual(graph.get(e), new Set([d, b]));
    assert.deepEqual(graph.get(f), new Set([a]));
  });
  test("capture and entry live-in retain edges without local definitions", () => {
    const r = compare(`local first, second = source(), source()
      local function reader() return first + second end
      local function other() return first end return reader, other`);
    assert.ok(
      r.liveness.controlFlow.nodes.some(
        (n) =>
          n.kind === "entry" &&
          r.liveness.liveIn(n).size >= 2 &&
          r.liveness.defs(n).size === 0,
      ),
    );
    const graph = buildVariableInterference(
      r.chunk,
      r.resolved,
      r.symbols,
      true,
      r,
      "bitset",
    );
    const first = symbolNamed(r.symbols, "first");
    const reader = symbolNamed(r.symbols, "reader");
    assert.ok(graph.get(first)?.has(reader));
  });
  test("unused simultaneous locals, parameters and generic-for bindings retain edges", () => {
    const r = compare(`local left, right = source()
      local function f(a, b) return a end
      for key, value in pairs(items) do print(key) end return f`);
    const graph = buildVariableInterference(
      r.chunk,
      r.resolved,
      r.symbols,
      true,
      r,
      "bitset",
    );
    for (const [left, right] of [
      ["left", "right"],
      ["a", "b"],
      ["key", "value"],
    ]) {
      const a = symbolNamed(r.symbols, left);
      const b = symbolNamed(r.symbols, right);
      assert.ok(graph.get(a)?.has(b), `${left}/${right}`);
    }
  });
  test("branches, loops, goto, dead definitions and nested scopes preserve edges", () => {
    compare(`local a, b = source(), source() ::again::
      if flag then a = b else b = a end
      while flag do local c = a; a = b; b = c end
      repeat local d = a; b = d until flag
      do local a = b; print(a) end local dead = 1
      if flag then goto again end return a, b`);
  });
  test("deterministic density selection keeps small and sparse graphs on cliques", () => {
    for (const source of [
      dense(8),
      Array.from(
        { length: 180 },
        (_, i) => `do local v${String(i)}=source() print(v${String(i)}) end`,
      ).join("\n"),
    ]) {
      const { symbols, liveness } = compare(source);
      assert.equal(
        selectLiveInterferenceStrategy(
          new Map(symbols.map((s) => [s, new Set<Symbol>()])),
          liveness,
        ),
        "clique",
      );
    }
    const { symbols, liveness } = analyze(dense(180));
    assert.equal(
      selectLiveInterferenceStrategy(
        new Map(symbols.map((s) => [s, new Set<Symbol>()])),
        liveness,
      ),
      "bitset",
    );
  });
});
