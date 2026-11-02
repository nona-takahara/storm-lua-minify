// Build first. Optionally compare with a separately built baseline via --baseline-dist.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { performance } = require("node:perf_hooks");
const { Minifier } = require("../dist/minifier.js");
const baselineIndex = process.argv.indexOf("--baseline-dist");
const Baseline =
  baselineIndex < 0
    ? undefined
    : require(path.resolve(process.argv[baselineIndex + 1], "minifier.js"))
        .Minifier;
const parse = { luaVersion: "5.3", locations: true, ranges: true, scope: true };
const mode = {
  runtimeProfile: "stormworks",
  requiredWhitespace: " ",
  globalAliasing: false,
  functionInlining: false,
  collectOptimizationDiagnostics: true,
};
const directory = fs.mkdtempSync(
  path.join(os.tmpdir(), "storm-specialization-budget-"),
);
const large = `local function f(enabled) if enabled then return 1 end return 2 end local t={${[...Array(2048).fill("f(true)"), "f(false)", "f(false)"].join(",")}} local total=0 for _,v in ipairs(t) do total=total+v end return total`;
function compile(Type, entry, options = mode) {
  const minifier = new Type(entry, parse, options);
  const output = minifier
    .parse()
    .toStringWithSourceMap({ file: "main.min.lua" });
  return {
    code: output.code,
    map: output.map.toJSON(),
    diagnostics: minifier.optimizationDiagnostics,
  };
}
function execute(source, label) {
  const filename = path.join(directory, `${label}.lua`);
  fs.writeFileSync(
    filename,
    `local values=table.pack(assert(load([====[${source}]====],"case"))()) for i=1,values.n do print(tostring(values[i])) end`,
  );
  const output = path.join(directory, `${label}.stdout`);
  const errors = path.join(directory, `${label}.stderr`);
  const out = fs.openSync(output, "w");
  const err = fs.openSync(errors, "w");
  try {
    const result = spawnSync(process.env.LUA53 || "lua5.3", [filename], {
      stdio: ["ignore", out, err],
    });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, fs.readFileSync(errors, "utf8"));
    return fs.readFileSync(output, "utf8");
  } finally {
    fs.closeSync(out);
    fs.closeSync(err);
  }
}
function median(values) {
  return [...values].sort((a, b) => a - b)[2];
}
try {
  const entry = path.join(directory, "main.lua");
  fs.writeFileSync(entry, large);
  const without = compile(Minifier, entry, {
    ...mode,
    functionSpecialization: false,
  });
  const current = compile(Minifier, entry);
  assert(current.code.length < without.code.length);
  assert(
    current.diagnostics.some(
      (d) =>
        d.pass === "aggregate-function-specialization" &&
        d.reason === "variant-created",
    ),
  );
  assert.equal(execute(large, "large-original"), "2052\n");
  assert.equal(execute(current.code, "large-minified"), "2052\n");
  console.log(
    JSON.stringify({
      case: "2050-sites",
      withoutBytes: Buffer.byteLength(without.code),
      currentBytes: Buffer.byteLength(current.code),
      lua: "matched",
    }),
  );
  const small = "local function f(x)return x end return f(1)";
  fs.writeFileSync(entry, small);
  assert.equal(
    compile(Minifier, entry).code,
    compile(Minifier, entry, { ...mode, functionSpecialization: false }).code,
  );
  console.log("PASS nonshrinking input unchanged");
  if (Baseline) {
    fs.writeFileSync(entry, large);
    const old = compile(Baseline, entry);
    assert(!old.diagnostics.some((d) => d.reason === "variant-created"));
    assert(
      old.diagnostics.some((d) => d.reason === "specialization-site-limit"),
    );
    assert(current.code.length < old.code.length);
    console.log(
      JSON.stringify({
        case: "former-site-cap",
        baselineBytes: Buffer.byteLength(old.code),
        currentBytes: Buffer.byteLength(current.code),
      }),
    );
    const fixtureRoot = path.resolve(__dirname, "../test/fixtures");
    let comparisons = 0;
    let expectedRejections = 0;
    const fixtures = fs
      .readdirSync(fixtureRoot)
      .sort()
      .map((name) => path.join(fixtureRoot, name, "main.lua"))
      .filter((file) => fs.existsSync(file));
    for (const fixture of fixtures) {
      for (const runtimeProfile of ["lua53", "stormworks"]) {
        const options = {
          runtimeProfile,
          requiredWhitespace: " ",
          requireWrapper: true,
          globalAliasing: false,
          constantOptimizations: true,
          collectOptimizationDiagnostics: true,
        };
        if (path.basename(path.dirname(fixture)) === "circular-require") {
          for (const Type of [Minifier, Baseline]) {
            assert.throws(
              () => compile(Type, fixture, options),
              /Circular require\/dofile detected: a -> b -> a/,
            );
          }
          expectedRejections++;
          continue;
        }
        assert.deepEqual(
          compile(Minifier, fixture, options),
          compile(Baseline, fixture, options),
          `${path.relative(fixtureRoot, fixture)} (${runtimeProfile})`,
        );
        comparisons++;
      }
    }
    console.log(
      `PASS ${comparisons} fixture output / Source Map / diagnostics comparisons; ${expectedRejections} expected circular-input rejections`,
    );
    const workloads = [
      ["2050-sites", entry, mode],
      [
        "field-renames",
        path.join(fixtureRoot, "whole-program-field-renames-report/main.lua"),
        { ...mode, requireWrapper: true, constantOptimizations: true },
      ],
    ];
    for (const [name, file, options] of workloads) {
      compile(Baseline, file, options);
      compile(Minifier, file, options);
      const before = [],
        after = [];
      for (let pair = 0; pair < 5; pair++) {
        for (const [Type, times] of pair % 2 === 0
          ? [
              [Baseline, before],
              [Minifier, after],
            ]
          : [
              [Minifier, after],
              [Baseline, before],
            ]) {
          const started = performance.now();
          compile(Type, file, options);
          times.push(performance.now() - started);
        }
      }
      console.log(
        JSON.stringify({
          case: name,
          beforeMilliseconds: before,
          afterMilliseconds: after,
          beforeMedian: median(before),
          afterMedian: median(after),
          ratio: median(after) / median(before),
        }),
      );
    }
  }
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
}
