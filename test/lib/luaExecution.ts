import { spawnSync } from "node:child_process";

/** Run the actual Lua interpreter; a missing runtime is a test failure. */
export function executeLua(source: string, cwd?: string) {
  const result = spawnSync(process.env.LUA53 ?? "lua5.3", ["-"], {
    input: source,
    cwd,
    encoding: "utf8",
    timeout: 2_000,
    maxBuffer: 1024 * 1024,
  });
  if (result.error) throw result.error;
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}
