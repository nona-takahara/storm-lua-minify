import { test } from "node:test";
import assert from "node:assert/strict";
import { runMinifier } from "./lib/helpers";

// #20: CLIオプション(--no-rename)相当の`mode.rename = false`で識別子の短縮を
// 無効化できることを確認する（デバッグ用途）。局所変数名は元のまま出力され、
// 空白の除去などそれ以外のminify処理はそのまま行われる。
void test("mode.rename = false disables identifier shortening", () => {
  const { code } = runMinifier({
    label: "single-file (no rename)",
    fixture: "single-file",
    mode: { moduleLikeLua: false, rename: false },
  });

  assert.match(code, /local function add\(first,second\)/);
  assert.match(code, /local total=0/);
  assert.match(code, /for index=1,10 do total=add\(total,index\)end/);
  assert.match(code, /print\(total,i\)/);
});
