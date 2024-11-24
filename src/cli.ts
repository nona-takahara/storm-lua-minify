#!/usr/bin/env node

import fs from "fs";
import path from "path";
import { Command } from "commander";
import { Options } from "luaparse";
import { Minifier, MinifierMode } from "./minifier";

const program = new Command();

program
  .version("0.1.0")
  .description("A Lua minifier also outputs source map")
  .option(
    "-m, --module-like-lua",
    "require・dofileの動作を実際のLuaに近づけます"
  );

program.parse(process.argv);

const luaFiles = program.args;

const luaparseSetting: Partial<Options> = {
  locations: true,
  luaVersion: "5.3",
  ranges: true,
  scope: true,
};

const mode: MinifierMode = program.opts();

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
    map.add("\n--[[\n//# sourceMappingURL=" + mapFileName + "\n]]");

    const sourceAndMap = map.toStringWithSourceMap();

    fs.writeFileSync(minFileName, sourceAndMap.code);
    fs.writeFileSync(mapFileName, JSON.stringify(sourceAndMap.map));
  } else {
    console.error("No such file: " + fileName);
  }
});
