#!/usr/bin/env node

import fs from "fs";
import path from "path";
import { Command } from "commander";
import { Options } from "luaparse";
import { Minifier, MinifierMode } from "./minifier";
import { buildMinifiedOutput } from "./output";

const program = new Command();

program
  .version("0.1.3")
  .description("A Lua minifier also outputs source map")
  .option(
    "-m, --module-like-lua",
    "require・dofileの動作を実際のLuaに近づけます",
  )
  .option("--no-rename", "識別子の短縮(リネーム)を無効にします（デバッグ用途）")
  .option(
    "--strict-source-mapping-url",
    "sourceMappingURLアノテーションをLuaコメントで包まず、Source Map仕様の慣習表記(//# sourceMappingURL=...)そのままの1行で出力します（出力ファイルの最終行は有効なLuaではなくなります）",
  );

program.parse(process.argv);

const luaFiles = program.args;

const luaparseSetting: Partial<Options> = {
  locations: true,
  luaVersion: "5.3",
  ranges: true,
  scope: true,
};

interface CliOptions extends MinifierMode {
  strictSourceMappingUrl?: boolean;
}

const { strictSourceMappingUrl, ...mode }: CliOptions = program.opts();

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
      { strictSourceMappingUrl },
    );

    fs.writeFileSync(minFileName, code);
    fs.writeFileSync(mapFileName, mapJson);
  } else {
    console.error("No such file: " + fileName);
  }
});
