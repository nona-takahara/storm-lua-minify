import { describe, test } from "vitest";
import assert from "node:assert/strict";
import Parser from "luaparse";
import fs from "fs";
import os from "os";
import path from "path";
import { runMinifier } from "./lib/helpers";
import { Minifier } from "../src/minifier";

function minifyExpression(exprSource: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "storm-precedence-"));
  const filePath = path.join(dir, "main.lua");
  fs.writeFileSync(filePath, "return " + exprSource + "\n");
  try {
    return new Minifier(
      filePath,
      { locations: true, luaVersion: "5.3", ranges: true, scope: true },
      { requireWrapper: false },
    )
      .parse()
      .toStringWithSourceMap({ file: "main.min.lua" }).code;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe("expression precedence in minified output", () => {
  test("preserves bitwise and floor-division precedence", () => {
    const { code } = runMinifier({
      label: "bitwise-precedence",
      fixture: "bitwise-precedence",
      // Keep the assertions focused on operators rather than renamed globals.
      mode: { requireWrapper: false, globalAliasing: false },
    });

    // `&` binds more tightly than `|`, so only the second form needs parentheses.
    assert.match(code, /print\(a\|b&c\)/);
    assert.match(code, /print\(\(a\|b\)&c\)/);
    assert.match(code, /print\(a&b\|c\)/);
    assert.match(code, /print\(a~b&c\)/);
    // `+` binds more tightly than `<<`, so only the second form needs parentheses.
    assert.match(code, /print\(a<<b\+c\)/);
    assert.match(code, /print\(\(a<<b\)\+c\)/);
    assert.match(code, /print\(a\/\/b\/\/c\)/);
    assert.match(code, /print\(~a&b\)/);
  });

  test("keeps concatenation parenthesized under higher-precedence operators", () => {
    assert.match(minifyExpression("0.5 % (2 .. 16)"), /0\.5%\(2[ \n]\.\.16\)/);
    assert.match(minifyExpression("(1 .. 2) + 3"), /\(1[ \n]\.\.2\)\+3/);
    assert.match(minifyExpression("-(1 .. 2)"), /-\(1[ \n]\.\.2\)/);
    assert.match(minifyExpression("#(1 .. 2)"), /#\(1[ \n]\.\.2\)/);

    // The opposite precedence direction and right associativity need no grouping.
    assert.match(minifyExpression("(1 .. 2) < 3"), /1[ \n]\.\.2<3/);
    assert.match(minifyExpression("(1 + 2) .. 3"), /1\+2[ \n]\.\.3/);
    assert.match(minifyExpression("1 .. (2 .. 3)"), /1[ \n]\.\.2[ \n]\.\.3/);
  });

  test("keeps left-side parentheses for right-associative exponentiation", () => {
    assert.match(minifyExpression("(1 ^ 2) ^ 3"), /\(1\^2\)\^3/);
    assert.match(minifyExpression("1 ^ (2 ^ 3)"), /1\^2\^3/);
  });

  // Lua can read a trailing dot after a hexadecimal literal as part of the number.
  test("separates concatenation from a hexadecimal literal ending in a-f", () => {
    const hex = minifyExpression('0xff .. "x"');
    assert.doesNotThrow(() => Parser.parse(hex, { luaVersion: "5.3" }));
    const dec = minifyExpression('255 .. "x"');
    assert.doesNotThrow(() => Parser.parse(dec, { luaVersion: "5.3" }));
  });
});
