const path = require("node:path");
const { performance } = require("node:perf_hooks");
const Parser = require("luaparse");
const { Minifier } = require("../dist/minifier");

const entry =
  process.argv.slice(2).find((argument) => argument !== "--") ??
  path.join(
    __dirname,
    "..",
    "test",
    "fixtures",
    "whole-program-field-renames-report",
    "main.lua",
  );
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
    undefined,
    undefined,
    undefined,
    undefined,
    variant,
  );
  const code = minifier.parse().toString();
  return { minifier, code, milliseconds: performance.now() - started };
}

run("trial");
const baseline = run("baseline");
const measured = [run("trial"), run("trial"), run("trial")];
const trial = measured.at(-1);
const plan = trial.minifier.wholeProgramFieldRenames;
const rejected = trial.minifier.optimizationDiagnostics.filter(
  (diagnostic) =>
    diagnostic.pass === "whole-program-field-rename" &&
    diagnostic.decision === "rejected",
);
const retentionReasons = {};
rejected.forEach((diagnostic) => {
  retentionReasons[diagnostic.reason] =
    (retentionReasons[diagnostic.reason] ?? 0) +
    (diagnostic.candidateSize ?? 1);
});
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
      candidateFields: plan?.candidateFields ?? 0,
      equivalenceClasses: plan?.equivalenceClasses ?? 0,
      shortenedFields: plan?.shortenedFields ?? 0,
      safeKeyTransfers: plan?.keyTransfers ?? 0,
      reusedKeys: plan?.reusedKeys ?? 0,
      retentionReasons,
      retainedFieldNames: [
        ...new Set(
          rejected
            .map((diagnostic) => diagnostic.fieldName)
            .filter((name) => name !== undefined),
        ),
      ].sort(),
      unresolvedAccesses: rejected
        .filter(
          (diagnostic) =>
            diagnostic.reason === "unknown-call" &&
            diagnostic.sourceRange !== undefined,
        )
        .map((diagnostic) => ({
          moduleName: diagnostic.moduleName,
          fieldName: diagnostic.fieldName,
          sourceRange: diagnostic.sourceRange,
        })),
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
