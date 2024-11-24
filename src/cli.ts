#!/usr/bin/env node

import fs from "fs";
import path from "path";
import { Command } from "commander";
import Parser, { Options } from "luaparse";
import { Chunk, Minifier } from "./ast2lua";

const program = new Command();

program.version("0.1.0").description("A Lua minifier also outputs source map");

program.parse(process.argv);

const luaFiles = program.args;

const luaparseSetting: Partial<Options> = {
  locations: true,
  luaVersion: "5.3",
  ranges: true,
  scope: true,
};

luaFiles.forEach((fileName) => {
  const includes = new Map<string, string>();
  const parsedFileName = path.parse(fileName);

  function requireHelper(recursiveFilePath: string) {
    const resolvePath = path.relative(
      parsedFileName.dir,
      path.join(
        parsedFileName.dir,
        recursiveFilePath.replaceAll(".", path.sep) + ".lua"
      )
    );
    const fullResolvePath = path.join(parsedFileName.dir, resolvePath);

    if (!includes.has(resolvePath) && fs.existsSync(fullResolvePath)) {
      const code = fs.readFileSync(fullResolvePath).toString();
      const ast = Parser.parse(code, luaparseSetting) as Chunk;
      if ("globals" in ast) {
        includes.set(resolvePath, code);
        return new Minifier(resolvePath, ast, requireHelper).parse();
      }
      includes.set(resolvePath, "");
      return undefined;
    }
  }

  if (fs.existsSync(fileName)) {
    const code = fs.readFileSync(fileName).toString();
    const ast = Parser.parse(code, luaparseSetting) as Chunk;
    if ("globals" in ast) {
      includes.set(parsedFileName.base, code);
      const map = new Minifier(parsedFileName.base, ast, requireHelper).parse();

      includes.forEach((v, k) => {
        console.log(k);
        map.setSourceContent(k, v);
      });

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
    }
  } else {
    console.error("No such file: " + fileName);
  }
});
