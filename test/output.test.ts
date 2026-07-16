import { test } from "node:test";
import assert from "node:assert/strict";
import { SourceNode } from "source-map";
import { buildMinifiedOutput } from "../src/output";

// sourceMappingURLアノテーションは仕様上「生成コードの最後の行（末尾が空行の場合は
// その直前の行）」に置かれていなければならない。ここでは実際に出力された文字列を
// 行分割し、末尾の空行を除いた最終行がアノテーションそのものであることを検証する
// （#21/#14: 複数行の`--[[ ]]`ブロックコメントに包んでいた旧実装ではこの位置に
// 来ておらず、最終行だけを見るツールがsourceMappingURLを検出できなかった）。
void test("buildMinifiedOutput: sourceMappingURLが出力の最終行(末尾空行を除く)になる", () => {
  const node = new SourceNode(1, 0, "main.lua", "print(1)");
  const { code } = buildMinifiedOutput(node, "main.min.lua", "main.lua.map");

  const lines = code.split("\n");
  while (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  const lastLine = lines[lines.length - 1];

  assert.equal(lastLine, "-- //# sourceMappingURL=main.lua.map");
  // Luaの単一行コメントとして valid であること（複数行の `--[[ ]]` ブロックコメントに
  // 包まれていないこと）を確認する。
  assert.ok(lastLine.startsWith("--") && !lastLine.startsWith("--[["));
});

void test("buildMinifiedOutput: mapにfileフィールドが設定される", () => {
  const node = new SourceNode(1, 0, "main.lua", "print(1)");
  const { map } = buildMinifiedOutput(node, "main.min.lua", "main.lua.map");

  const parsed = JSON.parse(map) as { file?: string };
  assert.equal(parsed.file, "main.min.lua");
});
