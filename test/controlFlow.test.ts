import Parser from "luaparse";
import { describe, expect, test } from "vitest";
import { analyzeControlFlow, ControlFlowNode } from "../src/controlFlow";
import { resolveScopes } from "../src/resolver";

function analyze(chunk: Parser.Chunk, version = 0) {
  return analyzeControlFlow(chunk, resolveScopes(chunk), version);
}

function successorKinds(node: ControlFlowNode | undefined): string[] {
  return node?.successors.map((edge) => edge.kind) ?? [];
}

describe("intraprocedural control-flow graph", () => {
  test("represents both arms and the join of an if/elseif/else", () => {
    const chunk = Parser.parse(
      "local a=1 if first then a=2 elseif second then a=3 else a=4 end use(a)",
      { luaVersion: "5.3" },
    );
    const flow = analyze(chunk, 7);
    const conditional = chunk.body[1];
    const after = chunk.body[2];
    const conditions = flow.nodes.filter(
      (node) => node.statement === conditional && node.kind === "condition",
    );

    expect(flow.version).toBe(7);
    expect(flow.complete).toBe(true);
    expect(conditions).toHaveLength(2);
    expect(successorKinds(conditions[0])).toEqual([
      "branch-true",
      "branch-false",
    ]);
    expect(flow.dominates(chunk.body[0], after)).toBe(true);
    expect(flow.dominates(conditional, after)).toBe(true);
  });

  test("models loop back-edges, loop exits, and break", () => {
    const chunk = Parser.parse(
      "while ready do if stop then break end tick() end finish()",
      { luaVersion: "5.3" },
    );
    const flow = analyze(chunk);
    const loop = flow.nodeOf(chunk.body[0]);
    const breakStatement = (chunk.body[0] as Parser.WhileStatement)
      .body[0] as Parser.IfStatement;
    const breakNode = flow.nodeOf(breakStatement.clauses[0].body[0]);

    expect(successorKinds(loop)).toEqual(["loop-body", "loop-exit"]);
    expect(successorKinds(breakNode)).toEqual(["break"]);
    expect(
      flow.nodes.some((node) => successorKinds(node).includes("loop-back")),
    ).toBe(true);
  });

  test("routes return to the function exit and keeps nested functions separate", () => {
    const chunk = Parser.parse(
      "local outer=1 local f=function(flag) if flag then return outer end return 0 end use(f)",
      { luaVersion: "5.3" },
    );
    const flow = analyze(chunk);
    const returns = flow.nodes.filter(
      (node) => node.statement?.type === "ReturnStatement",
    );

    expect(flow.units.map((unit) => unit.kind)).toEqual(["chunk", "function"]);
    expect(returns).toHaveLength(2);
    returns.forEach((node) => {
      expect(node.successors).toHaveLength(1);
      expect(node.successors[0]).toMatchObject({ kind: "return" });
      expect(node.successors[0].to.unit).toBe(node.unit);
      expect(node.successors[0].to.kind).toBe("exit");
    });
  });

  test("resolves label/goto and exposes unresolved transfers as unknown", () => {
    const known = Parser.parse(
      "local skipped=1 goto done skipped=2 ::done:: return",
      {
        luaVersion: "5.3",
      },
    );
    const knownFlow = analyze(known);
    expect(successorKinds(knownFlow.nodeOf(known.body[1]))).toEqual(["goto"]);
    expect(knownFlow.complete).toBe(true);

    const unresolved = Parser.parse("goto target ::target::", {
      luaVersion: "5.3",
    });
    (unresolved.body[1] as Parser.LabelStatement).label.name = "other";
    const unresolvedFlow = analyze(unresolved);
    expect(unresolvedFlow.complete).toBe(false);
    expect(unresolvedFlow.unknownEdges).toHaveLength(1);
  });
});
