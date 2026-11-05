import fs from "node:fs";
import { expect } from "vitest";
import type { MinifiedLuaProject } from "./minifierHarness";
import { executeLua } from "./luaExecution";

/** Check each program against the same explicit observation, not just each other. */
export function expectLuaProgramsOutput(
  programs: readonly string[],
  stdout: string,
  prelude: string,
): void {
  for (const [index, source] of programs.entries()) {
    expect(
      executeLua(`${prelude}\nprint(pcall(function()\n${source}\nend))`),
      `program ${String(index)}`,
    ).toEqual({ status: 0, stdout, stderr: "" });
  }
}

/** Observe return values after compilation; keep each expected trace at the call site. */
export function expectLuaProjectOutput(
  project: Pick<MinifiedLuaProject, "directory" | "entryFilePath" | "code">,
  stdout: string,
  options: { prelude?: string; originalStdout?: string } = {},
): void {
  const observe = (source: string) =>
    executeLua(
      `${options.prelude ?? ""}\nprint(pcall(function(...)\n${source}\nend))`,
      project.directory,
    );
  const original = fs.readFileSync(project.entryFilePath, "utf8");
  expect(observe(original), "original program").toEqual({
    status: 0,
    stdout: options.originalStdout ?? stdout,
    stderr: "",
  });
  expect(observe(project.code), "minified program").toEqual({
    status: 0,
    stdout,
    stderr: "",
  });
}
