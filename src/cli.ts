#!/usr/bin/env node

import fs from "fs";
import path from "path";
import { Command } from "commander";
import { Options } from "luaparse";
import { Minifier, MinifierMode } from "./minifier";
import { buildMinifiedOutput, SourceMappingUrlStyle } from "./output";

const program = new Command();

program
  .version("0.3.0")
  .description("A Lua minifier also outputs source map")
  .option(
    "-m, --module-like-lua",
    "require・dofileの動作を実際のLuaに近づけます",
  )
  .option("--no-rename", "識別子の短縮(リネーム)を無効にします（デバッグ用途）")
  .option(
    "--no-global-rename",
    "内部でのみ使用するグローバル識別子の短縮を無効にします（デバッグ用途）",
  )
  .option(
    "--no-merge-locals",
    "連続するローカル変数宣言のまとめ上げを無効にします（デバッグ用途）",
  )
  .option(
    "--no-global-alias",
    "外部グローバル識別子（リネームできないもの）のローカル代入短縮を無効にします（デバッグ用途）",
  )
  .option(
    "--no-remove-unused",
    "未使用ローカル宣言の安全な範囲での削除を無効にします",
  )
  .option(
    "--no-remove-unused-globals",
    "未使用グローバル削除を無効にします（グローバル削除は今後実装予定）",
  )
  .option(
    "--reserved-globals-config <path>",
    '代入されていても短縮しないグローバル名を列挙したJSON設定ファイルのパス（{"neverRenameGlobals":["onTick",...]}形式）。エンジン側のコールバック規約名など、常に元の名前のまま残す必要がある識別子を指定します',
  )
  .option(
    "--single-line-source-mapping-url",
    "sourceMappingURLアノテーションを単一行の--コメントで出力します（Source Map仕様の「最終行」ルールに従いますが、既定の複数行ブロックコメント形式を前提とするツールとは組み合わせられません）",
  )
  .option(
    "--strict-source-mapping-url",
    "sourceMappingURLアノテーションをLuaコメントで一切包まず、Source Map仕様のマーカー文字列(//# sourceMappingURL=...)そのままを出力します。Luaの文法上この形式と有効なLuaコードは両立できないため、出力ファイルの最終行は有効なLua文ではなくなります",
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
