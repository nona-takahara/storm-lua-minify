import { test } from "node:test";
import assert from "node:assert/strict";
import Parser from "luaparse";
import { resolveScopes, ResolveResult } from "../src/resolver";
import { classifyAndRenameGlobals } from "../src/globalRename";

// #8a: 内部でのみ使用するグローバル識別子短縮の単体テスト。
// モジュール横断での一貫性、neverRenameによる保護、参照数によるランク付けを検証する。

function resolve(code: string): ResolveResult {
  return resolveScopes(Parser.parse(code, { luaVersion: "5.3" }));
}

void test("a global written in one module and only read in another gets the same short name in both", () => {
  const moduleA = resolve(`counter = 0`);
  const moduleB = resolve(`print(counter)`);
  const moduleResolve = new Map([
    ["a", moduleA],
    ["b", moduleB],
  ]);

  const renames = classifyAndRenameGlobals(moduleResolve, new Set(), new Set());
  assert.ok(renames.has("counter"));
});

void test("neverRename protects a global even if it is assigned somewhere", () => {
  const moduleA = resolve(`function onTick() end`);
  const moduleResolve = new Map([["a", moduleA]]);

  const renames = classifyAndRenameGlobals(
    moduleResolve,
    new Set(["onTick"]),
    new Set(),
  );
  assert.equal(renames.has("onTick"), false);
});

void test("a global that is never assigned anywhere is never renamed", () => {
  const moduleA = resolve(`print(screen)`);
  const moduleResolve = new Map([["a", moduleA]]);

  const renames = classifyAndRenameGlobals(moduleResolve, new Set(), new Set());
  assert.equal(renames.has("screen"), false);
});

void test("the busiest qualifying global (by total reference count across modules) gets the shortest name", () => {
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

  const renames = classifyAndRenameGlobals(moduleResolve, new Set(), new Set());
  const busyName = renames.get("busy");
  const rareName = renames.get("rare");
  assert.ok(busyName);
  assert.ok(rareName);
  assert.ok(busyName.length <= rareName.length);
  assert.notEqual(busyName, rareName);
});

void test("reserved names are never handed out as a global's short name", () => {
  const moduleA = resolve(`internal = 1`);
  const moduleResolve = new Map([["a", moduleA]]);

  const renames = classifyAndRenameGlobals(
    moduleResolve,
    new Set(),
    new Set(["a"]),
  );
  assert.notEqual(renames.get("internal"), "a");
});
