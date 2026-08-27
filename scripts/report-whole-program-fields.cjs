const { performance } = require("node:perf_hooks");
const Parser = require("luaparse");
const { Minifier } = require("../dist/minifier");

const entry = process.argv.slice(2).find((argument) => argument !== "--");
if (!entry) {
  throw new Error("Usage: pnpm report:whole-program-fields -- <entry.lua>");
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
const analysis = trial.minifier.wholeProgramFields;
if (!analysis) throw new Error("Whole-program field analysis is missing");

const refusalReasons = {};
analysis.diagnostics.forEach((diagnostic) => {
  if (diagnostic.reason === "field-fact") return;
  refusalReasons[diagnostic.reason] =
    (refusalReasons[diagnostic.reason] ?? 0) + 1;
});
const countRewrite = (reason) =>
  trial.minifier.optimizationDiagnostics
    .filter(
      (diagnostic) =>
        diagnostic.pass === "whole-program-constructor-field-rewrite" &&
        diagnostic.reason === reason,
    )
    .reduce((count, diagnostic) => count + (diagnostic.candidateSize ?? 0), 0);
const downstreamDce = trial.minifier.optimizationDiagnostics
  .filter(
    (diagnostic) =>
      diagnostic.pass === "function-dce" && diagnostic.decision === "accepted",
  )
  .reduce((count, diagnostic) => count + (diagnostic.candidateSize ?? 0), 0);
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
      annotationFacts: analysis.annotationFacts.length,
      authorizedAnnotationFacts: analysis.annotationFacts.filter(
        (fact) => fact.authorized,
      ).length,
      stableFieldFacts: analysis.facts.filter(
        (fact) => fact.value && fact.invalidationReasons.size === 0,
      ).length,
      refusalReasons,
      replacedFieldReads: countRewrite("field-read-replaced"),
      removedFieldWrites: countRewrite("dead-field-write"),
      preservedWriteEffects: countRewrite("field-write-effect-preserved"),
      downstreamDce,
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
