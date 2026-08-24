#!/usr/bin/env node

import fs from "fs";
import path from "path";
import { Options } from "luaparse";
import { Minifier, MinifierMode } from "./minifier";
import { buildMinifiedOutput, SourceMappingUrlStyle } from "./output";
import { createCliProgram } from "./cliOptions";

const program = createCliProgram();

program.parse(process.argv);

const luaFiles = program.args;

const luaparseSetting: Partial<Options> = {
  locations: true,
  luaVersion: "5.3",
  ranges: true,
  scope: true,
};

interface CliOptions extends MinifierMode {
  singleLineSourceMappingUrl?: boolean;
  strictSourceMappingUrl?: boolean;
  reservedGlobalsConfig?: string;
}

interface ReservedGlobalsConfig {
  neverRenameGlobals: string[];
}

function isReservedGlobalsConfig(
  value: unknown,
): value is ReservedGlobalsConfig {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as { neverRenameGlobals?: unknown };
  return (
    Array.isArray(candidate.neverRenameGlobals) &&
    candidate.neverRenameGlobals.every((name) => typeof name === "string")
  );
}

function loadNeverRenameGlobals(configPath: string): Set<string> {
  if (!fs.existsSync(configPath)) {
    throw new Error("Reserved globals config not found: " + configPath);
  }
  const parsed: unknown = JSON.parse(fs.readFileSync(configPath).toString());
  if (!isReservedGlobalsConfig(parsed)) {
    throw new Error(
      configPath +
        ' must be a JSON object of the form {"neverRenameGlobals": ["name", ...]}',
    );
  }
  return new Set(parsed.neverRenameGlobals);
}

const {
  singleLineSourceMappingUrl,
  strictSourceMappingUrl,
  reservedGlobalsConfig,
  ...mode
}: CliOptions = program.opts();

if (reservedGlobalsConfig) {
  mode.neverRenameGlobals = loadNeverRenameGlobals(reservedGlobalsConfig);
}

// 既定は旧バージョンと互換の複数行ブロックコメント("legacy")。
// --strict-source-mapping-url > --single-line-source-mapping-url の優先順で上書きする。
const sourceMappingUrlStyle: SourceMappingUrlStyle = strictSourceMappingUrl
  ? "strict"
  : singleLineSourceMappingUrl
    ? "line"
    : "legacy";

luaFiles.forEach((fileName) => {
  const parsedFileName = path.parse(fileName);

  if (fs.existsSync(fileName)) {
    const map = new Minifier(fileName, luaparseSetting, mode).parse();
    const minFileName = path.format({
      dir: parsedFileName.dir,
      name: parsedFileName.name + ".min",
      ext: ".lua",
    });
    const mapFileName = path.format({
      dir: parsedFileName.dir,
      name: parsedFileName.name,
      ext: parsedFileName.ext + ".map",
    });
    const { code, map: mapJson } = buildMinifiedOutput(
      map,
      minFileName,
      mapFileName,
      { sourceMappingUrlStyle },
    );

    fs.writeFileSync(minFileName, code);
    fs.writeFileSync(mapFileName, mapJson);
  } else {
    console.error("No such file: " + fileName);
  }
});
