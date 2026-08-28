import Parser from "luaparse";
import { describe, expect, test } from "vitest";
import { analyzeOptimizer } from "../src/optimizerAnalysis";
import { resolveScopes } from "../src/resolver";

function analyze(source: string) {
  const chunk = Parser.parse(source, { luaVersion: "5.3" });
  const resolved = resolveScopes(chunk);
  return { chunk, resolved, analysis: analyzeOptimizer(chunk, resolved) };
}

describe("statement dataflow and dependence DAG", () => {
  test("computes liveness through a loop back-edge", () => {
    const { chunk, resolved, analysis } = analyze(
      "local carried=1 while flag do use(carried) end return carried",
    );
    const declaration = chunk.body[0] as Parser.LocalStatement;
    const loop = chunk.body[1];
    const symbol = resolved.symbolOf(declaration.variables[0]);
    const loopNode = analysis.valueFlow.controlFlow.nodeOf(loop);
    if (!symbol || !loopNode) throw new Error("missing analysis facts");

    expect(analysis.statementDataflow.liveIn(loopNode).has(symbol)).toBe(true);
    expect(analysis.statementDataflow.isLiveAfter(declaration, symbol)).toBe(
      true,
    );
  });

  test("distinguishes static table keys and retains dynamic-key conflicts", () => {
    const precise = analyze("local t={} t.y=1 local read=t.x return read");
    expect(
      precise.analysis.statementDataflow
        .dependenciesBetween(precise.chunk.body[1], precise.chunk.body[2])
        .filter((edge) => edge.kind === "read-after-write"),
    ).toEqual([]);

    const dynamic = analyze("local t={} t[key]=1 local read=t.x return read");
    expect(
      dynamic.analysis.statementDataflow.dependenciesBetween(
        dynamic.chunk.body[1],
        dynamic.chunk.body[2],
      ),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "read-after-write" }),
      ]),
    );
  });

  test("orders calls and possible errors and rejects moving a read across them", () => {
    const { chunk, analysis } = analyze(
      "local t={x=1} tick() local value=t.x use(value)",
    );
    const tick = chunk.body[1];
    const read = chunk.body[2];
    const decision = analysis.statementDataflow.canMoveBefore(read, tick);

    expect(decision).toEqual({ allowed: false, reason: "error-order" });
    expect(analysis.statementDataflow.dependenciesBetween(tick, read)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "error-order" }),
        expect.objectContaining({ kind: "metamethod-order" }),
      ]),
    );
  });

  test("keeps every dependence edge in lexical DAG order", () => {
    const { chunk, analysis } = analyze(
      "local a=source() a=change(a) consume(a) return a",
    );
    const indexes = new Map(
      chunk.body.map((statement, index) => [statement, index]),
    );
    analysis.statementDataflow.dependencies.forEach((edge) => {
      const from = indexes.get(edge.from);
      const to = indexes.get(edge.to);
      if (from !== undefined && to !== undefined) expect(from).toBeLessThan(to);
    });
  });
});
