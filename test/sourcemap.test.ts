import { test } from "vitest";
import assert from "node:assert/strict";
import fs from "fs";
import { SourceMapConsumer } from "source-map";
import { fixtureEntryPath, runMinifier } from "./lib/helpers";

// 生成コード中の`needle`が何回目に出現する行・列(source-map準拠: 行は1始まり、
// 列は0始まり)かを求める。複数モジュールが1つの出力にまとめられるケースで、
// 由来モジュールごとに異なる出現箇所を指定できるようにするため。
function locateInGenerated(
  code: string,
  needle: string,
  occurrence = 0,
): { line: number; column: number } {
  const lines = code.split("\n");
  let seen = 0;
  for (let i = 0; i < lines.length; i++) {
    let from = 0;
    for (;;) {
      const column = lines[i].indexOf(needle, from);
      if (column === -1) {
        break;
      }
      if (seen === occurrence) {
        return { line: i + 1, column };
      }
      seen++;
      from = column + 1;
    }
  }
  throw new Error(
    `"${needle}" (occurrence ${String(occurrence)}) not found in generated code:\n${code}`,
  );
}

test("sourcemap: mapファイルにfileフィールドが設定される", () => {
  const { map } = runMinifier({
    label: "sourcemap: mapファイルにfileフィールドが設定される",
    fixture: "multi-require",
    mode: { moduleLikeLua: true },
  });
  assert.equal(map.file, "multi-require.min.lua");
});

test("sourcemap: sourcesContentに各モジュールの元テキストがそのまま埋め込まれる", async () => {
  const { map } = runMinifier({
    label:
      "sourcemap: sourcesContentに各モジュールの元テキストがそのまま埋め込まれる",
    fixture: "multi-require",
    mode: { moduleLikeLua: true },
  });

  await SourceMapConsumer.with(map, null, (consumer) => {
    assert.ok(consumer.hasContentsOfAllSources());
    const mainContent = consumer.sourceContentFor("main.lua");
    const commonContent = consumer.sourceContentFor("common.lua");
    assert.equal(
      mainContent,
      fs.readFileSync(fixtureEntryPath("multi-require", "main.lua"), "utf8"),
    );
    assert.equal(
      commonContent,
      fs.readFileSync(fixtureEntryPath("multi-require", "common.lua"), "utf8"),
    );
  });
});

test("sourcemap: 別モジュール由来のトークンがそれぞれ正しい元ファイル・位置にマップされる", async () => {
  const { code, map } = runMinifier({
    label:
      "sourcemap: 別モジュール由来のトークンがそれぞれ正しい元ファイル・位置にマップされる",
    fixture: "multi-require",
    mode: { moduleLikeLua: false },
  });
  // SLモードでは同一モジュールへの多重requireがそれぞれ独立して展開されるため、
  // "local a={value=42}local b={value=42}print(a.value,b.value)" のような形になる
  // （test/snapshots/multi-require.sl.lua 参照）。

  await SourceMapConsumer.with(map, null, (consumer) => {
    // common.lua由来: 1回目のインライン展開の `42`
    const firstValue = locateInGenerated(code, "42", 0);
    const firstValuePos = consumer.originalPositionFor(firstValue);
    assert.equal(firstValuePos.source, "common.lua");
    assert.equal(firstValuePos.line, 1);

    // common.lua由来: 2回目のインライン展開の `42`（1回目とは別のSourceNodeインスタンス）
    const secondValue = locateInGenerated(code, "42", 1);
    const secondValuePos = consumer.originalPositionFor(secondValue);
    assert.equal(secondValuePos.source, "common.lua");
    assert.equal(secondValuePos.line, 1);

    // main.lua由来: print呼び出し
    const printCall = locateInGenerated(code, "print");
    const printPos = consumer.originalPositionFor(printCall);
    assert.equal(printPos.source, "main.lua");
    assert.equal(printPos.line, 3);
    assert.equal(printPos.name, "print");
  });
});

test("sourcemap: #8bでエイリアス化された参照は、位置は元のままnamesフィールドに元の名前が残る", async () => {
  const { code, map } = runMinifier({
    label:
      "sourcemap: #8bでエイリアス化された参照は、位置は元のままnamesフィールドに元の名前が残る",
    fixture: "global-alias",
    mode: { moduleLikeLua: false },
  });

  // エイリアス化の実装用の仮名(__mergeAliasN)が最終出力のnamesに漏れていないこと
  assert.ok(
    !map.names.some((n) => n.startsWith("__mergeAlias")),
    `names に内部実装用の仮名が含まれていないこと。実際: ${JSON.stringify(map.names)}`,
  );

  await SourceMapConsumer.with(map, null, (consumer) => {
    // 2回目のscreen.setColor呼び出し（出力上は短縮名、例: `a.setColor(0,255,0)`）でも
    // 元のソース上の位置・名前("screen")を正しく指し続けること
    const secondCall = locateInGenerated(code, "setColor", 1);
    const pos = consumer.originalPositionFor(secondCall);
    assert.equal(pos.source, "main.lua");
    assert.equal(pos.name, "setColor");
  });
});

test("sourcemap: ドット区切りモジュール名のsourcesはOSに依存せず'/'区切りになる", () => {
  const { map } = runMinifier({
    label:
      "sourcemap: ドット区切りモジュール名のsourcesはOSに依存せず'/'区切りになる",
    fixture: "nested-module",
    mode: { moduleLikeLua: true },
  });
  assert.ok(
    map.sources.includes("sub/deep.lua"),
    `sources に "sub/deep.lua" が含まれていること。実際: ${JSON.stringify(map.sources)}`,
  );
});

// `locateInGenerated`の元ソース版。ミニファイでは空白・改行が除去され各文が
// 詰めて出力されるため、あるキーワード文字列のN回目の出現は、元ソース側でも
// 同じN回目の出現に対応する（#14: 各キーワードトークンが自身の出現位置を
// 個別に持つようになったことの検証に使う）。
function locateInOriginal(
  source: string,
  needle: string,
  occurrence: number,
): { line: number; column: number } {
  return locateInGenerated(source, needle, occurrence);
}

test("sourcemap: if/then/elseif/else/end等のキーワードトークンが、それぞれ独立して元ソース上の自身の出現位置にマップされる (#14)", () => {
  const { code, map } = runMinifier({
    label:
      "sourcemap: if/then/elseif/else/end等のキーワードトークンが、それぞれ独立して元ソース上の自身の出現位置にマップされる (#14)",
    fixture: "control-flow-keywords",
    // このテストは未使用関数内の`end`も含めた位置対応を検証するため、
    // unused除去を無効にして入力中の全キーワードを出力へ残す。
    mode: { moduleLikeLua: false, removeUnused: false },
  });
  const source = fs.readFileSync(
    fixtureEntryPath("control-flow-keywords"),
    "utf8",
  );

  // [キーワード文字列, 生成コード側での出現回数(0始まり)]。
  // 以前は`then`/`do`/`until`/ブロックを閉じる`end`が、対応する文の先頭
  // （if/while/do/repeat/for/function自身の位置）に丸ごと吸収されてマップ
  // されていた。修正後は、それぞれが自分自身の実際の出現位置にマップされる
  // ことを、生成コード中の出現ごとに元ソースの対応する出現と突き合わせて確認する。
  const occurrences: [string, number][] = [
    ["if", 0],
    ["then", 0], // IfClauseのthen
    ["elseif", 0],
    ["then", 1], // ElseifClauseのthen
    ["else", 0],
    ["end", 0], // IfStatementを閉じるend
    ["while", 0],
    ["do", 0], // WhileStatementのdo
    ["end", 1], // WhileStatementを閉じるend
    ["do", 1], // 単独のDoStatement
    ["end", 2], // DoStatementを閉じるend
    ["repeat", 0],
    ["until", 0],
    ["for", 0],
    ["do", 2], // ForGenericStatementのdo
    ["end", 3], // ForGenericStatementを閉じるend
    ["for", 1],
    ["do", 3], // ForNumericStatementのdo
    ["end", 4], // ForNumericStatementを閉じるend
    // 注: `local function add(...)`の"function"自体(0回目)はここに含めない。
    // `(isLocal ? "local " : "") + "function "`が1つの先頭チャンクとして
    // statement自身の位置(=`local`の位置)にまとめて割り当てられるのは
    // 今回のバグ修正の対象外（他の"先頭キーワード"と同じ既存の挙動）であり、
    // 別途で扱う。
    ["end", 5], // local function文を閉じるend
    ["function", 1], // 無名関数式（`local `を伴わないため自身の位置で正しい）
    ["end", 6], // 上記を閉じるend
  ];

  return SourceMapConsumer.with(map, null, (consumer) => {
    occurrences.forEach(([keyword, occurrence]) => {
      const generatedPos = locateInGenerated(code, keyword, occurrence);
      const resolved = consumer.originalPositionFor(generatedPos);
      const expected = locateInOriginal(source, keyword, occurrence);
      assert.equal(
        resolved.line,
        expected.line,
        `"${keyword}" (${String(occurrence)}回目) の行`,
      );
      assert.equal(
        resolved.column,
        expected.column,
        `"${keyword}" (${String(occurrence)}回目) の列`,
      );
    });
  });
});
