import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, test } from "vitest";
import { createTemporaryLuaProject } from "./lib/minifierHarness";
import { expectLuaProjectOutput } from "./lib/luaProjectAssertions";

const repository = path.resolve(__dirname, "..");
const cli = path.join(repository, "dist", "cli.js");

beforeAll(() => {
  // Exercise the real entry point, including a clean checkout without dist.
  execFileSync("pnpm", ["run", "build"], {
    cwd: repository,
    stdio: "pipe",
    timeout: 60_000,
  });
}, 60_000);

function runCli(directory: string, args: string[]) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd: directory,
    encoding: "utf8",
    timeout: 4_000,
  });
  if (result.error) throw result.error;
  return result;
}

describe("CLI configuration and output contract", () => {
  test.each([
    {
      name: "config-only settings with implicit non-TTY progress",
      configRename: false,
      args: [],
      renamed: false,
      progress: false,
      whitespace: "lf",
      mapStyle: "line",
    },
    {
      name: "CLI parent enables a disabled config leaf and forces progress",
      configRename: false,
      args: [
        "--identifier-optimizations",
        "--required-whitespace",
        "space",
        "--progress",
      ],
      renamed: true,
      progress: true,
      whitespace: "space",
      mapStyle: "line",
    },
    {
      name: "CLI parent disables an enabled config leaf and suppresses progress",
      configRename: true,
      args: [
        "--no-identifier-optimizations",
        "--required-whitespace",
        "space",
        "--source-mapping-url-style",
        "legacy",
        "--no-progress",
      ],
      renamed: false,
      progress: false,
      whitespace: "space",
      mapStyle: "legacy",
    },
  ])(
    "$name",
    ({ configRename, args, renamed, progress, whitespace, mapStyle }) => {
      const project = createTemporaryLuaProject({
        "main.lua": "local descriptive=40 return descriptive+2",
        "second.lua": "local descriptive=40 return descriptive+3",
        "settings file.json": JSON.stringify({
          optimizations: false,
          "local-renaming": configRename,
          "runtime-profile": "lua53",
          "required-whitespace": "lf",
          "source-mapping-url-style": "line",
        }),
      });
      const result = runCli(project.directory, [
        "--config",
        "settings file.json",
        ...args,
        "main.lua",
        "second.lua",
      ]);
      expect(result.status).toBe(0);
      expect(result.stdout).toBe("");
      if (progress) {
        expect(result.stderr.trim()).not.toBe("");
        expect(result.stderr).not.toContain("\r");
        expect(result.stderr).not.toContain("\x1b");
      } else expect(result.stderr).toBe("");

      for (const [name, value] of [
        ["main", 42],
        ["second", 43],
      ] as const) {
        const code = fs.readFileSync(
          path.join(project.directory, `${name}.min.lua`),
          "utf8",
        );
        expect(code.includes("descriptive")).toBe(!renamed);
        expect(code.startsWith("local\n")).toBe(whitespace === "lf");
        const marker = `//# sourceMappingURL=${name}.lua.map`;
        expect(
          code.endsWith(
            mapStyle === "line" ? `-- ${marker}\n` : `${marker}\n]]`,
          ),
        ).toBe(true);
        expect(
          JSON.parse(
            fs.readFileSync(
              path.join(project.directory, `${name}.lua.map`),
              "utf8",
            ),
          ),
        ).toMatchObject({
          file: `${name}.min.lua`,
          sources: [`${name}.lua`],
        });
        expectLuaProjectOutput(
          {
            ...project,
            entryFilePath: path.join(project.directory, `${name}.lua`),
            code,
          },
          `true\t${String(value)}\n`,
        );
      }
    },
  );

  test.each([
    ["unknown option", '{"localRenaming":true}'],
    ["invalid boolean", '{"function-inlining":"yes"}'],
    ["invalid JSON", "{"],
  ])("rejects %s before writing artifacts", (_name, configuration) => {
    const project = createTemporaryLuaProject({
      "main.lua": "return 42",
      "settings.json": configuration,
    });
    const result = runCli(project.directory, [
      "--config",
      "settings.json",
      "main.lua",
    ]);
    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr.trim()).not.toBe("");
    expect(fs.existsSync(path.join(project.directory, "main.min.lua"))).toBe(
      false,
    );
    expect(fs.existsSync(path.join(project.directory, "main.lua.map"))).toBe(
      false,
    );
  });

  test("reports compilation failure on stderr without artifacts", () => {
    const project = createTemporaryLuaProject({ "main.lua": "local =" });
    const result = runCli(project.directory, ["--progress", "main.lua"]);
    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr.trim()).not.toBe("");
    expect(fs.existsSync(path.join(project.directory, "main.min.lua"))).toBe(
      false,
    );
    expect(fs.existsSync(path.join(project.directory, "main.lua.map"))).toBe(
      false,
    );
  });
});
