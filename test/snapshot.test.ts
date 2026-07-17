import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import { WORKING_CASES, runMinifier, slug, SNAPSHOTS_DIR } from "./lib/helpers";

// UPDATE_SNAPSHOTS=1 npm test でゴールデンファイルを更新できる。
const UPDATE = process.env.UPDATE_SNAPSHOTS === "1";

for (const c of WORKING_CASES) {
  void test(`snapshot: ${c.label}`, () => {
    const { code } = runMinifier(c);
    const snapshotPath = path.join(SNAPSHOTS_DIR, `${slug(c)}.lua`);

    if (UPDATE) {
      fs.writeFileSync(snapshotPath, code);
      return;
    }

    assert.ok(
      fs.existsSync(snapshotPath),
      `スナップショットが存在しません: ${snapshotPath}\nUPDATE_SNAPSHOTS=1 npm test で生成してください。`,
    );
    const expected = fs.readFileSync(snapshotPath, "utf8");
    assert.equal(code, expected);
  });
}
