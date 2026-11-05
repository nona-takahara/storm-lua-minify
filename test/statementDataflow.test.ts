import Parser from "luaparse";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { analyzePairwiseStatementDataflow } from "./helpers/pairwiseStatementDataflow";
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

// Check both orientations, self-pairs, cross-block pairs, and exact refusal
// reasons before and after explicit whole-DAG enumeration.
function compareAllPairs(source: string) {
  const { chunk, analysis } = analyze(source);
  const expected = analyzePairwiseStatementDataflow(
    chunk,
    analysis.facts,
    analysis.valueFlow,
    analysis.symbolLiveness,
  );
  const actual = analysis.statementDataflow;
  const statements: Parser.Statement[] = [];
  const visit = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    const type = (value as { type?: string }).type;
    if (type?.endsWith("Statement") || type === "FunctionDeclaration")
      statements.push(value as Parser.Statement);
    Object.values(value).forEach(visit);
  };
  visit(chunk);
  const compare = () => {
    for (const first of statements)
      for (const last of statements) {
        expect(actual.dependenciesBetween(first, last)).toEqual(
          expected.dependenciesBetween(first, last),
        );
        expect(actual.canMoveBefore(first, last)).toEqual(
          expected.canMoveBefore(first, last),
        );
      }
  };
  compare();
  expect(actual.dependencies).toEqual(expected.dependencies);
  expect(actual.dependencies).toBe(actual.dependencies);
  compare();
}

function luaFixtures(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((entry) => {
      const file = join(directory, entry.name);
      return entry.isDirectory()
        ? luaFixtures(file)
        : file.endsWith(".lua")
          ? [file]
          : [];
    });
}

describe("sparse statement dependence equivalence", () => {
  test.each(luaFixtures("test/fixtures"))(
    "matches every pair and movement decision in %s",
    (file) => {
      compareAllPairs(readFileSync(file, "utf8"));
    },
  );

  test("matches dense calls, declarations and independent assignments", () => {
    compareAllPairs(
      "local t={} local a=0 local b=0 " +
        Array.from({ length: 35 }, (_, i) =>
          i % 3 === 0
            ? `external(${String(i)})`
            : i % 3 === 1
              ? `a=${String(i)}`
              : `b=${String(i)}`,
        ).join(" ") +
        " return a,b,t",
    );
  });

  test("matches aliases, static and dynamic keys, escapes and nested control", () => {
    compareAllPairs(`
      local t={x=1} local u=t local other={}
      t.x=2 u.y=3 other.x=4 t[key]=5
      sink(t) u.x=source() local x=t.x
      do local z={} z.x=x consume(z) end
      if flag then t.x=6 else u[key]=7 end
      while flag do u.x=8 if stop then break end end
      return t,u,other
    `);
  });

  test("matches unknown goto edges and scope barriers", () => {
    compareAllPairs(
      "local a=0 ::again:: a=a+1 if flag then goto again end return a",
    );
  });
});
