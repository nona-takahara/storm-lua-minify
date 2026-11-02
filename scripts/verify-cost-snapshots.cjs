// Compare independently built revisions in one process, with deterministic counters.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { performance } = require("node:perf_hooks");

const baselineDist = process.argv[2];
if (!baselineDist)
  throw new Error(
    "Usage: node scripts/verify-cost-snapshots.cjs BASELINE_DIST [EXTERNAL_ENTRY]",
  );
// Generation wrappers call lexical factories; count both entry paths together.
const counted = [
  ["resolver", "resolveScopes"],
  ["renamer", "assignRenames"],
  ["optimizerAnalysis", "analyzeOptimizer"],
  ["optimizerAnalysis", "analyzeOptimizerAtGeneration", "analyzeOptimizer"],
  ["optimizerFacts", "analyzeOptimizerFacts"],
  [
    "optimizerFacts",
    "analyzeOptimizerFactsAtGeneration",
    "analyzeOptimizerFacts",
  ],
  ["controlFlow", "analyzeControlFlow"],
  ["symbolLiveness", "analyzeSymbolLiveness"],
  ["valueFlow", "analyzeValueFlow"],
  ["tableEffects", "analyzeTableEffects"],
  ["statementDataflow", "analyzeStatementDataflow"],
  ["wholeProgramObjects", "analyzeWholeProgramObjects"],
];
function load(dist) {
  const counts = {};
  for (const [file, name, counter = name] of counted) {
    const module = require(path.join(dist, file + ".js"));
    const original = module[name];
    counts[counter] ??= 0;
    module[name] = (...args) => {
      counts[counter]++;
      return original(...args);
    };
  }
  const { Minifier } = require(path.join(dist, "minifier.js"));
  for (const name of [
    "parseOnce",
    "link",
    "optimizeLinkedModules",
    "transformLinkedModules",
    "printModuleWithRequireWrapper",
  ]) {
    const original = Minifier.prototype[name];
    if (!original) continue;
    counts[name] = 0;
    Minifier.prototype[name] = function (...args) {
      counts[name]++;
      return original.apply(this, args);
    };
  }
  const evaluate = Minifier.prototype.evaluateCostVariant;
  const candidates = [];
  Minifier.prototype.evaluateCostVariant = function (...args) {
    try {
      const result = evaluate.apply(this, args);
      candidates.push({ variants: args[0], bytes: result.byteLength });
      return result;
    } catch (error) {
      candidates.push({ variants: args[0], failed: true });
      throw error;
    }
  };
  return { Minifier, counts, candidates };
}
const baseline = load(path.resolve(baselineDist));
const current = load(path.resolve(__dirname, "../dist"));
const mode = {
  runtimeProfile: "stormworks",
  constantOptimizations: true,
  globalAliasing: false,
  requiredWhitespace: " ",
  requireWrapper: true,
  collectOptimizationDiagnostics: true,
};
function run(build, entry, overrides = {}) {
  for (const name of Object.keys(build.counts)) build.counts[name] = 0;
  build.candidates.length = 0;
  const start = performance.now();
  const minifier = new build.Minifier(
    entry,
    { luaVersion: "5.3", locations: true, ranges: true, comments: true },
    { ...mode, ...overrides },
  );
  const result = minifier
    .parse()
    .toStringWithSourceMap({ file: "main.min.lua" });
  return {
    ms: performance.now() - start,
    counts: { ...build.counts },
    code: result.code,
    map: result.map.toJSON(),
    diagnostics: minifier.optimizationDiagnostics,
    candidates: [...build.candidates],
  };
}
function compare(a, b) {
  assert.equal(b.code, a.code, "code");
  assert.deepEqual(b.map, a.map, "source map");
  assert.deepEqual(b.diagnostics, a.diagnostics, "diagnostics");
  assert.deepEqual(
    b.candidates,
    a.candidates,
    "all evaluated candidate masks/bytes/failures",
  );
}
const directory = fs.mkdtempSync(
  path.join(os.tmpdir(), "storm-cost-snapshots-"),
);
try {
  const synthetic = path.join(directory, "main.lua");
  fs.writeFileSync(
    synthetic,
    Array.from({ length: 100 }, (_, i) => `local v${i}=external(${i})`).join(
      "\n",
    ) +
      "\nreturn " +
      Array.from({ length: 100 }, (_, i) => `v${i}`).join("+"),
  );
  const fixtures = path.resolve(__dirname, "../test/fixtures");
  let fixturesCompared = 0;
  for (const name of fs.readdirSync(fixtures).sort()) {
    const entry = path.join(fixtures, name, "main.lua");
    if (!fs.existsSync(entry) || name === "circular-require") continue;
    for (const overrides of [
      {},
      { runtimeProfile: "lua53", requireWrapper: false },
      {
        allowObservableTableReadChanges: true,
        allowIntrospectionChanges: true,
      },
    ]) {
      for (const collectOptimizationDiagnostics of [false, true]) {
        const options = { ...overrides, collectOptimizationDiagnostics };
        compare(run(baseline, entry, options), run(current, entry, options));
        fixturesCompared++;
      }
    }
  }
  console.log(
    JSON.stringify({
      fixturesCompared,
      sameCode: true,
      sameMap: true,
      sameDiagnostics: true,
    }),
  );
  const cases = [["synthetic100", synthetic]];
  if (process.argv[3])
    cases.push(["external-input", path.resolve(process.argv[3])]);
  for (const [name, entry] of cases) {
    for (const collectOptimizationDiagnostics of [false, true]) {
      compare(
        run(baseline, entry, { collectOptimizationDiagnostics }),
        run(current, entry, { collectOptimizationDiagnostics }),
      );
    }
    compare(run(baseline, entry), run(current, entry)); // warm both builds
    let firstCounts;
    for (let pair = 0; pair < 5; pair++) {
      let a, b;
      if (pair % 2 === 0) {
        a = run(baseline, entry);
        b = run(current, entry);
      } else {
        b = run(current, entry);
        a = run(baseline, entry);
      }
      compare(a, b);
      const counts = { baseline: a.counts, current: b.counts };
      if (firstCounts)
        assert.deepEqual(
          counts,
          firstCounts,
          "deterministic invocation counts",
        );
      else firstCounts = counts;
      assert.ok(
        b.counts.analyzeStatementDataflow < a.counts.analyzeStatementDataflow,
        "statement dataflow calls decrease",
      );
      assert.ok(
        b.counts.analyzeValueFlow < a.counts.analyzeValueFlow,
        "value flow calls decrease",
      );
      console.log(
        JSON.stringify({
          name,
          pair,
          order: pair % 2 === 0 ? "baseline/current" : "current/baseline",
          baselineMs: a.ms,
          currentMs: b.ms,
          bytes: Buffer.byteLength(b.code),
          candidates: b.candidates,
          ...counts,
          sameCode: true,
          sameMap: true,
          sameDiagnostics: true,
        }),
      );
    }
  }
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
}
