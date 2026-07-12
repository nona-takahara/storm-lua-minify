import { test } from "node:test";
import assert from "node:assert/strict";
import { WORKING_CASES, KNOWN_BUG_CASES, runMinifier } from "./lib/helpers";
import { findIdentifierCollisions } from "./lib/collision";

// 出力コードの同一スコープ内で、同じ短縮識別子が異なるオリジナル識別子に
// 割り当てられていないことを検証する（#12の回帰防止）。

for (const c of WORKING_CASES) {
  void test(`identifier collision: ${c.label}`, async () => {
    const { code, map } = runMinifier(c);
    const collisions = await findIdentifierCollisions(code, map);
    assert.deepEqual(collisions, []);
  });
}

for (const c of KNOWN_BUG_CASES) {
  const issue = String(c.issue);
  void test(`identifier collision (known bug, issue #${issue}): ${c.label}`, { todo: `#${issue} の本修正待ち` }, async () => {
    const { code, map } = runMinifier(c);
    const collisions = await findIdentifierCollisions(code, map);
    assert.deepEqual(collisions, []);
  });
}
