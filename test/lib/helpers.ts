import path from "path";
import { Options } from "luaparse";
import { RawSourceMap } from "source-map";
import { Minifier, MinifierMode } from "../../src/minifier";

export const FIXTURES_DIR = path.join(__dirname, "..", "fixtures");
export const SNAPSHOTS_DIR = path.join(__dirname, "..", "snapshots");

export const LUAPARSE_SETTINGS: Partial<Options> = {
  locations: true,
  luaVersion: "5.3",
  ranges: true,
  scope: true,
};

export interface FixtureCase {
  label: string;
  fixture: string;
  entry?: string;
  mode: MinifierMode;
}

export interface KnownBugCase extends FixtureCase {
  issue: number;
}

export function fixtureEntryPath(fixture: string, entry = "main.lua"): string {
  return path.join(FIXTURES_DIR, fixture, entry);
}

export function slug(c: Pick<FixtureCase, "fixture" | "mode">): string {
  return `${c.fixture}.${c.mode.moduleLikeLua ? "m" : "sl"}`;
}

export function runMinifier(c: FixtureCase): {
  code: string;
  map: RawSourceMap;
} {
  const minifier = new Minifier(
    fixtureEntryPath(c.fixture, c.entry),
    LUAPARSE_SETTINGS,
    c.mode,
  );
  const sourceNode = minifier.parse();
  const { code, map } = sourceNode.toStringWithSourceMap({
    file: c.fixture + ".min.lua",
  });
  return { code, map: map.toJSON() };
}

// require() / require "m" / dofile が正しく解決される、動作が確認できているケース。
// スナップショット・ラウンドトリップ・識別子衝突検知の全テストで「衝突・構文エラーが無い」ことを期待する。
export const WORKING_CASES: FixtureCase[] = [
  {
    label: "単一ファイル",
    fixture: "single-file",
    mode: { moduleLikeLua: false },
  },
  {
    label: 'require("m") 構文 (-m モード)',
    fixture: "require-call",
    mode: { moduleLikeLua: true },
  },
  {
    label: "dofile (SLモード)",
    fixture: "dofile",
    mode: { moduleLikeLua: false },
  },
  {
    label: "同一モジュールの多重require (-m モード)",
    fixture: "multi-require",
    mode: { moduleLikeLua: true },
  },
  {
    label: "エントリ直下で多数のrequire (-m モード, #12回帰防止)",
    fixture: "entry-scope-many-requires",
    mode: { moduleLikeLua: true },
  },
  {
    label: "ビット演算子・整数除算の優先順序 (#27回帰防止)",
    fixture: "bitwise-precedence",
    mode: { moduleLikeLua: false },
  },
  {
    label:
      'require "m" (括弧なし文字列呼び出し構文) が解決される (-m モード, #18/#11修正確認)',
    fixture: "require-string-call",
    mode: { moduleLikeLua: true },
  },
  {
    label:
      "SLモードでrequireしたモジュールがIIFEとしてその場展開される (#18/#11修正確認)",
    fixture: "require-call",
    mode: { moduleLikeLua: false },
  },
  {
    label:
      "SLモードで同一モジュールを多重requireすると呼び出しごとに独立してその場展開される (#18/#11修正確認)",
    fixture: "multi-require",
    mode: { moduleLikeLua: false },
  },
];

// 既知バグの再現ケース。現状は failing のため `test.todo` で登録する。
// 修正が入ったら .todo を外して WORKING_CASES に合流させること。
export const KNOWN_BUG_CASES: KnownBugCase[] = [];
