const { performance } = require("node:perf_hooks");
const Parser = require("luaparse");
const { Minifier } = require("../dist/minifier");

const entry = process.argv.slice(2).find((argument) => argument !== "--");
if (!entry) {
  throw new Error("Usage: pnpm report:aggregate-specialization -- <entry.lua>");
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
    variant,
  );
  const code = minifier.parse().toString();
  return { minifier, code, milliseconds: performance.now() - started };
}

run("trial");
const baseline = run("baseline");
const measured = [run("trial"), run("trial"), run("trial")];
const trial = measured.at(-1);
const specialization = trial.minifier.optimizationDiagnostics.filter(
  (diagnostic) => diagnostic.pass === "aggregate-function-specialization",
);
const refusalReasons = {};
specialization
  .filter((diagnostic) => diagnostic.decision === "rejected")
  .forEach((diagnostic) => {
    refusalReasons[diagnostic.reason] =
      (refusalReasons[diagnostic.reason] ?? 0) +
      (diagnostic.candidateSize ?? 1);
  });
const count = (reason) =>
  specialization
    .filter((diagnostic) => diagnostic.reason === reason)
    .reduce((total, diagnostic) => total + (diagnostic.candidateSize ?? 1), 0);
const times = measured
  .map((result) => result.milliseconds)
  .sort((left, right) => left - right);
const baselineBytes = Buffer.byteLength(baseline.code);
const trialBytes = Buffer.byteLength(trial.code);

console.log(
  JSON.stringify(
    {
      entry,
      moduleCount: trial.minifier.wholeProgramObjects?.modules.length ?? 0,
      candidateCallables: new Set(
        specialization.map((diagnostic) =>
          [diagnostic.moduleName, diagnostic.sourceRange].join(":"),
        ),
      ).size,
      specializedCallSites: count("variant-created"),
      downstreamDeadFieldWrites: count("dead-field-write"),
      refusalReasons,
      adoptedPlans: trialBytes < baselineBytes ? 1 : 0,
      baselineBytes,
      trialBytes,
      byteDifference: trialBytes - baselineBytes,
      adoptedByStrictCostGate: trialBytes < baselineBytes,
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
