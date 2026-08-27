import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import Parser from "luaparse";
import { describe, test } from "vitest";
import { findIdentifierCollisions } from "./lib/collision";
import {
  KNOWN_BUG_CASES,
  runMinifier,
  slug,
  SNAPSHOTS_DIR,
  WORKING_CASES,
} from "./lib/helpers";

const UPDATE_SNAPSHOTS = process.env.UPDATE_SNAPSHOTS === "1";

describe("minified output contract", () => {
  describe.each(WORKING_CASES)("$label", (fixture) => {
    test("matches the approved output, remains valid Lua, and preserves binding identity", async () => {
      const { code, map } = runMinifier(fixture);
      const snapshotPath = path.join(SNAPSHOTS_DIR, `${slug(fixture)}.lua`);

      if (UPDATE_SNAPSHOTS) {
        fs.writeFileSync(snapshotPath, code);
      } else {
        assert.ok(
          fs.existsSync(snapshotPath),
          `Missing approved output: ${snapshotPath}. Run UPDATE_SNAPSHOTS=1 pnpm test to create it.`,
        );
        assert.equal(code, fs.readFileSync(snapshotPath, "utf8"));
      }

      assert.doesNotThrow(() => Parser.parse(code, { luaVersion: "5.3" }));
      assert.deepEqual(await findIdentifierCollisions(code, map), []);
    });
  });

  for (const fixture of KNOWN_BUG_CASES) {
    test.todo(
      `${fixture.label} satisfies the output contract after issue #${String(fixture.issue)} is fixed`,
    );
  }
});
