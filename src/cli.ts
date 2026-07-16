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
    "--legacy-source-mapping-url",
    "sourceMappingURLアノテーションを旧バージョンと同じ複数行の--[[ ]]ブロックコメントで出力します（この形式を前提に読み込む既存ツールとの互換性のため。既定は単一行の--コメントです）",
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
  legacySourceMappingUrl?: boolean;
}

const { legacySourceMappingUrl, ...mode }: CliOptions = program.opts();

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
      { legacyBlockCommentAnnotation: legacySourceMappingUrl },
    );

    fs.writeFileSync(minFileName, code);
    fs.writeFileSync(mapFileName, mapJson);
  } else {
    console.error("No such file: " + fileName);
  }
});
