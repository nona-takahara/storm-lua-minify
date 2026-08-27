import { test } from "vitest";
import assert from "node:assert/strict";
import { Minifier } from "../src/minifier";
import { LUAPARSE_SETTINGS, fixtureEntryPath } from "./lib/helpers";

// require/dofileの参照グラフに循環がある場合、Linkパスがエラーを投げて
// 出力を開始しないことを検証する（#18）。

test("circular require is rejected with a clear error", () => {
  const minifier = new Minifier(
    fixtureEntryPath("circular-require"),
    LUAPARSE_SETTINGS,
    { requireWrapper: true },
  );
  assert.throws(
    () => minifier.parse(),
    /Circular require\/dofile detected: a -> b -> a/,
  );
});
