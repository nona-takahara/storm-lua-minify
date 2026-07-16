import { test } from "node:test";
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

void test("sourcemap: mapファイルにfileフィールドが設定される", () => {
  const { map } = runMinifier({
    fixture: "multi-require",
    mode: { moduleLikeLua: true },
  });
  assert.equal(map.file, "multi-require.min.lua");
});

void test("sourcemap: sourcesContentに各モジュールの元テキストがそのまま埋め込まれる", async () => {
  const { map } = runMinifier({
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

void test("sourcemap: 別モジュール由来のトークンがそれぞれ正しい元ファイル・位置にマップされる", async () => {
  const { code, map } = runMinifier({
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

void test("sourcemap: ドット区切りモジュール名のsourcesはOSに依存せず'/'区切りになる", () => {
  const { map } = runMinifier({
    fixture: "nested-module",
    mode: { moduleLikeLua: true },
  });
  assert.ok(
    map.sources.includes("sub/deep.lua"),
    `sources に "sub/deep.lua" が含まれていること。実際: ${JSON.stringify(map.sources)}`,
  );
});
