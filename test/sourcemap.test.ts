import { describe, test } from "vitest";
import assert from "node:assert/strict";
import fs from "fs";
import { SourceMapConsumer } from "source-map";
import { fixtureEntryPath, runMinifier } from "./lib/helpers";

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

describe("generated source maps", () => {
  test("sets the generated file field", () => {
    const { map } = runMinifier({
      label: "source map generated file field",
      fixture: "multi-require",
      mode: { requireWrapper: true },
    });
    assert.equal(map.file, "multi-require.min.lua");
  });

  test("embeds the original text of every module in sourcesContent", async () => {
    const { map } = runMinifier({
      label: "source map sourcesContent",
      fixture: "multi-require",
      mode: { requireWrapper: true },
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
        fs.readFileSync(
          fixtureEntryPath("multi-require", "common.lua"),
          "utf8",
        ),
      );
    });
  });

  test("maps tokens from different modules to their own source positions", async () => {
    const { code, map } = runMinifier({
      label: "source map positions across modules",
      fixture: "multi-require",
      mode: { requireWrapper: false },
    });
    // Direct splicing gives each require its own generated occurrence.

    await SourceMapConsumer.with(map, null, (consumer) => {
      // The first inlined copy comes from common.lua.
      const firstValue = locateInGenerated(code, "42", 0);
      const firstValuePos = consumer.originalPositionFor(firstValue);
      assert.equal(firstValuePos.source, "common.lua");
      assert.equal(firstValuePos.line, 1);

      // The second copy has a distinct generated node with the same source origin.
      const secondValue = locateInGenerated(code, "42", 1);
      const secondValuePos = consumer.originalPositionFor(secondValue);
      assert.equal(secondValuePos.source, "common.lua");
      assert.equal(secondValuePos.line, 1);

      // The call remains attributed to the entry module.
      const printCall = locateInGenerated(code, "print");
      const printPos = consumer.originalPositionFor(printCall);
      assert.equal(printPos.source, "main.lua");
      assert.equal(printPos.line, 3);
      assert.equal(printPos.name, "print");
    });
  });

  test("preserves the source position and original name of an aliased reference", async () => {
    const { code, map } = runMinifier({
      label: "source map aliased reference provenance",
      fixture: "global-alias",
      mode: { requireWrapper: false },
    });

    assert.ok(
      !map.names.some((n) => n.startsWith("__mergeAlias")),
      `source-map names must not expose internal aliases: ${JSON.stringify(map.names)}`,
    );

    await SourceMapConsumer.with(map, null, (consumer) => {
      // Renaming changes generated spelling without changing source provenance.
      const secondCall = locateInGenerated(code, "setColor", 1);
      const pos = consumer.originalPositionFor(secondCall);
      assert.equal(pos.source, "main.lua");
      assert.equal(pos.name, "setColor");
    });
  });

  test("maps a hoisted assignment target to its original declaration", async () => {
    const { code, map } = runMinifier({
      label: "sourcemap: effect-aware local hoist",
      fixture: "effect-aware",
      mode: { requireWrapper: false, runtimeProfile: "stormworks" },
    });

    await SourceMapConsumer.with(map, null, (consumer) => {
      const rhs = locateInGenerated(code, "makeSecond");
      // The generated assignment target ends immediately before `=makeSecond()`.
      const lhs = consumer.originalPositionFor({
        line: rhs.line,
        column: rhs.column - 2,
      });
      assert.equal(lhs.source, "main.lua");
      assert.equal(lhs.line, 3);
      assert.equal(lhs.column, 6);
      assert.equal(lhs.name, "second");
    });
  });

  test("maps merged table-read variables and values to their original declarations", async () => {
    const { code, map } = runMinifier({
      label: "sourcemap: effect-aware table read merge",
      fixture: "effect-aware-table",
      mode: {
        requireWrapper: false,
        runtimeProfile: "stormworks",
        localDeclarationHoisting: false,
      },
    });

    await SourceMapConsumer.with(map, null, (consumer) => {
      const secondVariable = consumer.generatedPositionFor({
        source: "main.lua",
        line: 4,
        column: 6,
      });
      assert.ok(
        secondVariable.line !== null && secondVariable.column !== null,
        "second local variable must have a generated mapping",
      );
      const variableOrigin = consumer.originalPositionFor({
        line: secondVariable.line,
        column: secondVariable.column,
      });
      assert.equal(variableOrigin.source, "main.lua");
      assert.equal(variableOrigin.line, 4);
      assert.equal(variableOrigin.column, 6);
      assert.equal(variableOrigin.name, "second");

      const secondRead = locateInGenerated(code, ".y");
      const readOrigin = consumer.originalPositionFor({
        line: secondRead.line,
        column: secondRead.column + 1,
      });
      assert.equal(readOrigin.source, "main.lua");
      assert.equal(readOrigin.line, 4);
      assert.equal(readOrigin.name, "y");
    });
  });

  test("uses '/' in sources for dotted module names on every OS", () => {
    const { map } = runMinifier({
      label: "source map dotted module path separators",
      fixture: "nested-module",
      mode: { requireWrapper: true },
    });
    assert.ok(
      map.sources.includes("sub/deep.lua"),
      `sources must contain "sub/deep.lua": ${JSON.stringify(map.sources)}`,
    );
  });

  function locateInOriginal(
    source: string,
    needle: string,
    occurrence: number,
  ): { line: number; column: number } {
    return locateInGenerated(source, needle, occurrence);
  }

  test("maps each control-flow keyword to its own source occurrence", () => {
    const { code, map } = runMinifier({
      label: "source map control-flow keyword provenance",
      fixture: "control-flow-keywords",
      // Retain every keyword whose position is part of the contract.
      mode: { requireWrapper: false, unusedCodeRemoval: false },
    });
    const source = fs.readFileSync(
      fixtureEntryPath("control-flow-keywords"),
      "utf8",
    );

    const occurrences: [string, number][] = [
      ["if", 0],
      ["then", 0], // IfClause `then`
      ["elseif", 0],
      ["then", 1], // ElseifClause `then`
      ["else", 0],
      ["end", 0], // IfStatement closing `end`
      ["while", 0],
      ["do", 0], // WhileStatement `do`
      ["end", 1], // WhileStatement closing `end`
      ["do", 1], // standalone DoStatement
      ["end", 2], // DoStatement closing `end`
      ["repeat", 0],
      ["until", 0],
      ["for", 0],
      ["do", 2], // ForGenericStatement `do`
      ["end", 3], // ForGenericStatement closing `end`
      ["for", 1],
      ["do", 3], // ForNumericStatement `do`
      ["end", 4], // ForNumericStatement closing `end`
      // A local function's leading tokens share the statement position; only its
      // closing `end` carries an independent token position here.
      ["end", 5], // local FunctionDeclaration closing `end`
      ["function", 1], // anonymous FunctionExpression
      ["end", 6], // FunctionExpression closing `end`
    ];

    return SourceMapConsumer.with(map, null, (consumer) => {
      occurrences.forEach(([keyword, occurrence]) => {
        const generatedPos = locateInGenerated(code, keyword, occurrence);
        const resolved = consumer.originalPositionFor(generatedPos);
        const expected = locateInOriginal(source, keyword, occurrence);
        assert.equal(
          resolved.line,
          expected.line,
          `line for occurrence ${String(occurrence)} of "${keyword}"`,
        );
        assert.equal(
          resolved.column,
          expected.column,
          `column for occurrence ${String(occurrence)} of "${keyword}"`,
        );
      });
    });
  });
});
