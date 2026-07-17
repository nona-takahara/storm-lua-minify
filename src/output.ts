import path from "path";
import { SourceNode } from "source-map";

export interface MinifiedOutput {
  code: string;
  map: string;
}

export type SourceMappingUrlStyle = "legacy" | "line" | "strict";

export interface BuildMinifiedOutputOptions {
  /**
   * sourceMappingURLアノテーションの出力形式。省略時は"legacy"。
   *
   * - "legacy"（既定）: 旧storm-lua-minifyと同じ複数行の`--[[ ... ]]`ブロック
   *   コメント（`--[[\n//# sourceMappingURL=...\n]]`）をそのまま出力する。
   *   互換性優先で、この形式を前提に読み込む既存ツールと組み合わせて使う。
   *   Source Map仕様が定める「アノテーションは生成コードの最後の行（末尾が
   *   空行の場合はその直前の行）に置く」というルールには厳密には従わない
   *   （アノテーション行の後に`]]`が続き最終行にならないため）。
   * - "line": 単一行の`--`ラインコメント（`-- //# sourceMappingURL=...`）。
   *   末尾の空行を除けば出力の最終行になるため「最終行ルール」は満たすが、
   *   マーカー文字列自体は`-- `に続く形になる（行頭が厳密に`//`であることを
   *   要求する一部のツールからは認識されない可能性がある）。有効なLuaの
   *   ままである。
   * - "strict": Luaコメントで一切包まず`//# sourceMappingURL=...`をそのまま
   *   出力する。マーカー文字列・最終行ルールの両方を厳密に満たす。
   *
   *   【Lua文法との両立について】Lua 5.1〜5.4のどのバージョンでも`/`（除算）や
   *   `//`（5.3以降の整数除算）は二項演算子のトークンであり、文の先頭に
   *   来ることはできない（Luaの文は識別子・キーワード・`::`・`;`のいずれかで
   *   始まらなければならない）。そのため`//`から始まる行を、一切のコメント化
   *   なしにLuaの文として構文解析可能にする方法は存在しない。したがって
   *   "strict"を選択した場合、出力ファイルの最終行は有効なLua文ではなくなる
   *   （luaparseで再パースするとエラーになる）。この制約はLuaの言語仕様上
   *   回避不能であることを確認済み。
   */
  sourceMappingUrlStyle?: SourceMappingUrlStyle;
}

/**
 * ミニファイ済みSourceNodeに、sourceMappingURLアノテーションとSource Mapを
 * 付加した最終的な出力を組み立てる。アノテーションの出力形式は
 * `BuildMinifiedOutputOptions.sourceMappingUrlStyle`で選択する。
 */
export function buildMinifiedOutput(
  sourceNode: SourceNode,
  minFileName: string,
  mapFileName: string,
  options: BuildMinifiedOutputOptions = {},
): MinifiedOutput {
  const style = options.sourceMappingUrlStyle ?? "legacy";
  const marker = "//# sourceMappingURL=" + path.basename(mapFileName);

  if (style === "legacy") {
    // 旧storm-lua-minifyと完全に同じ出力（末尾に改行は付加しない）。
    sourceNode.add("\n--[[\n" + marker + "\n]]");
  } else if (style === "line") {
    sourceNode.add("\n-- " + marker + "\n");
  } else {
    sourceNode.add("\n" + marker + "\n");
  }

  const sourceAndMap = sourceNode.toStringWithSourceMap({
    file: path.basename(minFileName),
  });
  return {
    code: sourceAndMap.code,
    map: JSON.stringify(sourceAndMap.map),
  };
}
