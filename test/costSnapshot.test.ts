import Parser from "luaparse";
import { SourceNode } from "source-map";
import { afterEach, describe, expect, test, vi } from "vitest";
import { CostSnapshotClone } from "../src/costSnapshot";
import { Minifier, MinifierMode } from "../src/minifier";
import { SourceMetadata } from "../src/sourceMetadata";
import { createTemporaryLuaProject } from "./lib/minifierHarness";
import { executeLua } from "./lib/luaExecution";
import { expectLuaProjectOutput } from "./lib/luaProjectAssertions";

type Variant = "baseline" | "trial";
type Mask = Record<
  | "fieldRename"
  | "scheduler"
  | "exportDce"
  | "fieldFact"
  | "aggregateSpecialization"
  | "functionRewrite",
  Variant
>;
interface Evaluation {
  variants: Mask;
  byteLength: number;
  output: SourceNode;
}
interface Internals {
  readonly functionRewriteVariant?: Variant;
  transformLinkedModules: (this: Internals) => void;
  planFinalFieldRenames: (this: Internals) => void;
  finishOutput: (this: Internals) => SourceNode;
  printModuleWithRequireWrapper: (this: Internals) => SourceNode;
  parseOnce: (this: Internals) => SourceNode;
  parseCostSnapshot: (this: Internals) => SourceNode;
  forkCostSnapshot: (this: Internals, source: Minifier) => void;
  finalizeWholeProgramAnalyses: (this: Internals) => void;
  evaluateCostVariant: (
    this: Internals,
    mask: Mask,
    label: string,
    cache: Map<string, Evaluation>,
  ) => Evaluation;
}
const prototype = Minifier.prototype as unknown as Internals;
const mode: MinifierMode = {
  runtimeProfile: "stormworks",
  requiredWhitespace: " ",
  constantOptimizations: true,
  requireWrapper: true,
};
afterEach(() => vi.restoreAllMocks());

function run(files: Record<string, string>, options: MinifierMode = mode) {
  const { entryFilePath } = createTemporaryLuaProject(files);
  const minifier = new Minifier(entryFilePath, { luaVersion: "5.3" }, options);
  const result = minifier.parse().toStringWithSourceMap({ file: "out.lua" });
  return {
    code: result.code,
    map: result.map.toJSON(),
    diagnostics: minifier.optimizationDiagnostics,
  };
}

function freezeGraph(value: unknown): void {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return;
  Object.freeze(value);
  Object.values(value).forEach(freezeGraph);
}

describe("cost evaluation snapshots", () => {
  test.each([
    [
      "producer reentry",
      "local function a(x)return x+1 end local function b(x)return a(x)end return b(2)",
    ],
    [
      "specialization and fields",
      "local function make(x)return {longField=x}end local a=make(3) local b=make(3) return a.longField+b.longField",
    ],
    [
      "comments and annotations",
      "--# header\n--@storm keep-name\nlocal important=external()\n-- detached\n\nlocal dead=0\n--# next\nreturn important",
    ],
    [
      "global aliases and packing",
      "local x=descriptiveExternal() local y=descriptiveExternal() local z=descriptiveExternal() return descriptiveExternal(x,y,z)",
    ],
  ])("matches independent candidates for %s", (_name, source) => {
    for (const collectOptimizationDiagnostics of [false, true]) {
      const candidateBytes: number[] = [];
      const original = prototype.evaluateCostVariant;
      const observed = vi
        .spyOn(prototype, "evaluateCostVariant")
        .mockImplementation(function (this: Internals, ...args) {
          const result = original.apply(this, args);
          candidateBytes.push(result.byteLength);
          return result;
        });
      const files = { "main.lua": source };
      const options = { ...mode, collectOptimizationDiagnostics };
      const cached = run(files, options);
      const cachedBytes = [...candidateBytes];
      candidateBytes.length = 0;
      const independent = vi
        .spyOn(prototype, "parseCostSnapshot")
        .mockImplementation(function (this: Internals) {
          return this.parseOnce();
        });
      expect(run(files, options)).toEqual(cached);
      expect(candidateBytes).toEqual(cachedBytes);
      independent.mockRestore();
      observed.mockRestore();
    }
  });

  test("keeps cached ASTs immutable while sibling candidates and lazy analyses run", () => {
    const originalFork = prototype.forkCostSnapshot;
    const sources: { owner: Minifier; ast: string }[] = [];
    vi.spyOn(prototype, "forkCostSnapshot").mockImplementation(function (
      this: Internals,
      source,
    ) {
      source.moduleAST.forEach(freezeGraph);
      sources.push({
        owner: source,
        ast: JSON.stringify([...source.moduleAST]),
      });
      originalFork.call(this, source);
    });
    const originalFinalize = prototype.finalizeWholeProgramAnalyses;
    const finalOwners: Minifier[] = [];
    vi.spyOn(prototype, "finalizeWholeProgramAnalyses").mockImplementation(
      function (this: Internals) {
        originalFinalize.call(this);
        const owner = this as unknown as Minifier;
        owner.moduleAST.forEach(freezeGraph);
        finalOwners.push(owner);
      },
    );
    run({
      "main.lua":
        'local m=require("child") local t=m.make(7) return t.longField',
      "child.lua":
        "local M={} function M.make(x)return {longField=x}end return M",
    });
    expect(sources.length).toBeGreaterThan(1);
    for (const { owner, ast } of sources)
      expect(JSON.stringify([...owner.moduleAST])).toBe(ast);
    for (const owner of finalOwners)
      owner.wholeProgramObjects?.modules.forEach((module) => {
        expect(() => module.analysis.valueFlow).not.toThrow();
        expect(() => module.analysis.statementDataflow).not.toThrow();
      });
  });

  test("matches all 48 dependency-closed masks with independent full evaluations", () => {
    const project = createTemporaryLuaProject({
      "main.lua":
        'local m=require("child") local t=m.make(3) local u=m.make(3) return t.longField+u.longField',
      "child.lua":
        "local M={} function M.make(x)return {longField=x,unused=2}end return M",
    });
    const { entryFilePath } = project;
    let cache: Map<string, Evaluation> | undefined;
    const original = prototype.evaluateCostVariant;
    vi.spyOn(prototype, "evaluateCostVariant").mockImplementation(function (
      this: Internals,
      mask,
      label,
      values,
    ) {
      cache = values;
      return original.call(this, mask, label, values);
    });
    const selected = new Minifier(entryFilePath, { luaVersion: "5.3" }, mode);
    const selectedCode = selected
      .parse()
      .toStringWithSourceMap({ file: "out.lua" }).code;
    expectLuaProjectOutput({ ...project, code: selectedCode }, "true\t6\n");
    if (!cache) throw new Error("No candidate cache captured");
    let compared = 0;
    for (let bits = 0; bits < 64; bits++) {
      const trial = (bit: number): Variant =>
        bits & (1 << bit) ? "trial" : "baseline";
      const mask: Mask = {
        scheduler: trial(0),
        functionRewrite: trial(1),
        fieldFact: trial(2),
        aggregateSpecialization: trial(3),
        exportDce: trial(4),
        fieldRename: trial(5),
      };
      if (
        mask.functionRewrite === "baseline" &&
        mask.aggregateSpecialization === "trial"
      )
        continue;
      const reused = original.call(
        selected as unknown as Internals,
        mask,
        "test",
        cache,
      );
      const independent = new Minifier(
        entryFilePath,
        { luaVersion: "5.3" },
        mode,
        mask.scheduler,
        mask.functionRewrite,
        mask.fieldFact,
        mask.aggregateSpecialization,
        mask.exportDce,
        mask.fieldRename,
      ).parse();
      const expected = independent.toStringWithSourceMap({ file: "out.lua" });
      const actual = reused.output.toStringWithSourceMap({ file: "out.lua" });
      expect(actual.code).toBe(expected.code);
      expect(reused.byteLength).toBe(Buffer.byteLength(expected.code));
      expect(actual.map.toJSON()).toEqual(expected.map.toJSON());
      expect(
        executeLua(
          `print(pcall(function()\n${actual.code}\nend))`,
          project.directory,
        ),
        `candidate mask ${String(bits)}`,
      ).toEqual({ status: 0, stdout: "true\t6\n", stderr: "" });
      compared++;
    }
    expect(compared).toBe(48);
  });

  test.each(["transformLinkedModules", "planFinalFieldRenames"] as const)(
    "preserves the baseline after a trial fails in %s",
    (stage) => {
      const original = prototype[stage];
      vi.spyOn(prototype, stage).mockImplementation(function (this: Internals) {
        if (this.functionRewriteVariant === "trial")
          throw new Error("trial failure");
        original.call(this);
      });
      const files = {
        "main.lua": "local function f(x)return x+1 end return f(2)",
      };
      const options = { ...mode, collectOptimizationDiagnostics: true };
      const cached = run(files, options);
      vi.spyOn(prototype, "parseCostSnapshot").mockImplementation(function (
        this: Internals,
      ) {
        return this.parseOnce();
      });
      expect(run(files, options)).toEqual(cached);
      expect(cached.diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ reason: "trial-failed" }),
        ]),
      );
    },
  );

  test("reuses printing for an empty field gate only after all producers finish", () => {
    const print = vi.spyOn(prototype, "printModuleWithRequireWrapper");
    const evaluate = vi.spyOn(prototype, "evaluateCostVariant");
    const result = run({ "main.lua": "return external()" });
    expect(result.code).toContain("external()");
    expect(print.mock.calls.length).toBeLessThan(evaluate.mock.calls.length);
    const actual = print.mock.calls.length;
    print.mockClear();
    vi.spyOn(prototype, "parseCostSnapshot").mockImplementation(function (
      this: Internals,
    ) {
      return this.parseOnce();
    });
    expect(run({ "main.lua": "return external()" })).toEqual(result);
    expect(print.mock.calls.length).toBeGreaterThan(actual);
  });

  test("copies transferred comments and annotations without reattaching them by range", () => {
    const ast = Parser.parse(
      "--# heading\n--@storm keep-name\nlocal original=1\nreturn original",
      { comments: true, ranges: true, locations: true },
    );
    const metadata = new SourceMetadata(
      ast,
      "--# heading\n--@storm keep-name\nlocal original=1\nreturn original",
    );
    const original = ast.body[0] as Parser.LocalStatement;
    const replacement: Parser.LocalStatement = {
      type: "LocalStatement",
      variables: original.variables,
      init: original.init,
    };
    metadata.replaceStatement(original, [replacement]);
    ast.body[0] = replacement;
    const snapshot = new CostSnapshotClone();
    const copy = snapshot.clone(ast);
    const fork = metadata.fork(snapshot);
    const statement = copy.body[0] as Parser.LocalStatement;
    expect(fork.beforeOf(statement)).toEqual(metadata.beforeOf(replacement));
    expect(fork.isHeadComment(fork.beforeOf(statement)[0])).toBe(true);
    expect(fork.annotationsOfIdentifier(statement.variables[0]).keepName).toBe(
      true,
    );
    fork.removeStatement(statement);
    expect(metadata.beforeOf(replacement)).toHaveLength(2);
    expect(statement.variables[0]).not.toBe(original.variables[0]);
  });
});
