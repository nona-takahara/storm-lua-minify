const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Minifier } = require("../dist/minifier.js");
const {
  summarizeOptimizationDiagnostics,
} = require("../dist/optimizerDiagnostics.js");
const {
  selectTransactionalMinifierVariant,
} = require("../dist/optimizerTransaction.js");

const fixtures = [
  {
    name: "accepted-table",
    source: "local t={x=1,y=2} local a=t.x tick() local b=t.y use(a,b)",
  },
  { name: "dynamic-key", source: "local t={} local a=t[key] use(a)" },
  {
    name: "call-escape",
    source: "local t={x=1} consume(t) local a=t.x use(a)",
  },
  {
    name: "control-flow",
    source: "local a=1 tick() if ready then use(a) end local b=2 use(b)",
  },
  {
    name: "cost",
    source: "local first=1 tick() local second=2 use(first,second)",
  },
];

const directory = fs.mkdtempSync(
  path.join(os.tmpdir(), "storm-optimizer-report-"),
);
try {
  const diagnostics = [];
  const transactions = [];
  fixtures.forEach((fixture) => {
    const fixtureDirectory = path.join(directory, fixture.name);
    fs.mkdirSync(fixtureDirectory);
    const entry = path.join(fixtureDirectory, "main.lua");
    fs.writeFileSync(entry, fixture.source);
    const minifier = new Minifier(
      entry,
      { luaVersion: "5.3" },
      {
        requireWrapper: false,
        runtimeProfile: "stormworks",
        collectOptimizationDiagnostics: true,
      },
    );
    minifier.parse();
    diagnostics.push(...minifier.optimizationDiagnostics);
    const transaction = selectTransactionalMinifierVariant({
      entryFilePath: entry,
      luaParseSettings: { luaVersion: "5.3" },
      baselineMode: {
        requireWrapper: false,
        runtimeProfile: "stormworks",
        statementOptimizations: false,
      },
      trialMode: {
        requireWrapper: false,
        runtimeProfile: "stormworks",
      },
    });
    transactions.push({
      fixture: fixture.name,
      accepted: transaction.accepted,
      reason: transaction.accepted ? undefined : transaction.reason,
      baselineBytes: transaction.baseline.byteLength,
      trialBytes: transaction.trial?.byteLength,
      byteSavings: transaction.byteSavings,
    });
  });
  process.stdout.write(
    JSON.stringify(
      {
        fixtureCount: fixtures.length,
        diagnostics: summarizeOptimizationDiagnostics(diagnostics),
        transactions,
      },
      null,
      2,
    ) + "\n",
  );
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
}
