import fs from "fs";
import os from "os";
import path from "path";
import { Options } from "luaparse";
import { RawSourceMap } from "source-map";
import { onTestFinished } from "vitest";
import { Minifier, MinifierMode } from "../../src/minifier";
import { LUAPARSE_SETTINGS } from "./helpers";

export interface TemporaryLuaProject {
  directory: string;
  entryFilePath: string;
}

export interface MinifiedLuaProject extends TemporaryLuaProject {
  code: string;
  map: RawSourceMap;
  minifier: Minifier;
}

interface ProjectOptions {
  entry?: string;
  prefix?: string;
}

interface MinifyOptions extends ProjectOptions {
  luaParseSettings?: Partial<Options>;
  outputFile?: string;
}

/**
 * Creates a disposable, multi-file Lua project owned by the current test.
 * Keeping cleanup here prevents integration tests from accumulating subtly
 * different temp-directory lifecycles.
 */
export function createTemporaryLuaProject(
  files: Readonly<Record<string, string>>,
  options: ProjectOptions = {},
): TemporaryLuaProject {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), options.prefix ?? "storm-minifier-test-"),
  );
  onTestFinished(() => {
    fs.rmSync(directory, { recursive: true, force: true });
  });

  Object.entries(files).forEach(([relativePath, source]) => {
    const filePath = path.join(directory, relativePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, source);
  });

  return {
    directory,
    entryFilePath: path.join(directory, options.entry ?? "main.lua"),
  };
}

export function minifyTemporaryLuaProject(
  files: Readonly<Record<string, string>>,
  mode: MinifierMode,
  options: MinifyOptions = {},
): MinifiedLuaProject {
  const project = createTemporaryLuaProject(files, options);
  return minifyLuaProject(project, mode, options);
}

export function minifyLuaProject(
  project: TemporaryLuaProject,
  mode: MinifierMode,
  options: Omit<MinifyOptions, keyof ProjectOptions> = {},
): MinifiedLuaProject {
  const minifier = new Minifier(
    project.entryFilePath,
    options.luaParseSettings ?? LUAPARSE_SETTINGS,
    mode,
  );
  const { code, map } = minifier.parse().toStringWithSourceMap({
    file: options.outputFile ?? "main.min.lua",
  });
  return {
    ...project,
    code,
    map: map.toJSON(),
    minifier,
  };
}

export function minifyTemporaryLuaSource(
  source: string,
  mode: MinifierMode,
  options: MinifyOptions = {},
): MinifiedLuaProject {
  return minifyTemporaryLuaProject(
    { [options.entry ?? "main.lua"]: source },
    mode,
    options,
  );
}
