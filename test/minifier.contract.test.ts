import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import Parser from "luaparse";
import { SourceMapConsumer } from "source-map";
import { describe, test } from "vitest";
import { findIdentifierCollisions } from "./lib/collision";
import { executeLua } from "./lib/luaExecution";
import { fixtureExecution } from "./lib/fixtureExecution";
import {
  KNOWN_BUG_CASES,
  runMinifier,
  fixtureEntryPath,
  WORKING_CASES,
} from "./lib/helpers";

describe("minified output contract", () => {
  describe.each(WORKING_CASES)("$label", (fixture) => {
    test("preserves observed behavior, valid Lua, binding identity and source origins", async () => {
      const { code, map } = runMinifier(fixture);
      const input = fixtureEntryPath(fixture.fixture, fixture.entry);
      const { prelude, stdout } = fixtureExecution(fixture.fixture);
      for (const source of [fs.readFileSync(input, "utf8"), code]) {
        assert.deepEqual(
          executeLua(
            `${prelude}\nprint(pcall(function()\n${source}\nend))`,
            path.dirname(input),
          ),
          { status: 0, stdout, stderr: "" },
        );
      }

      assert.doesNotThrow(() => Parser.parse(code, { luaVersion: "5.3" }));
      assert.deepEqual(await findIdentifierCollisions(code, map), []);
      await SourceMapConsumer.with(map, null, (consumer) => {
        let mapped = 0;
        consumer.eachMapping((mapping) => {
          const origin = consumer.originalPositionFor({
            line: mapping.generatedLine,
            column: mapping.generatedColumn,
          });
          if (origin.source === null) return;
          assert.ok(origin.line !== null && origin.column !== null);
          const content = consumer.sourceContentFor(origin.source);
          assert.ok(content !== null);
          assert.ok(
            origin.line >= 1 && origin.line <= content.split("\n").length,
          );
          assert.ok(
            origin.column >= 0 &&
              origin.column <= content.split("\n")[origin.line - 1].length,
          );
          mapped++;
        });
        assert.ok(mapped > 0);
      });
    });
  });

  for (const fixture of KNOWN_BUG_CASES) {
    test.todo(
      `${fixture.label} satisfies the output contract (issue #${String(fixture.issue)})`,
    );
  }
});
