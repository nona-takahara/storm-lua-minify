// Compare independently built revisions in one process with alternating order.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { performance } = require("node:perf_hooks");

const baselineDist = process.argv[2];
if (!baselineDist)
  throw new Error(
    "Usage: node scripts/verify-sparse-statement-dependencies.cjs BASELINE_DIST [EXTERNAL_ENTRY]",
  );
function load(dist) {
  return { Minifier: require(path.join(dist, "minifier.js")).Minifier };
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
    code: result.code,
    map: result.map.toJSON(),
    diagnostics: minifier.optimizationDiagnostics,
  };
}
function compare(a, b) {
  assert.equal(b.code, a.code, "code");
  assert.deepEqual(b.map, a.map, "source map");
  assert.deepEqual(b.diagnostics, a.diagnostics, "diagnostics");
}
const directory = fs.mkdtempSync(
  path.join(os.tmpdir(), "storm-sparse-statements-"),
);
try {
  const synthetic = path.join(directory, "main.lua");
  fs.writeFileSync(
    synthetic,
    Array.from({ length: 600 }, (_, i) => `external(${i})`).join("\n"),
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
      compare(run(baseline, entry, overrides), run(current, entry, overrides));
      fixturesCompared++;
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
  const cases = [
    ["dense-calls600", synthetic],
    ["small-fixture", path.join(fixtures, "const-fold/main.lua")],
    [
      "representative-fixture",
      path.join(fixtures, "whole-program-field-renames-report/main.lua"),
    ],
  ];
  if (process.argv[3])
    cases.push(["external-input", path.resolve(process.argv[3])]);
  for (const [name, entry] of cases) {
    compare(run(baseline, entry), run(current, entry)); // warm both builds
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
      console.log(
        JSON.stringify({
          name,
          pair,
          order: pair % 2 === 0 ? "baseline/current" : "current/baseline",
          baselineMs: a.ms,
          currentMs: b.ms,
          bytes: Buffer.byteLength(b.code),
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
