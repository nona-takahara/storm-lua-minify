const { performance } = require("node:perf_hooks");
const Parser = require("luaparse");
const { Minifier } = require("../dist/minifier");
const { resolveScopes } = require("../dist/resolver");

const entry = process.argv.slice(2).find((argument) => argument !== "--");
if (!entry) {
  throw new Error("Usage: pnpm report:whole-program-exports -- <entry.lua>");
}

const parseSettings = {
  comments: true,
  locations: true,
  luaVersion: "5.3",
  ranges: true,
};
const mode = {
  requireWrapper: true,
  runtimeProfile: "stormworks",
  collectOptimizationDiagnostics: true,
};

function run(variant) {
  const started = performance.now();
  const minifier = new Minifier(
    entry,
    parseSettings,
    mode,
    undefined,
    "trial",
    "trial",
    "trial",
    variant,
  );
  const code = minifier.parse().toString();
  return { minifier, code, milliseconds: performance.now() - started };
}

run("trial");
const baseline = run("baseline");
const measured = [run("trial"), run("trial"), run("trial")];
const trial = measured.at(-1);
const reachability = trial.minifier.optimizationDiagnostics.filter(
  (diagnostic) => diagnostic.pass === "whole-program-export-reachability",
);
const rewrites = trial.minifier.optimizationDiagnostics.filter(
  (diagnostic) => diagnostic.pass === "whole-program-export-dce",
);
const count = (diagnostics, reason) =>
  diagnostics
    .filter((diagnostic) => diagnostic.reason === reason)
    .reduce((total, diagnostic) => total + (diagnostic.candidateSize ?? 1), 0);
const retentionReasons = {};
reachability
  .filter(
    (diagnostic) =>
      diagnostic.decision === "rejected" && diagnostic.reason !== "field-live",
  )
  .forEach((diagnostic) => {
    retentionReasons[diagnostic.reason] =
      (retentionReasons[diagnostic.reason] ?? 0) +
      (diagnostic.candidateSize ?? 1);
  });
rewrites
  .filter((diagnostic) => diagnostic.decision === "rejected")
  .forEach((diagnostic) => {
    retentionReasons[diagnostic.reason] =
      (retentionReasons[diagnostic.reason] ?? 0) +
      (diagnostic.candidateSize ?? 1);
  });
const times = measured
  .map((result) => result.milliseconds)
  .sort((left, right) => left - right);
const baselineBytes = Buffer.byteLength(baseline.code);
const trialBytes = Buffer.byteLength(trial.code);
const assignedGlobals = (code) => {
  const resolved = resolveScopes(Parser.parse(code, { luaVersion: "5.3" }));
  return [...resolved.globals]
    .filter(([, binding]) => binding.writes.length > 0)
    .map(([name]) => name)
    .sort();
};
const baselineGlobals = assignedGlobals(baseline.code);
const trialGlobals = assignedGlobals(trial.code);

console.log(
  JSON.stringify(
    {
      entry,
      moduleCount: trial.minifier.wholeProgramObjects?.modules.length ?? 0,
      candidateExportFields: count(reachability, "export-field-candidate"),
      liveExportFields: count(reachability, "field-live"),
      unreachableExportFields: count(reachability, "field-unreachable"),
      unreachableFieldNames: reachability
        .filter((diagnostic) => diagnostic.reason === "field-unreachable")
        .map(
          (diagnostic) =>
            `${diagnostic.moduleName ?? "unknown"}.${diagnostic.fieldName ?? "unknown"}`,
        )
        .sort(),
      removedExportFields: count(rewrites, "field-removed"),
      removedFieldNames: rewrites
        .filter((diagnostic) => diagnostic.reason === "field-removed")
        .map(
          (diagnostic) =>
            `${diagnostic.moduleName ?? "unknown"}.${diagnostic.fieldName ?? "unknown"}`,
        )
        .sort(),
      removedPrivateHelpers: trial.minifier.optimizationDiagnostics
        .filter(
          (diagnostic) =>
            diagnostic.pass === "function-dce" &&
            diagnostic.decision === "accepted",
        )
        .reduce(
          (total, diagnostic) => total + (diagnostic.candidateSize ?? 1),
          0,
        ),
      preservedInitializerEffects: count(rewrites, "field-effect-preserved"),
      retentionReasons,
      baselineBytes,
      trialBytes,
      byteDifference: trialBytes - baselineBytes,
      adoptedByStrictCostGate: trialBytes < baselineBytes,
      assignedGlobalContractPreserved:
        JSON.stringify(baselineGlobals) === JSON.stringify(trialGlobals),
      assignedGlobals: trialGlobals,
      measuredMilliseconds: times,
      medianMilliseconds: times[1],
      outputParsesAsLua53: Boolean(
        Parser.parse(trial.code, { luaVersion: "5.3" }),
      ),
    },
    null,
    2,
  ),
);
