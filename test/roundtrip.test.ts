import { test } from "node:test";
import assert from "node:assert/strict";
import Parser from "luaparse";
import { WORKING_CASES, KNOWN_BUG_CASES, runMinifier } from "./lib/helpers";

// minifyされたコードが再度luaparseでパース可能であることを検証する
// （luaparseが例外を投げないこと = 少なくとも構文として壊れていないこと）。

for (const c of WORKING_CASES) {
  void test(`round-trip parse: ${c.label}`, () => {
    const { code } = runMinifier(c);
    assert.doesNotThrow(() => Parser.parse(code, { luaVersion: "5.3" }));
  });
}

for (const c of KNOWN_BUG_CASES) {
  const issue = String(c.issue);
  void test(`round-trip parse (known bug, issue #${issue}): ${c.label}`, { todo: `#${issue} の本修正待ち` }, () => {
    const { code } = runMinifier(c);
    assert.doesNotThrow(() => Parser.parse(code, { luaVersion: "5.3" }));
  });
}
