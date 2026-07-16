import path from "path";
import { SourceNode } from "source-map";

export interface MinifiedOutput {
  code: string;
  map: string;
}

/**
 * ミニファイ済みSourceNodeに、sourceMappingURLアノテーションとSource Mapを
 * 付加した最終的な出力を組み立てる。
 *
 * sourceMappingURLアノテーションは仕様上「生成コードの最後の行（末尾が空行の場合は
 * その直前の行）」に置かれていなければならない。Luaには`//`行コメントが無いため、
 * 複数行の`--[[ ]]`ブロックコメントで包むとアノテーション行自体が最終行にならず、
 * 最終行だけを見てsourceMappingURLを解決するツールが検出に失敗する。そのため
 * 単一行の`--`ラインコメントとして追加し、末尾の空行を除けば出力の最終行になるようにする。
 */
export function buildMinifiedOutput(
  sourceNode: SourceNode,
  minFileName: string,
  mapFileName: string,
): MinifiedOutput {
  sourceNode.add(
    "\n-- //# sourceMappingURL=" + path.basename(mapFileName) + "\n",
  );
  const sourceAndMap = sourceNode.toStringWithSourceMap({
    file: path.basename(minFileName),
  });
  return {
    code: sourceAndMap.code,
    map: JSON.stringify(sourceAndMap.map),
  };
}
