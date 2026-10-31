// Checks that --assume-closed-field-names does not change what a Stormworks Lua node does.
//
// usage: node scripts/verify-closed-field-names.cjs <entry.lua>... [--config <json>] [--ticks <n>]
//
// For each entry it builds the script twice with the built CLI (dist/cli.js), once without field
// renaming and once with --assume-closed-field-names, runs both under a stub environment with the
// same pseudo-random inputs (scripts/stormworks-node-trace.lua), and compares every call that
// leaves the script. The comparison catches a renaming that changes behaviour in the paths the
// random inputs reach; it is not a proof, and a script that never calls onTick/onDraw is reported.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const cli = path.join(__dirname, "..", "dist", "cli.js");
const trace = path.join(__dirname, "stormworks-node-trace.lua");

const args = process.argv.slice(2);
const entries = [];
let config;
let ticks = 600;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--config") config = args[++i];
  else if (args[i] === "--ticks") ticks = Number(args[++i]);
  else entries.push(args[i]);
}
if (entries.length === 0) {
  console.error(
    "usage: node scripts/verify-closed-field-names.cjs <entry.lua>... [--config <json>] [--ticks <n>]",
  );
  process.exit(2);
}
if (!fs.existsSync(cli)) {
  console.error("dist/cli.js is missing. Run `pnpm run build` first.");
  process.exit(2);
}

function build(entry, directory, extra) {
  // The CLI writes next to its input, and `dofile`/`require` resolve relative to it. Copy the
  // entry's folder so the repository stays untouched.
  const source = path.resolve(entry);
  fs.cpSync(path.dirname(source), directory, { recursive: true });
  const copy = path.join(directory, path.basename(source));
  const run = spawnSync(
    process.execPath,
    [
      cli,
      copy,
      "--no-progress",
      ...(config ? ["--config", path.resolve(config)] : []),
      ...extra,
    ],
    { encoding: "utf8" },
  );
  const output = copy.replace(/\.lua$/, ".min.lua");
  if (run.status !== 0 || !fs.existsSync(output))
    throw new Error(`build failed for ${entry}:\n${run.stderr}`);
  return output;
}

const profiles = ["mixed", "small"];

function lines(script, profile) {
  const run = spawnSync("lua", [trace, script, String(ticks), "1", profile], {
    encoding: "utf8",
    maxBuffer: 1 << 28,
  });
  if (run.status !== 0) throw new Error(`${script} failed:\n${run.stderr}`);
  return run.stdout.split("\n");
}

let failed = false;
let totalReference = 0;
let totalClosed = 0;
for (const entry of entries) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "closed-fields-"));
  try {
    const reference = build(entry, path.join(directory, "reference"), [
      "--no-field-renaming",
    ]);
    const closed = build(entry, path.join(directory, "closed"), [
      "--assume-closed-field-names",
    ]);
    const sizeOf = (file) => [...fs.readFileSync(file, "utf8")].length;
    totalReference += sizeOf(reference);
    totalClosed += sizeOf(closed);
    const label = `${entry}: ${sizeOf(reference)} -> ${sizeOf(closed)} chars`;
    const results = profiles.map((profile) => {
      const a = lines(reference, profile);
      const b = lines(closed, profile);
      const calls = a.filter(
        (line) => !line.startsWith("-- ") && line !== "",
      ).length;
      const ticksRun = a.filter((line) => line.startsWith("-- tick")).length;
      const stopped = a.some((line) => line.startsWith("-- error at"));
      let index = a.findIndex((line, i) => line !== b[i]);
      if (index < 0 && a.length !== b.length)
        index = Math.min(a.length, b.length);
      return { profile, a, b, calls, ticksRun, stopped, index };
    });
    const summary = results
      .map(
        (r) =>
          `${r.profile}: ${r.calls} calls/${r.ticksRun} ticks${r.stopped ? " (stopped by error)" : ""}`,
      )
      .join(", ");
    const mismatch = results.find((r) => r.index >= 0);
    if (mismatch) {
      failed = true;
      const { a, b, index, profile } = mismatch;
      console.log(
        `FAIL ${label} [${profile}]\n  line ${index + 1}\n  reference: ${a[index]}\n  closed:    ${b[index]}`,
      );
    } else if (results.every((r) => r.calls === 0)) {
      failed = true;
      console.log(
        `FAIL ${label}: the script made no observable calls, so nothing was compared`,
      );
    } else {
      console.log(`ok   ${label}; ${summary}`);
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
console.log(
  `total ${totalReference} -> ${totalClosed} chars over ${entries.length} scripts`,
);
process.exit(failed ? 1 : 0);
