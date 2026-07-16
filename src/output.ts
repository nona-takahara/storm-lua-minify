import path from "path";
import { SourceNode } from "source-map";

export interface MinifiedOutput {
  code: string;
  map: string;
}

export interface BuildMinifiedOutputOptions {
  /**
   * trueの場合、sourceMappingURLアノテーションをLuaの`--`コメントで包まず、
   * Source Map仕様の慣習表記（`//# sourceMappingURL=...`）をそのまま1行として
   * 出力する。Luaには`//`行コメントが無く（Lua 5.3以降では`//`は整数除算演算子の
   * トークンでもある）、この形は出力ファイルの最終行を有効なLua文ではなくする
   * （luaparseで再パースするとエラーになる）。厳密な仕様準拠のマーカー文字列を
   * 必要とする外部ツール向けのオプトインで、既定では使わない。
   */
  strictSourceMappingUrl?: boolean;
}

/**
 * ミニファイ済みSourceNodeに、sourceMappingURLアノテーションとSource Mapを
 * 付加した最終的な出力を組み立てる。
 *
 * sourceMappingURLアノテーションは仕様上「生成コードの最後の行（末尾が空行の場合は
 * その直前の行）」に置かれていなければならない。既定では単一行の`--`ラインコメント
 * （`-- //# sourceMappingURL=...`）として追加し、末尾の空行を除けば出力の最終行に
 * なるようにする（これによりLuaとして引き続き実行可能な状態を保つ）。
 * `strictSourceMappingUrl`を指定した場合は`--`で包まず慣習表記そのままを出力する
 * （BuildMinifiedOutputOptionsのコメント参照）。
 */
export function buildMinifiedOutput(
  sourceNode: SourceNode,
  minFileName: string,
  mapFileName: string,
  options: BuildMinifiedOutputOptions = {},
): MinifiedOutput {
  const marker = "//# sourceMappingURL=" + path.basename(mapFileName);
  const annotation = options.strictSourceMappingUrl ? marker : "-- " + marker;
  sourceNode.add("\n" + annotation + "\n");
  const sourceAndMap = sourceNode.toStringWithSourceMap({
    file: path.basename(minFileName),
  });
  return {
    code: sourceAndMap.code,
    map: JSON.stringify(sourceAndMap.map),
  };
}
