import path from "path";
import { SourceNode } from "source-map";

export interface MinifiedOutput {
  code: string;
  map: string;
}

export interface BuildMinifiedOutputOptions {
  /**
   * trueの場合、sourceMappingURLアノテーションを旧storm-lua-minifyと同じ複数行の
   * `--[[ ... ]]`ブロックコメントで出力する（`--[[\n//# sourceMappingURL=...\n]]`）。
   * この形はSource Map仕様が定める「アノテーションは生成コードの最後の行（末尾が
   * 空行の場合はその直前の行）に置く」というルールには厳密には従っていないが
   * （アノテーション行の後に`]]`が続き最終行にならない）、この複数行コメント形式を
   * 前提に読み込む既存ツールとの互換性のためのオプトイン。既定では使わない。
   */
  legacyBlockCommentAnnotation?: boolean;
}

/**
 * ミニファイ済みSourceNodeに、sourceMappingURLアノテーションとSource Mapを
 * 付加した最終的な出力を組み立てる。
 *
 * sourceMappingURLアノテーションは仕様上「生成コードの最後の行（末尾が空行の場合は
 * その直前の行）」に置かれていなければならない。既定では単一行の`--`ラインコメント
 * （`-- //# sourceMappingURL=...`）として追加し、末尾の空行を除けば出力の最終行に
 * なるようにする。`legacyBlockCommentAnnotation`を指定した場合は、代わりに旧
 * storm-lua-minifyと同じ複数行の`--[[ ]]`ブロックコメントを出力する
 * （BuildMinifiedOutputOptionsのコメント参照）。いずれの形式でも出力ファイルは
 * 引き続き有効なLuaとして実行できる。
 */
export function buildMinifiedOutput(
  sourceNode: SourceNode,
  minFileName: string,
  mapFileName: string,
  options: BuildMinifiedOutputOptions = {},
): MinifiedOutput {
  const url = path.basename(mapFileName);
  const annotation = options.legacyBlockCommentAnnotation
    ? "--[[\n//# sourceMappingURL=" + url + "\n]]"
    : "-- //# sourceMappingURL=" + url;
  sourceNode.add("\n" + annotation + "\n");
  const sourceAndMap = sourceNode.toStringWithSourceMap({
    file: path.basename(minFileName),
  });
  return {
    code: sourceAndMap.code,
    map: JSON.stringify(sourceAndMap.map),
  };
}
