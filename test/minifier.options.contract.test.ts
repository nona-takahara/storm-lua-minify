import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import Parser from "luaparse";
import { describe, test } from "vitest";
import { Minifier } from "../src/minifier";
import { executeLua } from "./lib/luaExecution";
import { walkBlockDeep } from "../src/astWalk";
import { resolveScopes } from "../src/resolver";
import { minifyTemporaryLuaSource } from "./lib/minifierHarness";
import {
  fixtureEntryPath,
  LUAPARSE_SETTINGS,
  runMinifier,
} from "./lib/helpers";

function statementsOf(code: string): Parser.Statement[] {
  const result: Parser.Statement[] = [];
  walkBlockDeep(Parser.parse(code, { luaVersion: "5.3" }).body, {
    onStatement: (statement) => result.push(statement),
  });
  return result;
}

function hasNamedFunction(code: string, name: string): boolean {
  return statementsOf(code).some(
    (statement) =>
      statement.type === "FunctionDeclaration" &&
      statement.identifier?.type === "Identifier" &&
      statement.identifier.name === name,
  );
}

function hasGlobalWrite(code: string, name: string): boolean {
  return statementsOf(code).some(
    (statement) =>
      statement.type === "AssignmentStatement" &&
      statement.variables.some(
        (variable) => variable.type === "Identifier" && variable.name === name,
      ),
  );
}

describe("minifier options visible to library users", () => {
  test("Storm annotations independently protect names, declarations, and comments", () => {
    const { code } = runMinifier({
      label: "annotation contract",
      fixture: "annotations",
      mode: {
        requireWrapper: false,
        localDeclarationMerging: false,
        globalAliasing: false,
      },
    });

    const parsed = Parser.parse(code, { luaVersion: "5.3", comments: true });
    const comments = parsed.comments?.map((comment) => comment.raw) ?? [];
    for (const comment of [
      "--# file header",
      "--# before call",
      "--# after call",
    ])
      assert.ok(comments.includes(comment));
    assert.ok(
      comments.indexOf("--# before call") < comments.indexOf("--# after call"),
    );
    assert.ok(hasNamedFunction(code, "onTick"));
    const locals = statementsOf(code).filter(
      (statement): statement is Parser.LocalStatement =>
        statement.type === "LocalStatement",
    );
    assert.ok(
      locals.some((statement) =>
        statement.variables.some((variable) => variable.name === "descriptive"),
      ),
    );
    // keep protects the declaration; it does not require a particular renamed spelling.
    assert.ok(
      locals.some((statement) =>
        statement.init.some(
          (value) => value.type === "NumericLiteral" && value.value === 1,
        ),
      ),
    );
    assert.ok(
      !locals.some((statement) =>
        statement.variables.some((variable) => variable.name === "unused"),
      ),
    );
    assert.ok(
      !locals.some((statement) =>
        statement.init.some(
          (value) => value.type === "NumericLiteral" && value.value === 3,
        ),
      ),
    );
    const input = fixtureEntryPath("annotations");
    for (const source of [fs.readFileSync(input, "utf8"), code]) {
      assert.deepEqual(
        executeLua(
          `print(pcall(function()\n${source}\nonTick()\nend))`,
          path.dirname(input),
        ),
        { status: 0, stdout: "4\n2\n1\nnested\ntick\ntrue\n", stderr: "" },
      );
    }
  });

  test("configured and annotated global names are both preserved", () => {
    const { code } = runMinifier({
      label: "protected global contract",
      fixture: "annotations",
      mode: {
        requireWrapper: false,
        globalRenaming: true,
        localDeclarationMerging: false,
        globalAliasing: false,
        neverRenameGlobals: new Set(["configuredGlobal"]),
      },
    });

    assert.ok(hasNamedFunction(code, "onTick"));
    assert.ok(hasGlobalWrite(code, "configuredGlobal"));
  });

  test("global renaming is opt-in", () => {
    const common = {
      requireWrapper: false,
      localDeclarationMerging: false,
      globalAliasing: false,
    } as const;
    const defaultCode = runMinifier({
      label: "global rename default",
      fixture: "annotations",
      mode: common,
    }).code;
    const optedInCode = runMinifier({
      label: "global rename opt-in",
      fixture: "annotations",
      mode: { ...common, globalRenaming: true },
    }).code;

    assert.ok(hasGlobalWrite(defaultCode, "configuredGlobal"));
    assert.ok(!hasGlobalWrite(optedInCode, "configuredGlobal"));
  });

  test("unused-code removal can be disabled without changing other minification", () => {
    const { code } = runMinifier({
      label: "unused removal disabled",
      fixture: "annotations",
      mode: {
        requireWrapper: false,
        unusedCodeRemoval: false,
        localDeclarationMerging: false,
        globalAliasing: false,
      },
    });

    assert.ok(
      statementsOf(code).some(
        (statement) =>
          statement.type === "LocalStatement" &&
          statement.init.some(
            (value) => value.type === "NumericLiteral" && value.value === 3,
          ),
      ),
    );
    assert.doesNotThrow(() => Parser.parse(code, { luaVersion: "5.3" }));
  });

  test("identifier opt-out preserves bindings independently of output layout", () => {
    const { code } = runMinifier({
      label: "identifier optimizations disabled",
      fixture: "single-file",
      mode: {
        requireWrapper: false,
        identifierOptimizations: false,
        functionOptimizations: false,
        statementOptimizations: false,
        constantOptimizations: false,
        deadCodeOptimizations: false,
        objectOptimizations: false,
      },
    });

    const original = fs.readFileSync(fixtureEntryPath("single-file"), "utf8");
    const names = (source: string) =>
      resolveScopes(Parser.parse(source, { luaVersion: "5.3" }))
        .symbols.map((symbol) => symbol.name)
        .sort();
    assert.deepEqual(names(code), names(original));
    for (const source of [original, code])
      assert.deepEqual(executeLua(source), {
        status: 0,
        stdout: "55\t3\n",
        stderr: "",
      });
  });

  test.each([false, true])(
    "uses the configured token separator (wrapper=%s)",
    (requireWrapper) => {
      // Isolate the explicit printer option from unrelated optimization passes.
      const mode = { requireWrapper, optimizations: false };
      const lineFeed = minifyTemporaryLuaSource("return 42", mode).code;
      const space = minifyTemporaryLuaSource("return 42", {
        ...mode,
        requiredWhitespace: " ",
      }).code;
      assert.ok(lineFeed.includes("return\n42"));
      assert.ok(space.includes("return 42"));
      for (const source of [lineFeed, space]) {
        assert.doesNotThrow(() => Parser.parse(source, { luaVersion: "5.3" }));
        assert.deepEqual(
          executeLua(`print(pcall(function()\n${source}\nend))`),
          { status: 0, stdout: "true\t42\n", stderr: "" },
        );
      }
    },
  );

  test("a circular module dependency fails before output with its cycle", () => {
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
});
