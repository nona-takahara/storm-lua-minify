#!/usr/bin/env node

import fs from "fs";
import path from "path";
import { Options } from "luaparse";
import { Minifier } from "./minifier";
import { buildMinifiedOutput, SourceMappingUrlStyle } from "./output";
import { createCliProgram } from "./cliOptions";
import { loadConfiguration } from "./config";
import { MinifierMode, resolveMinifierMode } from "./options";

const program = createCliProgram();

program.parse(process.argv);

const luaFiles = program.args;

const luaparseSetting: Partial<Options> = {
  locations: true,
  luaVersion: "5.3",
  ranges: true,
  scope: true,
};

type CliOptions = Omit<MinifierMode, "requiredWhitespace"> & {
  config?: string;
  neverRenameGlobal?: string[];
  requiredWhitespace?: "space" | "lf";
  sourceMappingUrlStyle?: SourceMappingUrlStyle;
};

const {
  config: configPath,
  neverRenameGlobal,
  requiredWhitespace,
  sourceMappingUrlStyle: cliSourceMappingUrlStyle,
  ...cliModeOptions
}: CliOptions = program.opts();
const cliMode: MinifierMode = cliModeOptions;
if (neverRenameGlobal !== undefined)
  cliMode.neverRenameGlobals = new Set(neverRenameGlobal);
if (requiredWhitespace !== undefined)
  cliMode.requiredWhitespace = requiredWhitespace === "space" ? " " : "\n";

const configuration = configPath
  ? loadConfiguration(configPath)
  : { mode: {} as MinifierMode };
const mode = resolveMinifierMode({
  config: configuration.mode,
  cli: cliMode,
  defaults: { requireWrapper: false, runtimeProfile: "stormworks" },
});
const sourceMappingUrlStyle: SourceMappingUrlStyle =
  cliSourceMappingUrlStyle ?? configuration.sourceMappingUrlStyle ?? "legacy";

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
