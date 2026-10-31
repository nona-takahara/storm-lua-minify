import assert from "node:assert/strict";
import Parser from "luaparse";
import { describe, test } from "vitest";
import { Minifier } from "../src/minifier";
import {
  fixtureEntryPath,
  LUAPARSE_SETTINGS,
  runMinifier,
} from "./lib/helpers";

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

    assert.match(code, /--# file header\nfunction\nonTick/);
    assert.match(code, /local\ndescriptive=2/);
    assert.doesNotMatch(code, /retained|unused/);
    assert.match(code, /--# before call\nprint\([a-zA-Z_]\)/);
    assert.match(code, /print\([a-zA-Z_]\)\n--# after call/);
    assert.doesNotThrow(() => Parser.parse(code, { luaVersion: "5.3" }));
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

    assert.match(code, /function\nonTick/);
    assert.match(code, /configuredGlobal=4/);
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

    assert.match(defaultCode, /configuredGlobal=4/);
    assert.doesNotMatch(optedInCode, /configuredGlobal/);
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

    assert.match(code, /local\n[a-zA-Z_]=3/);
    assert.doesNotThrow(() => Parser.parse(code, { luaVersion: "5.3" }));
  });

  test("identifier optimizations can be disabled while syntax is still minified", () => {
    const { code } = runMinifier({
      label: "identifier optimizations disabled",
      fixture: "single-file",
      mode: { requireWrapper: false, identifierOptimizations: false },
    });

    assert.match(code, /local\nfunction\nadd\(first,second\)/);
    assert.match(code, /local\ntotal=0/);
    assert.match(code, /for\nindex=1,10\ndo\ntotal=add\(total,index\)end/);
  });

  test.each([
    ["direct module splicing", false, /local\nfunction/],
    ["require wrapper", true, /^function\nrequire\(m,r\)/],
  ] as const)(
    "%s uses LF for required whitespace by default and accepts a space instead",
    (_label, requireWrapper, lineFeedPattern) => {
      const fixture = requireWrapper ? "require-call" : "single-file";
      const lineFeed = runMinifier({
        label: "required whitespace LF",
        fixture,
        mode: { requireWrapper },
      }).code;
      const space = runMinifier({
        label: "required whitespace space",
        fixture,
        mode: { requireWrapper, requiredWhitespace: " " },
      }).code;

      assert.match(lineFeed, lineFeedPattern);
      assert.equal(Buffer.byteLength(lineFeed), Buffer.byteLength(space));
      assert.doesNotThrow(() => Parser.parse(lineFeed, { luaVersion: "5.3" }));
      assert.doesNotThrow(() => Parser.parse(space, { luaVersion: "5.3" }));
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
