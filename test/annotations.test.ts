import { test } from "vitest";
import assert from "node:assert/strict";
import Parser from "luaparse";
import { runMinifier } from "./lib/helpers";

test("annotations protect declarations and preserved comments stay near their statements", () => {
  const { code } = runMinifier({
    label: "annotations",
    fixture: "annotations",
    mode: { moduleLikeLua: false, mergeLocals: false, globalAlias: false },
  });
  assert.match(code, /--# file header\nfunction\nonTick/);
  assert.match(code, /local\ndescriptive=2/);
  assert.doesNotMatch(code, /retained/);
  assert.match(code, /--# before call\nprint\([a-zA-Z_]\)/);
  assert.match(code, /print\([a-zA-Z_]\)\n--# after call/);
  assert.doesNotThrow(() => Parser.parse(code, { luaVersion: "5.3" }));
  assert.doesNotMatch(code, /unused/);
});

test("annotation and configured global-name protection are combined", () => {
  const { code } = runMinifier({
    label: "annotation and config protection",
    fixture: "annotations",
    mode: {
      moduleLikeLua: false,
      mergeLocals: false,
      globalAlias: false,
      neverRenameGlobals: new Set(["configuredGlobal"]),
    },
  });
  assert.match(code, /function\nonTick/);
  assert.match(code, /configuredGlobal=4/);
});

test("global rename is disabled by default and enabled only by explicit opt-in", () => {
  const commonMode = {
    moduleLikeLua: false,
    mergeLocals: false,
    globalAlias: false,
  } as const;
  const defaultResult = runMinifier({
    label: "global rename default",
    fixture: "annotations",
    mode: commonMode,
  });
  const optedInResult = runMinifier({
    label: "global rename opt-in",
    fixture: "annotations",
    mode: { ...commonMode, globalRename: true },
  });

  assert.match(defaultResult.code, /configuredGlobal=4/);
  assert.doesNotMatch(optedInResult.code, /configuredGlobal/);
});

test("removeUnused false preserves otherwise removable locals", () => {
  const { code } = runMinifier({
    label: "annotations no removal",
    fixture: "annotations",
    mode: {
      moduleLikeLua: false,
      removeUnused: false,
      mergeLocals: false,
      globalAlias: false,
    },
  });
  assert.match(code, /local\n[a-zA-Z_]=3/);
});

test("disabling future global removal does not disable local removal", () => {
  const { code } = runMinifier({
    label: "annotations local removal",
    fixture: "annotations",
    mode: {
      moduleLikeLua: false,
      removeUnusedGlobals: false,
      mergeLocals: false,
      globalAlias: false,
    },
  });
  assert.doesNotMatch(code, /unused/);
});
