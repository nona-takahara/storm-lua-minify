import { test } from "vitest";
import assert from "node:assert/strict";
import Parser from "luaparse";
import fs from "fs";
import os from "os";
import path from "path";
import { runMinifier } from "./lib/helpers";
import { Minifier } from "../src/minifier";

// 1式だけを含むソースをミニファイして出力を返す。
function minifyExpression(exprSource: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "storm-precedence-"));
  const filePath = path.join(dir, "main.lua");
  fs.writeFileSync(filePath, "return " + exprSource + "\n");
  try {
    return new Minifier(
      filePath,
      { locations: true, luaVersion: "5.3", ranges: true, scope: true },
      { moduleLikeLua: false },
    )
      .parse()
      .toStringWithSourceMap({ file: "main.min.lua" }).code;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// #27: PRECEDENCE テーブルにビット演算子(| ~ & << >>)と整数除算(//)が
// 定義されておらず、比較結果が常に偽になることで必要な括弧が失われ、
// 意味が変わってしまうバグの回帰防止テスト。
// 括弧が必要な箇所では保持され、不要な箇所では省略されることを確認する。
test("ビット演算子・整数除算の優先順序が壊れない (#27)", () => {
  const { code } = runMinifier({
    label: "bitwise-precedence",
    fixture: "bitwise-precedence",
    // このテストの主眼は演算子の優先順序であり、識別子リネームとは無関係。
    // #8bの外部グローバルエイリアス化がprintを短縮してしまうと下の正規表現が
    // 意味論的に無関係な理由で壊れるため、ここでは無効にしておく。
    mode: { moduleLikeLua: false, globalAlias: false },
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

// #52: 連結(..)は`+ - * / // %`・単項演算子・`^`より優先順位が低いため、それらの
// オペランドとして現れるときは丸括弧が要る。括弧が落ちると`0.5 % (2 .. 16)`が
// `0.5%2 ..16`になり、値が0.5から"0.516"へエラーにならないまま変わる。
test("連結を含む式が優先順位の高い演算子のオペランドになるとき括弧が保たれる (#52)", () => {
  assert.match(minifyExpression("0.5 % (2 .. 16)"), /0\.5%\(2[ \n]\.\.16\)/);
  assert.match(minifyExpression("(1 .. 2) + 3"), /\(1[ \n]\.\.2\)\+3/);
  assert.match(minifyExpression("-(1 .. 2)"), /-\(1[ \n]\.\.2\)/);
  assert.match(minifyExpression("#(1 .. 2)"), /#\(1[ \n]\.\.2\)/);

  // `..`のほうが優先順位の高い相手では、括弧が無いのが正しい。
  assert.match(minifyExpression("(1 .. 2) < 3"), /1[ \n]\.\.2<3/);
  assert.match(minifyExpression("(1 + 2) .. 3"), /1\+2[ \n]\.\.3/);
  // `..`は右結合なので、右側の括弧は落としてよい。
  assert.match(minifyExpression("1 .. (2 .. 3)"), /1[ \n]\.\.2[ \n]\.\.3/);
});

// #52と同じ原因（結合則の決定が丸括弧の判定を素通りしていた）で、右結合の`^`でも
// 括弧が落ちていた。`(1^2)^3`を`1^2^3`にすると`1^(2^3)`として読み直され値が変わる。
test("右結合のべき乗で、左側の括弧が保たれる (#52と同じ原因)", () => {
  assert.match(minifyExpression("(1 ^ 2) ^ 3"), /\(1\^2\)\^3/);
  assert.match(minifyExpression("1 ^ (2 ^ 3)"), /1\^2\^3/);
});

// #53: Lua 5.3の字句解析は16進の浮動小数点(`0xff.8`)を読むため、末尾がa〜fの
// 16進リテラルの直後に`..`を区切り無しで出すと`0xff.`まで数値として読まれ、
// malformed numberになる。出力を読み直せなくなるので、再パースで検査する。
test("末尾がa〜fの16進リテラルの直後に連結が続いても出力を読み直せる (#53)", () => {
  const hex = minifyExpression('0xff .. "x"');
  assert.doesNotThrow(() => Parser.parse(hex, { luaVersion: "5.3" }));
  // 10進では元から区切られている。
  const dec = minifyExpression('255 .. "x"');
  assert.doesNotThrow(() => Parser.parse(dec, { luaVersion: "5.3" }));
});
