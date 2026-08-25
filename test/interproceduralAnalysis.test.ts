import Parser from "luaparse";
import { describe, expect, test } from "vitest";
import { analyzeCallGraph } from "../src/callGraph";
import { analyzeInterprocedural } from "../src/interproceduralAnalysis";
import { analyzeOptimizerFacts } from "../src/optimizerFacts";
import { resolveScopes } from "../src/resolver";
import {
  finiteOptimizerTuple,
  finiteOptimizerValue,
} from "../src/optimizerValueDomain";

function analyze(source: string) {
  const chunk = Parser.parse(source, {
    luaVersion: "5.3",
    ranges: true,
    locations: true,
  });
  const resolved = resolveScopes(chunk);
  const facts = analyzeOptimizerFacts(chunk, resolved);
  const callGraph = analyzeCallGraph(chunk, resolved, facts);
  return {
    callGraph,
    analysis: analyzeInterprocedural(chunk, resolved, callGraph),
  };
}

function analyzeWithContract(source: string) {
  const chunk = Parser.parse(source, {
    luaVersion: "5.3",
    ranges: true,
  });
  const resolved = resolveScopes(chunk);
  const facts = analyzeOptimizerFacts(chunk, resolved);
  const callGraph = analyzeCallGraph(chunk, resolved, facts);
  return {
    callGraph,
    analysis: analyzeInterprocedural(chunk, resolved, callGraph, {
      externalContracts: new Map([
        [
          "runtimeValue",
          {
            name: "runtimeValue",
            provenance: { kind: "runtime", profile: "stormworks" },
            returns: finiteOptimizerTuple([
              finiteOptimizerValue([{ kind: "number", raw: "7" }]),
            ]),
          },
        ],
      ]),
    }),
  };
}

function requireLast<T>(items: readonly T[]): T {
  const value = items.at(-1);
  if (value === undefined) throw new Error("expected a final item");
  return value;
}

describe("interprocedural summaries", () => {
  test("propagates constants and parameter aliases through wrappers", () => {
    const { analysis, callGraph } = analyze(`
local function identity(value) return value end
local function wrapper(value) return identity(value) end
local result=wrapper(42)
`);
    const call = requireLast(callGraph.calls);
    expect(analysis.returnsOf(call).prefix[0]).toEqual({
      atoms: [{ kind: "number", raw: "42" }],
      unknownReasons: [],
    });
  });

  test("gives separate allocation identities to separate factory calls", () => {
    const { analysis, callGraph } = analyze(`
local function factory() return {x=1} end
local first=factory()
local second=factory()
`);
    const returns = callGraph.calls.map((call) => analysis.returnsOf(call));
    const first = returns[0].prefix[0].atoms[0];
    const second = returns[1].prefix[0].atoms[0];
    expect(first).toMatchObject({
      kind: "allocation",
      allocationKind: "table",
    });
    expect(second).toMatchObject({
      kind: "allocation",
      allocationKind: "table",
    });
    expect(first).not.toEqual(second);
    if (first.kind !== "allocation") throw new Error("missing allocation");
    const shape = analysis.shapeOfAllocation(first.id);
    expect(shape?.fields.length).toBeGreaterThan(0);
    expect(typeof shape?.fields[0]?.staticKey).toBe("string");
  });

  test("preserves multiple return slots through a wrapper tail", () => {
    const { analysis, callGraph } = analyze(`
local function pair() return 1,2 end
local function wrapper() return pair() end
local first,second=wrapper()
`);
    const result = analysis.returnsOf(requireLast(callGraph.calls));
    expect(result.prefix[0].atoms).toContainEqual({ kind: "number", raw: "1" });
    expect(result.prefix[1].atoms).toContainEqual({ kind: "number", raw: "2" });
    expect(result.tail).toEqual({ kind: "none" });
  });

  test("projects helper field effects without dirtying unrelated keys", () => {
    const { analysis, callGraph } = analyze(`
local function writeX(value) value.x=1 end
local tableValue={}
writeX(tableValue)
`);
    expect(analysis.effectsOf(callGraph.calls[0])).toEqual([
      expect.objectContaining({ argumentIndex: 0, access: "write" }),
    ]);
    expect(analysis.effectsOf(callGraph.calls[0])[0].staticKey).toBeDefined();
  });

  test("recursive summaries retain a provable base result", () => {
    const { analysis, callGraph } = analyze(`
local recursive
recursive=function(flag)
  if flag then return 1 end
  return recursive(true)
end
local result=recursive(false)
`);
    const recursive = callGraph.sccs.find((scc) => scc.recursive);
    expect(recursive).toBeDefined();
    expect(
      analysis.returnsOf(requireLast(callGraph.calls)).prefix[0].atoms,
    ).toContainEqual({
      kind: "number",
      raw: "1",
    });
  });

  test("does not confuse a non-returning recursive tail with nil", () => {
    const { analysis, callGraph } = analyze(`
local function forever() return forever() end
local value=forever()
`);
    const result = analysis.returnsOf(requireLast(callGraph.calls));
    expect(result.prefix).toEqual([]);
    expect(result.tail).toMatchObject({ kind: "unknown" });
  });

  test("records a parameter captured by a returned closure as escaping", () => {
    const { analysis, callGraph } = analyze(`
local function bind(value)
  return function() return value end
end
local closure=bind(1)
`);
    const call = requireLast(callGraph.calls);
    expect(analysis.escapesArgument(call, 0)).toBe(true);
    expect(analysis.summaryOf([...call.targets][0]).escapes).toContainEqual({
      parameterIndex: 0,
      reason: "capture",
    });
  });

  test("an unknown target remains local to its return and argument escapes", () => {
    const { analysis, callGraph } = analyze(`
local function wrapper(value) return external(value) end
local other=1
local result=wrapper(other)
`);
    const externalCall = callGraph.calls[0];
    expect(analysis.returnsOf(externalCall).tail).toMatchObject({
      kind: "unknown",
    });
    expect(analysis.escapesArgument(externalCall, 0)).toBe(true);
    const diagnostic = analysis.diagnostics.find(
      (candidate) =>
        candidate.reason === "unknown-call-target" &&
        candidate.callId === externalCall.id,
    );
    expect(Array.isArray(diagnostic?.sourceRange)).toBe(true);
  });

  test("uses an explicit external contract without treating it as language proof", () => {
    const { analysis, callGraph } = analyzeWithContract(
      "local function wrapper() return runtimeValue() end local value=wrapper()",
    );
    const contractCall = callGraph.calls[0];
    const wrapperCall = callGraph.calls[1];
    expect(analysis.returnsOf(wrapperCall).prefix[0].atoms).toEqual([
      { kind: "number", raw: "7" },
    ]);
    expect(analysis.diagnostics).toContainEqual(
      expect.objectContaining({
        reason: "external-contract-used",
        callId: contractCall.id,
      }),
    );
    expect(analysis.escapesArgument(contractCall, 0)).toBe(false);
  });

  test("joins fallthrough and propagates writes from lexical blocks", () => {
    const { analysis, callGraph } = analyze(`
local function branch(flag)
  local value=1
  if flag then value=2 end
  do value=3 end
  return value
end
local result=branch(false)
`);
    expect(
      analysis.returnsOf(requireLast(callGraph.calls)).prefix[0].atoms,
    ).toEqual([{ kind: "number", raw: "3" }]);
  });

  test("expands the final call in assignments and actual arguments", () => {
    const { analysis, callGraph } = analyze(`
local function pair() return 1,2 end
local function second(first,value) return value end
local function wrapper()
  local first,value=pair()
  return second(pair()),value
end
local first,value=wrapper()
`);
    const result = analysis.returnsOf(requireLast(callGraph.calls));
    expect(result.prefix[0].atoms).toContainEqual({ kind: "number", raw: "2" });
    expect(result.prefix[1].atoms).toContainEqual({ kind: "number", raw: "2" });
  });

  test("does not instantiate an allocation that escaped before return", () => {
    const { analysis, callGraph } = analyze(`
local leaked
local function factory()
  local value={x=1}
  leaked=value
  return value
end
local result=factory()
`);
    const returned = analysis.returnsOf(requireLast(callGraph.calls)).prefix[0];
    expect(returned.atoms).toEqual([]);
    expect(returned.unknownReasons).toContain("escaped-allocation");
  });

  test("does not apply an external contract to a shadowing local", () => {
    const { analysis, callGraph } = analyzeWithContract(`
local function runtimeValue() return 9 end
local value=runtimeValue()
`);
    const call = requireLast(callGraph.calls);
    expect(analysis.returnsOf(call).prefix[0].atoms).toEqual([
      { kind: "number", raw: "9" },
    ]);
    expect(
      analysis.diagnostics.some(
        (diagnostic) =>
          diagnostic.reason === "external-contract-used" &&
          diagnostic.callId === call.id,
      ),
    ).toBe(false);
  });
});
