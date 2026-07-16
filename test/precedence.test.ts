import { test } from "node:test";
import assert from "node:assert/strict";
import { runMinifier } from "./lib/helpers";

// #27: PRECEDENCE テーブルにビット演算子(| ~ & << >>)と整数除算(//)が
// 定義されておらず、比較結果が常に偽になることで必要な括弧が失われ、
// 意味が変わってしまうバグの回帰防止テスト。
// 括弧が必要な箇所では保持され、不要な箇所では省略されることを確認する。
void test("ビット演算子・整数除算の優先順序が壊れない (#27)", () => {
  const { code } = runMinifier({
    label: "bitwise-precedence",
    fixture: "bitwise-precedence",
    mode: { moduleLikeLua: false },
  });

  // `&` は `|` より強いので、意味を変えずに括弧を省略できる
  assert.match(code, /print\(a\|b&c\)/);
  // `(a|b)&c` は括弧を落とすと意味が変わるため保持する必要がある
  assert.match(code, /print\(\(a\|b\)&c\)/);
  assert.match(code, /print\(a&b\|c\)/);
  assert.match(code, /print\(a~b&c\)/);
  // `+` は `<<` より強いので括弧を省略できる
  assert.match(code, /print\(a<<b\+c\)/);
  // `(a<<b)+c` は括弧を落とすと意味が変わるため保持する必要がある
  assert.match(code, /print\(\(a<<b\)\+c\)/);
  assert.match(code, /print\(a\/\/b\/\/c\)/);
  assert.match(code, /print\(~a&b\)/);
});
