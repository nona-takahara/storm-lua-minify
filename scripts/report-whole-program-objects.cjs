const { performance } = require("node:perf_hooks");
const Parser = require("luaparse");
const { Minifier } = require("../dist/minifier");

const entry = process.argv.slice(2).find((argument) => argument !== "--");
if (!entry) {
  throw new Error("Usage: pnpm report:whole-program-objects -- <entry.lua>");
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
    variant,
    "baseline",
  );
  const code = minifier.parse().toString();
  return { minifier, code, milliseconds: performance.now() - started };
}

run("trial");
const baseline = run("baseline");
const measured = [run("trial"), run("trial"), run("trial")];
const trial = measured.at(-1);
const analysis = trial.minifier.wholeProgramObjects;
if (!analysis) throw new Error("Whole-program object analysis is missing");

const colonCandidates = analysis.modules.reduce(
  (count, module) =>
    count +
    module.analysis.callGraph.calls.filter(
      (call) =>
        call.call.type === "CallExpression" &&
        call.call.base.type === "MemberExpression" &&
        call.call.base.indexer === ":",
    ).length,
  0,
);
const refusalReasons = {};
const refusalSamples = [];
const refusalSampleCounts = {};
analysis.diagnostics.forEach((diagnostic) => {
  if (diagnostic.reason === "resolved-method-target") return;
  refusalReasons[diagnostic.reason] =
    (refusalReasons[diagnostic.reason] ?? 0) + 1;
  const sampleCount = refusalSampleCounts[diagnostic.reason] ?? 0;
  if (sampleCount < 3) {
    const source = trial.minifier.moduleSourceText.get(diagnostic.moduleName);
    refusalSamples.push({
      reason: diagnostic.reason,
      moduleName: diagnostic.moduleName,
      sourceRange: diagnostic.sourceRange,
      source:
        source && diagnostic.sourceRange
          ? source.slice(diagnostic.sourceRange[0], diagnostic.sourceRange[1])
          : undefined,
    });
    refusalSampleCounts[diagnostic.reason] = sampleCount + 1;
  }
});
const prunedMethodParameters = trial.minifier.optimizationDiagnostics
  .filter(
    (diagnostic) =>
      diagnostic.pass === "whole-program-method-parameter-pruning" &&
      diagnostic.decision === "accepted",
  )
  .reduce((total, diagnostic) => total + (diagnostic.candidateSize ?? 0), 0);
const times = measured
  .map((result) => result.milliseconds)
  .sort((left, right) => left - right);
const baselineBytes = Buffer.byteLength(baseline.code);
const trialBytes = Buffer.byteLength(trial.code);

console.log(
  JSON.stringify(
    {
      entry,
      moduleCount: analysis.modules.length,
      objectIdentityCount: analysis.objects.length,
      methodCandidates: colonCandidates,
      resolvedMethods: analysis.resolvedMethods.length,
      prunedMethodParameters,
      refusalReasons,
      refusalSamples,
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
