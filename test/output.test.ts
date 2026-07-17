import { test } from "node:test";
import assert from "node:assert/strict";
import Parser from "luaparse";
import { SourceNode } from "source-map";
import { buildMinifiedOutput } from "../src/output";

function makeNode(): SourceNode {
  return new SourceNode(1, 0, "main.lua", "print(1)");
}

void test("buildMinifiedOutput: mapにfileフィールドが設定される", () => {
  const { map } = buildMinifiedOutput(
    makeNode(),
    "main.min.lua",
    "main.lua.map",
  );

  const parsed = JSON.parse(map) as { file?: string };
  assert.equal(parsed.file, "main.min.lua");
});

// "legacy"（既定・未指定）: 旧storm-lua-minifyと完全に同じ複数行の`--[[ ]]`
// ブロックコメントを出力する。互換性維持のため、既定はこの形式のままにする。
void test('buildMinifiedOutput: 既定("legacy")は旧バージョンと同じ複数行ブロックコメントを出力し、有効なLuaのままである', () => {
  const { code } = buildMinifiedOutput(
    makeNode(),
    "main.min.lua",
    "main.lua.map",
  );

  assert.equal(code, "print(1)\n--[[\n//# sourceMappingURL=main.lua.map\n]]");
  assert.doesNotThrow(() => Parser.parse(code, { luaVersion: "5.3" }));
});

void test('buildMinifiedOutput: sourceMappingUrlStyle: "legacy"を明示しても既定と同じ出力になる', () => {
  const { code } = buildMinifiedOutput(
    makeNode(),
    "main.min.lua",
    "main.lua.map",
    {
      sourceMappingUrlStyle: "legacy",
    },
  );

  assert.equal(code, "print(1)\n--[[\n//# sourceMappingURL=main.lua.map\n]]");
});

// "line": 単一行の`--`ラインコメント。Source Map仕様の「アノテーションは
// 最終行（末尾が空行の場合はその直前の行）に置く」というルールを満たしつつ、
// 有効なLuaのままにするための妥協案。
void test('buildMinifiedOutput: sourceMappingUrlStyle: "line"はsourceMappingURLが出力の最終行(末尾空行を除く)になり、有効なLuaのままである', () => {
  const { code } = buildMinifiedOutput(
    makeNode(),
    "main.min.lua",
    "main.lua.map",
    {
      sourceMappingUrlStyle: "line",
    },
  );

  const lines = code.split("\n");
  while (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  const lastLine = lines[lines.length - 1];

  assert.equal(lastLine, "-- //# sourceMappingURL=main.lua.map");
  assert.ok(lastLine.startsWith("--") && !lastLine.startsWith("--[["));
  assert.doesNotThrow(() => Parser.parse(code, { luaVersion: "5.3" }));
});

// "strict": Luaコメントで一切包まず、Source Map仕様のマーカー文字列
// (`//# sourceMappingURL=...`)をそのまま出力する。Lua 5.1〜5.4のいずれでも
// `/`・`//`は二項演算子のトークンであり文の先頭には来られないため、この形式は
// 有効なLuaと両立できない（調査の結果、回避不能と判断した）。この副作用を
// テストで固定化しておく。
void test('buildMinifiedOutput: sourceMappingUrlStyle: "strict"はLuaコメントで包まずアノテーションを出力し、Luaとしては構文エラーになる', () => {
  const { code } = buildMinifiedOutput(
    makeNode(),
    "main.min.lua",
    "main.lua.map",
    {
      sourceMappingUrlStyle: "strict",
    },
  );

  const lines = code.split("\n");
  while (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  const lastLine = lines[lines.length - 1];

  assert.equal(lastLine, "//# sourceMappingURL=main.lua.map");
  assert.throws(() => Parser.parse(code, { luaVersion: "5.3" }));
});
