import { describe, test } from "vitest";
import assert from "node:assert/strict";
import Parser from "luaparse";
import { runMinifier } from "./lib/helpers";
import { minifyTemporaryLuaSource } from "./lib/minifierHarness";
import { executeLua } from "./lib/luaExecution";

function minifyExpression(exprSource: string): string {
  return minifyTemporaryLuaSource(`return ${exprSource}\n`, {
    requireWrapper: false,
  }).code;
}

describe("expression precedence in minified output", () => {
  test.each([
    ["2 ^ 3 ^ 2", "512.0\n"],
    ["(2 ^ 3) ^ 2", "64.0\n"],
    ["-2 ^ 2", "-4.0\n"],
    ["(-2) ^ 2", "4.0\n"],
    ["3 | 4 & 2", "3\n"],
    ["(3 | 4) & 2", "2\n"],
    ["20 // 3 // 2", "3\n"],
    ["20 // (3 // 2)", "20\n"],
    ['0xff .. "x"', "255x\n"],
    ["#(1 .. 2)", "2\n"],
  ])("preserves the Lua result of %s", (expression, stdout) => {
    const expected = { status: 0, stdout, stderr: "" };
    const code = minifyExpression(expression);
    assert.deepEqual(executeLua(`print(${expression})`), expected);
    assert.deepEqual(
      executeLua(`print((function()\n${code}\nend)())`),
      expected,
    );
  });

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
