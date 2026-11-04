import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import Parser from "luaparse";
import { describe, expect, test } from "vitest";
import { createTemporaryLuaProject } from "../lib/minifierHarness";
import { executeLua } from "../lib/luaExecution";
import { functionRewriteCases } from "../lib/functionRewriteCases";

const probes = [
  {
    name: "arithmetic and printing",
    source: "local answer = 40 + 2\nprint(answer)\n",
    // The chunk prints before pcall reports its successful empty return tuple.
    stdout: "42\ntrue\n",
  },
  ...["specialization-tail-call-effects", "unused-actual-evaluation-order"].map(
    (name) => {
      const fixture = functionRewriteCases.find((entry) => entry.name === name);
      if (!fixture) throw new Error(`Missing smoke fixture: ${name}`);
      return fixture;
    },
  ),
];

describe("installed command smoke test", () => {
  test.each(probes)(
    "preserves $name and emits a usable source map",
    (probe) => {
      const { directory, entryFilePath: input } = createTemporaryLuaProject({
        "main.lua": probe.source,
      });

      execFileSync(process.execPath, [path.resolve("dist/cli.js"), input], {
        cwd: directory,
        encoding: "utf8",
        stdio: "pipe",
        timeout: 4_000,
      });

      const output = path.join(directory, "main.min.lua");
      const sourceMap = path.join(directory, "main.lua.map");
      expect(fs.existsSync(output)).toBe(true);
      expect(fs.existsSync(sourceMap)).toBe(true);
      const code = fs.readFileSync(output, "utf8");
      expect(() => Parser.parse(code, { luaVersion: "5.3" })).not.toThrow();
      expect(JSON.parse(fs.readFileSync(sourceMap, "utf8"))).toMatchObject({
        file: "main.min.lua",
        sources: ["main.lua"],
      });
      const expected = {
        status: 0,
        stdout: probe.stdout,
        stderr: "",
      };
      const observe = (source: string) =>
        executeLua(`print(pcall(function()\n${source}\nend))`, directory);
      expect(observe(probe.source), "original program").toEqual(expected);
      expect(observe(code), "CLI output").toEqual(expected);
    },
  );
});
