// Build first. Measures the finite signature budget against a separately built revision.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { performance } = require("node:perf_hooks");
const parse = { luaVersion: "5.3", locations: true, ranges: true };
const mode = {
  runtimeProfile: "stormworks",
  requiredWhitespace: " ",
  requireWrapper: true,
  functionInlining: false,
  globalAliasing: false,
  collectOptimizationDiagnostics: true,
};
function project(directory, count) {
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(
    path.join(directory, "shared.lua"),
    "local F={} function F.f(tag)if tag then return tag end return 0 end return F",
  );
  for (let index = 0; index < count; index++) {
    const literal = JSON.stringify(
      `signature-${String(index).padStart(4, "0")}-${"x".repeat(96)}`,
    );
    fs.writeFileSync(
      path.join(directory, `m${index}.lua`),
      `local F=require("shared") return F.f(${literal}),F.f(${literal}),F.f(${literal})`,
    );
  }
  const entry = path.join(directory, "main.lua");
  fs.writeFileSync(
    entry,
    `return {${Array.from({ length: count }, (_, i) => `require("m${i}")`).join(",")}}`,
  );
  return entry;
}
function compile(dist, entry) {
  const { Minifier } = require(path.resolve(dist, "minifier.js"));
  const minifier = new Minifier(entry, parse, mode);
  const code = minifier.parse().toString();
  const diagnostics = minifier.optimizationDiagnostics;
  return {
    code,
    bytes: Buffer.byteLength(code),
    variants: diagnostics.filter(
      (d) =>
        d.pass === "aggregate-function-specialization" &&
        d.reason === "variant-created",
    ).length,
    variantRefusals: diagnostics.filter(
      (d) => d.reason === "specialization-variant-limit",
    ).length,
    siteRefusals: diagnostics.filter(
      (d) => d.reason === "specialization-site-limit",
    ).length,
    runtimeRefusals: diagnostics.filter(
      (d) => d.reason === "runtime-resource-limit",
    ).length,
    failures: diagnostics.filter((d) => d.pass === "optimizer-cost-failure")
      .length,
    accepted: diagnostics.some(
      (d) =>
        d.pass === "aggregate-specialization-final-cost" &&
        d.decision === "accepted",
    ),
  };
}
function warm(dist, directory) {
  const entry = path.join(directory, "warm.lua");
  fs.writeFileSync(
    entry,
    "local function f(x)if x then return 1 end return 2 end return f(true)+f(false)",
  );
  compile(dist, entry);
}
function lua(file, directory, label) {
  const script = path.join(directory, `${label}.lua`);
  fs.writeFileSync(
    script,
    `package.path=${JSON.stringify(path.dirname(file) + "/?.lua;")}..package.path local t=assert(loadfile(${JSON.stringify(file)}))() print(#t) for i=1,#t do local v=t[i] print(i,type(v),string.format("%q",tostring(v))) end`,
  );
  const outFile = path.join(directory, `${label}.stdout`),
    errFile = path.join(directory, `${label}.stderr`);
  const out = fs.openSync(outFile, "w"),
    err = fs.openSync(errFile, "w");
  try {
    const result = spawnSync(process.env.LUA53 || "lua5.3", [script], {
      stdio: ["ignore", out, err],
    });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, fs.readFileSync(errFile, "utf8"));
    return fs.readFileSync(outFile, "utf8");
  } finally {
    fs.closeSync(out);
    fs.closeSync(err);
  }
}
function peak(dist, entry, directory, label) {
  const outFile = path.join(directory, `${label}.json`),
    errFile = path.join(directory, `${label}.stderr`);
  const out = fs.openSync(outFile, "w"),
    err = fs.openSync(errFile, "w");
  try {
    const result = spawnSync(
      process.execPath,
      [__filename, "--child", dist, entry, directory, label],
      { stdio: ["ignore", out, err] },
    );
    if (result.error) throw result.error;
    assert.equal(result.status, 0, fs.readFileSync(errFile, "utf8"));
    return JSON.parse(fs.readFileSync(outFile, "utf8"));
  } finally {
    fs.closeSync(out);
    fs.closeSync(err);
  }
}
function median(times) {
  return [...times].sort((a, b) => a - b)[Math.floor(times.length / 2)];
}
if (process.argv[2] === "--child") {
  const [dist, entry, directory, label] = process.argv.slice(3);
  warm(dist, directory);
  const start = performance.now();
  const result = compile(dist, entry);
  const milliseconds = performance.now() - start;
  const codeFile = path.join(path.dirname(entry), `${label}.min.lua`);
  fs.writeFileSync(codeFile, result.code);
  delete result.code;
  console.log(
    JSON.stringify({
      ...result,
      milliseconds,
      peakRSSMiB: process.resourceUsage().maxRSS / 1024,
      codeFile,
    }),
  );
} else {
  const index = process.argv.indexOf("--baseline-dist");
  if (index < 0 || !process.argv[index + 1])
    throw new Error(
      "Usage: node --expose-gc scripts/measure-specialization-budget.cjs --baseline-dist BASELINE_DIST",
    );
  const baseline = path.resolve(process.argv[index + 1]),
    current = path.resolve(__dirname, "../dist");
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "storm-budget-stress-"),
  );
  try {
    for (const count of [1000, 1025]) {
      const entry = project(path.join(directory, String(count)), count);
      const before = [],
        after = [];
      const pairs = count === 1000 ? 5 : 1;
      warm(baseline, directory);
      warm(current, directory);
      let old, now;
      for (let pair = 0; pair < pairs; pair++) {
        for (const [dist, times] of pair % 2 === 0
          ? [
              [baseline, before],
              [current, after],
            ]
          : [
              [current, after],
              [baseline, before],
            ]) {
          if (global.gc) global.gc();
          const start = performance.now();
          const result = compile(dist, entry);
          times.push(performance.now() - start);
          if (dist === baseline) old = result;
          else now = result;
          assert.equal(result.failures, 0);
          assert.equal(result.runtimeRefusals, 0);
        }
        assert.equal(old.variants, 0);
        assert(old.siteRefusals > 0);
        assert.equal(now.variants, Math.min(count, 1024));
        assert(now.accepted);
        assert(now.bytes < old.bytes);
        assert.equal(now.variantRefusals > 0, count > 1024);
        console.log(
          JSON.stringify({
            stage: "timing",
            count,
            pair: pair + 1,
            beforeMilliseconds: before.at(-1),
            afterMilliseconds: after.at(-1),
          }),
        );
      }
      old = peak(baseline, entry, directory, `baseline-${count}`);
      now = peak(current, entry, directory, `current-${count}`);
      assert.equal(old.variants, 0);
      assert.equal(now.variants, Math.min(count, 1024));
      assert.equal(now.variantRefusals > 0, count > 1024);
      assert.equal(now.runtimeRefusals, 0);
      assert.equal(now.failures, 0);
      assert(now.accepted);
      assert(now.bytes < old.bytes);
      const original = lua(entry, directory, `original-${count}`);
      assert.equal(lua(old.codeFile, directory, `old-${count}`), original);
      assert.equal(lua(now.codeFile, directory, `new-${count}`), original);
      console.log(
        JSON.stringify({
          count,
          pairs,
          beforeMilliseconds: before,
          afterMilliseconds: after,
          beforeMedian: median(before),
          afterMedian: median(after),
          baseline: old,
          current: now,
          lua: "all values and types matched",
        }),
      );
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
