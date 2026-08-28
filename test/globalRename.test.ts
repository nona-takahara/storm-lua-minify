import { describe, test } from "vitest";
import assert from "node:assert/strict";
import Parser from "luaparse";
import { resolveScopes, ResolveResult } from "../src/resolver";
import { classifyAndRenameGlobals } from "../src/globalRename";

describe("global identifier renaming", () => {
  function resolve(code: string): ResolveResult {
    return resolveScopes(Parser.parse(code, { luaVersion: "5.3" }));
  }

  test("a global written in one module and only read in another gets the same short name in both", () => {
    const moduleA = resolve(`counter = 0`);
    const moduleB = resolve(`print(counter)`);
    const moduleResolve = new Map([
      ["a", moduleA],
      ["b", moduleB],
    ]);

    const renames = classifyAndRenameGlobals(
      moduleResolve,
      new Set(),
      new Set(),
    );
    assert.ok(renames.has("counter"));
  });

  test("neverRename protects a global even if it is assigned somewhere", () => {
    const moduleA = resolve(`function onTick() end`);
    const moduleResolve = new Map([["a", moduleA]]);

    const renames = classifyAndRenameGlobals(
      moduleResolve,
      new Set(["onTick"]),
      new Set(),
    );
    assert.equal(renames.has("onTick"), false);
  });

  test("a global that is never assigned anywhere is never renamed", () => {
    const moduleA = resolve(`print(screen)`);
    const moduleResolve = new Map([["a", moduleA]]);

    const renames = classifyAndRenameGlobals(
      moduleResolve,
      new Set(),
      new Set(),
    );
    assert.equal(renames.has("screen"), false);
  });

  test("the busiest qualifying global (by total reference count across modules) gets the shortest name", () => {
    const moduleA = resolve(`
    busy = 0
    rare = 0
    busy = busy + 1
    busy = busy + 1
  `);
    const moduleB = resolve(`print(busy, rare)`);
    const moduleResolve = new Map([
      ["a", moduleA],
      ["b", moduleB],
    ]);

    const renames = classifyAndRenameGlobals(
      moduleResolve,
      new Set(),
      new Set(),
    );
    const busyName = renames.get("busy");
    const rareName = renames.get("rare");
    assert.ok(busyName);
    assert.ok(rareName);
    assert.ok(busyName.length <= rareName.length);
    assert.notEqual(busyName, rareName);
  });

  test("reserved names are never handed out as a global's short name", () => {
    const moduleA = resolve(`internal = 1`);
    const moduleResolve = new Map([["a", moduleA]]);

    const renames = classifyAndRenameGlobals(
      moduleResolve,
      new Set(),
      new Set(["a"]),
    );
    assert.notEqual(renames.get("internal"), "a");
  });
});
