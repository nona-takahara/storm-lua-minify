import { test } from "node:test";
import assert from "node:assert/strict";
import { Minifier } from "../src/minifier";
import { LUAPARSE_SETTINGS, fixtureEntryPath } from "./lib/helpers";

// require/dofileの参照グラフに循環がある場合、Linkパスがエラーを投げて
// 出力を開始しないことを検証する（#18）。

void test("circular require is rejected with a clear error", () => {
  const minifier = new Minifier(
    fixtureEntryPath("circular-require"),
    LUAPARSE_SETTINGS,
    { moduleLikeLua: true },
  );
  assert.throws(
    () => minifier.parse(),
    /Circular require\/dofile detected: a -> b -> a/,
  );
});
