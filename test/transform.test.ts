import { describe, test } from "vitest";
import assert from "node:assert/strict";
import Parser from "luaparse";
import {
  applyStatementSchedule,
  planStatementSchedule,
} from "../src/statementScheduler";
import { analyzeLua } from "./lib/optimizerHarness";

describe("local declaration merging", () => {
  function merge(code: string, preserveRequireSplice = false): Parser.Chunk {
    const { chunk, resolved, analysis } = analyzeLua(code);
    applyStatementSchedule(
      planStatementSchedule(chunk, resolved, {
        facts: analysis.facts,
        dataflow: analysis.statementDataflow,
        outputNameLengthOf: () => 1,
        preserveRequireSplice,
        enableLocalPacking: false,
        enableLexicalLocalMerge: true,
      }),
    );
    return chunk;
  }

  function localStatements(chunk: Parser.Chunk): Parser.LocalStatement[] {
    return chunk.body.filter(
      (s): s is Parser.LocalStatement => s.type === "LocalStatement",
    );
  }

  test("consecutive single-var/single-init locals are merged into one statement", () => {
    const chunk = merge(`
    local a = require("x")
    local b = require("y")
    local c = require("z")
  `);

    assert.equal(chunk.body.length, 1);
    const merged = chunk.body[0] as Parser.LocalStatement;
    assert.deepEqual(
      merged.variables.map((v) => v.name),
      ["a", "b", "c"],
    );
    assert.equal(merged.init.length, 3);
  });

  test("hazard 1: a later statement referencing a just-declared variable blocks merging", () => {
    const chunk = merge(`
    local a = 1
    local b = a
  `);

    assert.equal(localStatements(chunk).length, 2);
  });

  test("hazard 1 (nested closure): a lexically-captured reference inside a function literal still blocks merging", () => {
    const chunk = merge(`
    local a = 1
    local f = function() return a end
  `);

    assert.equal(localStatements(chunk).length, 2);
  });

  test("hazard 1: an unrelated global reference of the same spelling does not block merging", () => {
    // This `a` is a global reference, not the preceding local declaration.
    const chunk = merge(`
    local x = 1
    local y = a
  `);

    assert.equal(localStatements(chunk).length, 1);
  });

  test("hazard 2 (deficit + expandable last expression): must not become non-terminal", () => {
    const chunk = merge(`
    local a, b = f()
    local c = 1
  `);

    // The declaration that expands `f()` must remain terminal in its group.
    assert.equal(localStatements(chunk).length, 2);
  });

  test("hazard 2 (deficit, safely paddable): merges with explicit nil padding", () => {
    const chunk = merge(`
    local a, b = 1
    local c = 2
  `);

    assert.equal(localStatements(chunk).length, 1);
    const merged = localStatements(chunk)[0];
    assert.deepEqual(
      merged.variables.map((v) => v.name),
      ["a", "b", "c"],
    );
    assert.deepEqual(
      merged.init.map((e) => e.type),
      ["NumericLiteral", "NilLiteral", "NumericLiteral"],
    );
  });

  test("hazard 2 (surplus): must not become non-terminal", () => {
    const chunk = merge(`
    local a = 1, g()
    local b = 2
  `);

    assert.equal(localStatements(chunk).length, 2);
  });

  test("a group-terminal statement may have any variable/init shape", () => {
    const chunk = merge(`
    local x = 1
    local a, b = f()
  `);

    assert.equal(chunk.body.length, 1);
    const merged = chunk.body[0] as Parser.LocalStatement;
    assert.deepEqual(
      merged.variables.map((v) => v.name),
      ["x", "a", "b"],
    );
    assert.deepEqual(
      merged.init.map((e) => e.type),
      ["NumericLiteral", "CallExpression"],
    );
  });

  test("trailing synthetic nils are stripped from the merged init list", () => {
    const chunk = merge(`
    local a
    local b
    local c = 1
  `);

    const merged = chunk.body[0] as Parser.LocalStatement;
    assert.deepEqual(
      merged.variables.map((v) => v.name),
      ["a", "b", "c"],
    );
    // `a` and `b` receive nil padding while only `c` remains terminal.
    assert.deepEqual(
      merged.init.map((e) => e.type),
      ["NilLiteral", "NilLiteral", "NumericLiteral"],
    );
  });

  test("`local function` breaks a run of consecutive local statements", () => {
    const chunk = merge(`
    local a = 1
    local function f() end
    local b = 2
  `);

    assert.equal(localStatements(chunk).length, 2);
    assert.equal(chunk.body.length, 3);
  });

  test("hazard 4: SL-mode splice-eligible require statements are kept as their own group when preserveRequireSplice is set", () => {
    const chunk = merge(
      `
      local a = require("x")
      local b = require("y")
    `,
      true,
    );

    assert.equal(localStatements(chunk).length, 2);
  });

  test("without preserveRequireSplice, require statements merge like any other", () => {
    const chunk = merge(
      `
      local a = require("x")
      local b = require("y")
    `,
      false,
    );

    assert.equal(localStatements(chunk).length, 1);
  });

  test("merging recurses into nested blocks", () => {
    const chunk = merge(`
    if true then
      local a = 1
      local b = 2
    end
  `);

    const ifStatement = chunk.body[0] as Parser.IfStatement;
    const clauseBody = ifStatement.clauses[0].body;
    assert.equal(clauseBody.length, 1);
    const merged = clauseBody[0] as Parser.LocalStatement;
    assert.deepEqual(
      merged.variables.map((v) => v.name),
      ["a", "b"],
    );
  });

  test("merging preserves node identity so resolveResult.symbolOf keeps working after the merge", () => {
    const { chunk, resolved, analysis } = analyzeLua(`
    local a = 1
    local b = 2
    print(a, b)
  `);
    const aSymbolBefore = resolved.symbolOf(
      (chunk.body[0] as Parser.LocalStatement).variables[0],
    );
    applyStatementSchedule(
      planStatementSchedule(chunk, resolved, {
        facts: analysis.facts,
        dataflow: analysis.statementDataflow,
        outputNameLengthOf: () => 1,
        preserveRequireSplice: false,
        enableLocalPacking: false,
        enableLexicalLocalMerge: true,
      }),
    );

    const merged = chunk.body[0] as Parser.LocalStatement;
    assert.equal(resolved.symbolOf(merged.variables[0]), aSymbolBefore);

    const printArgs = (
      (chunk.body[1] as Parser.CallStatement)
        .expression as Parser.CallExpression
    ).arguments;
    assert.equal(
      resolved.symbolOf(printArgs[0] as Parser.Identifier),
      aSymbolBefore,
    );
  });
});
