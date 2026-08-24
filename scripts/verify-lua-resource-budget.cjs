const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const compiler = process.env.LUAC53 || "luac53";
const temporaryDirectory = fs.mkdtempSync(
  path.join(os.tmpdir(), "storm-lua-budget-"),
);

function fixture(parallelValues) {
  const existing = Array.from(
    { length: 150 },
    (_, index) => `e${String(index)}`,
  );
  const generated = Array.from(
    { length: parallelValues },
    (_, index) => `v${String(index)}`,
  );
  const rhs = generated.map(() => "0");
  return `local ${existing.join(",")}\nlocal ${generated.join(",")}=${rhs.join(",")}\n`;
}

try {
  const expectations = [
    { count: 49, accepted: true },
    { count: 50, accepted: true },
    { count: 51, accepted: false },
  ];
  expectations.forEach(({ count, accepted }) => {
    const file = path.join(temporaryDirectory, `parallel-${String(count)}.lua`);
    fs.writeFileSync(file, fixture(count));
    const result = spawnSync(compiler, ["-p", file], { encoding: "utf8" });
    if (result.error) throw result.error;
    const actual = result.status === 0;
    if (actual !== accepted) {
      throw new Error(
        `${compiler} ${accepted ? "rejected" : "accepted"} 150 active + ${String(count)} parallel locals unexpectedly:\n${result.stderr}`,
      );
    }
  });
  process.stdout.write(
    `${compiler}: verified 150 active locals with 49/50 accepted and 51 rejected\n`,
  );
} finally {
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
}
