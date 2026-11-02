// Build both revisions first. The baseline directory must contain minifier.js.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { performance } = require("node:perf_hooks");

const baselineDist = process.argv[2];
if (!baselineDist)
  throw new Error(
    "Usage: verify-interference.cjs <baseline-dist> [entry.lua ...]",
  );
const Base = require(path.resolve(baselineDist, "minifier.js")).Minifier;
const Next = require("../dist/minifier.js").Minifier;
const mode = {
  runtimeProfile: "stormworks",
  constantOptimizations: true,
  globalAliasing: false,
  requiredWhitespace: " ",
  requireWrapper: true,
  collectOptimizationDiagnostics: true,
};
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "storm-interference-"));
function run(Type, entry, selected) {
  const start = performance.now();
  const minifier = selected
    ? new Type(entry, { luaVersion: "5.3" }, mode)
    : new Type(
        entry,
        { luaVersion: "5.3" },
        mode,
        "trial",
        "trial",
        "trial",
        "trial",
        "trial",
        "trial",
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
function equal(a, b) {
  assert.equal(b.code, a.code, "code");
  assert.deepEqual(b.map, a.map, "source map");
  assert.deepEqual(b.diagnostics, a.diagnostics, "diagnostics");
}
function median(values) {
  return [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
}
function measure(label, entry, selected, samplesPerPair = 1) {
  // Warm both implementations; alternate which revision goes first per pair.
  equal(run(Base, entry, selected), run(Next, entry, selected));
  const before = [],
    after = [];
  for (let pair = 0; pair < 5; pair++) {
    let beforeMs = 0,
      afterMs = 0;
    for (let sample = 0; sample < samplesPerPair; sample++) {
      let a, b;
      if (pair % 2 === 0) {
        a = run(Base, entry, selected);
        b = run(Next, entry, selected);
      } else {
        b = run(Next, entry, selected);
        a = run(Base, entry, selected);
      }
      equal(a, b);
      beforeMs += a.ms;
      afterMs += b.ms;
    }
    before.push(beforeMs / samplesPerPair);
    after.push(afterMs / samplesPerPair);
  }
  console.log(
    JSON.stringify({
      label,
      selection: selected ? "normal" : "one-trial",
      samplesPerPair,
      before,
      after,
      beforeMedian: median(before),
      afterMedian: median(after),
      equal: true,
    }),
  );
}
try {
  const fixtures = fs
    .readdirSync(path.resolve(__dirname, "../test/fixtures"), {
      withFileTypes: true,
    })
    .filter((e) => e.isDirectory() && e.name !== "circular-require")
    .map((e) => [
      e.name,
      path.resolve(__dirname, "../test/fixtures", e.name, "main.lua"),
    ])
    .filter(([, entry]) => fs.existsSync(entry));
  // Every fixture is checked once with normal candidate selection.
  for (const [label, entry] of fixtures) {
    equal(run(Base, entry, true), run(Next, entry, true));
    console.log(JSON.stringify({ fixture: label, equal: true }));
  }
  for (const name of [
    "single-file",
    "const-fold",
    "whole-program-field-renames-report",
  ])
    measure(name, fixtures.find(([label]) => label === name)[1], true, 10);
  for (const count of [100, 180, 400]) {
    const entry = path.join(directory, `dense-${count}.lua`);
    fs.writeFileSync(
      entry,
      Array.from(
        { length: count },
        (_, i) => `local v${i}=external(${i})`,
      ).join("\n") +
        "\nreturn " +
        Array.from({ length: count }, (_, i) => `v${i}`).join("+"),
    );
    measure(`dense-${count}${count > 200 ? "-stress-only" : ""}`, entry, false);
    if (count === 100) measure("dense-100", entry, true);
  }
  for (const [index, entry] of process.argv.slice(3).entries())
    measure(`additional-${index + 1}`, path.resolve(entry), true);
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
}
