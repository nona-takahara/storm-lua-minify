import { test } from "node:test";
import assert from "node:assert/strict";
import Parser from "luaparse";
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

// 既定・legacyBlockCommentAnnotationいずれの出力も、末尾のアノテーションを含めて
// 引き続き有効なLuaとして再パースできる。
void test("buildMinifiedOutput: 既定・legacyBlockCommentAnnotationいずれも出力全体が有効なLuaのままである", () => {
  const node = new SourceNode(1, 0, "main.lua", "print(1)");
  const { code: defaultCode } = buildMinifiedOutput(
    node,
    "main.min.lua",
    "main.lua.map",
  );
  assert.doesNotThrow(() => Parser.parse(defaultCode, { luaVersion: "5.3" }));

  const legacyNode = new SourceNode(1, 0, "main.lua", "print(1)");
  const { code: legacyCode } = buildMinifiedOutput(
    legacyNode,
    "main.min.lua",
    "main.lua.map",
    { legacyBlockCommentAnnotation: true },
  );
  assert.doesNotThrow(() => Parser.parse(legacyCode, { luaVersion: "5.3" }));
});

// legacyBlockCommentAnnotation: true では、旧storm-lua-minifyと同じ複数行の
// `--[[ ... ]]`ブロックコメントでsourceMappingURLを出力する（この形式を前提に
// 読み込む既存ツールとの互換性のため）。この形式はアノテーション行の後に`]]`が
// 続くため、ファイルの最終行そのものではない（Source Map仕様の「最終行」ルールには
// 厳密には従わない）。
void test("buildMinifiedOutput: legacyBlockCommentAnnotationは旧バージョンと同じ複数行ブロックコメントを出力する", () => {
  const node = new SourceNode(1, 0, "main.lua", "print(1)");
  const { code } = buildMinifiedOutput(node, "main.min.lua", "main.lua.map", {
    legacyBlockCommentAnnotation: true,
  });

  assert.ok(
    code.includes("\n--[[\n//# sourceMappingURL=main.lua.map\n]]"),
    `複数行ブロックコメントが含まれていること。実際: ${JSON.stringify(code)}`,
  );
});
