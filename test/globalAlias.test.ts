import { test } from "vitest";
import assert from "node:assert/strict";
import Parser from "luaparse";
import { resolveScopes } from "../src/resolver";
import { insertGlobalAliases } from "../src/transform";
import { runMinifier } from "./lib/helpers";

// #8b: 外部グローバル識別子のローカル代入短縮の単体テスト。
// しきい値判定、対象範囲の除外（require/dofile、8aで直接リネームされるもの）、
// フィールド名との非衝突を検証する。

function parse(code: string): Parser.Chunk {
  return Parser.parse(code, { luaVersion: "5.3" });
}

function alias(
  code: string,
  excludeNames: ReadonlySet<string> = new Set(),
): Parser.Chunk {
  const chunk = parse(code);
  const resolved = resolveScopes(chunk);
  insertGlobalAliases(chunk, resolved, { excludeNames });
  return chunk;
}

test("a global referenced many times above the threshold gets aliased at the top of the chunk", () => {
  const chunk = alias(`
    screen.setColor(1)
    screen.setColor(2)
    screen.setColor(3)
    screen.setColor(4)
    screen.setColor(5)
  `);

  assert.equal(chunk.body.length, 6);
  const aliasDecl = chunk.body[0] as Parser.LocalStatement;
  const aliasInit = aliasDecl.init[0];
  assert.equal(aliasInit.type === "Identifier" && aliasInit.name, "screen");

  const aliasName = aliasDecl.variables[0].name;
  for (let i = 1; i < chunk.body.length; i++) {
    const call = (chunk.body[i] as Parser.CallStatement)
      .expression as Parser.CallExpression;
    const base = call.base as Parser.MemberExpression;
    assert.equal((base.base as Parser.Identifier).name, aliasName);
  }
});

test("a global below the reference threshold is left untouched", () => {
  const chunk = alias(`
    screen.setColor(1)
  `);

  assert.equal(chunk.body.length, 1);
  assert.equal(chunk.body[0].type, "CallStatement");
});

test("excludeNames prevents double-processing a global already handled by #8a", () => {
  const chunk = alias(
    `
      screen.setColor(1)
      screen.setColor(2)
      screen.setColor(3)
      screen.setColor(4)
      screen.setColor(5)
    `,
    new Set(["screen"]),
  );

  assert.equal(chunk.body.length, 5);
  assert.equal(chunk.body[0].type, "CallStatement");
});

test("a global that is ever assigned to is never aliased (that is #8a's domain)", () => {
  const chunk = alias(`
    counter = counter or 0
    counter = counter + 1
    counter = counter + 1
    counter = counter + 1
    counter = counter + 1
  `);

  // 代入されているため8bの対象外。まとめ上げ(#9)なしでの検証なので5文のまま。
  assert.equal(chunk.body.length, 5);
});

test("require and dofile are never aliased even when referenced frequently", () => {
  const chunk = alias(`
    local a = require("m1")
    local b = require("m2")
    local c = require("m3")
    local d = require("m4")
    local e = require("m5")
  `);

  // requireを指すエイリアス宣言が追加されていないことを確認する
  assert.equal(chunk.body.length, 5);
  chunk.body.forEach((statement) => {
    const local = statement as Parser.LocalStatement;
    const call = local.init[0] as Parser.CallExpression;
    assert.equal((call.base as Parser.Identifier).name, "require");
  });
});

test("a field name that happens to share an aliased global's spelling is left untouched", () => {
  const chunk = alias(`
    local t = {}
    t.screen = "not the global"
    screen.setColor(1)
    screen.setColor(2)
    screen.setColor(3)
    screen.setColor(4)
    screen.setColor(5)
  `);

  const fieldAssign = chunk.body[2] as Parser.AssignmentStatement;
  const fieldTarget = fieldAssign.variables[0] as Parser.MemberExpression;
  assert.equal(fieldTarget.identifier.name, "screen");
});

// Minifier全体（8a+8bの配線）を通した回帰テスト。insertGlobalAliases単体への
// excludeNamesは正しく機能していても、呼び出し側(minifier.ts)が
// mode.neverRenameGlobalsをexcludeNamesに含め忘れると、8aの対象にならない
// （＝一度も代入されていない）保護対象グローバルが8bで書き換えられてしまう。
test("mode.neverRenameGlobals also protects a global from #8b aliasing, not just #8a renaming", () => {
  const { code } = runMinifier({
    label: "mode.neverRenameGlobals also protects a global from #8b aliasing",
    fixture: "global-alias",
    mode: {
      requireWrapper: false,
      neverRenameGlobals: new Set(["screen"]),
    },
  });

  assert.ok(
    code.includes("screen.setColor"),
    `screenがエイリアス化されずそのまま残ること。実際の出力: ${code}`,
  );
});
