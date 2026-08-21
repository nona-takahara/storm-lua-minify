import { test } from "vitest";
import assert from "node:assert/strict";
import { matchesIssue52Pattern } from "./issue52";

const KNOWN_24 = [
  "((7 and (16 and 4)) // (~(0xffffffffffffffff) .. 0x10))",
  "(not (0) // (0.5 .. (true << 64)))",
  'not (((8 // "z9") .. false))',
  "(0.5 % (2 .. (16 or 10)))",
  "(100 % (nil .. 63))",
  '(1.5 // (~("10") .. 0x7fffffffffffffff))',
  '(((63 >> 8) // ("" .. 0.0)) .. ((0.0 << 0x8000000000000000) <= (nil < "3")))',
  '((false .. (0x7fffffffffffffff ~= 1e10)) + ((7 ~ false) ~ "-1"))',
  'not ((("a" .. 7) / (16 <= 100)))',
  "((true .. (4 == 0xffffffffffffffff)) * true)",
  "(65 | #((3.14 .. true)))",
  "(not (not (63)) - (true .. 10))",
  'not (((32 // 16) .. "3"))',
  "(-((4 .. 10)) >= 100)",
  '#(("b" - (0x8000000000000000 .. false)))',
  "(#((true .. 0x2)) / 5)",
  "(1e10 // (1e-300 .. 1.5))",
  '((("abc" .. true) .. false) + 0.5)',
  "~(((8 and 10) .. 32))",
  "~((nil .. 7))",
  '~((16 .. "Hello"))',
  "#((1e-10 .. (false % 0.0)))",
  '(((false or 3) % (10 // 0x8000000000000000)) + (~(5) .. "Hello"))',
  "(32 <= (8 ^ (1 .. 2)))",
];

test("issue52 self-test: known 24 mismatches all match", () => {
  const failed = KNOWN_24.filter((e) => !matchesIssue52Pattern(e));
  assert.deepEqual(failed, []);
});

test("issue52 self-test: negative controls do not match", () => {
  const negatives = [
    '"a" .. "b"',
    "(1 .. 2) == 3",
    "1 << (2 .. 3)",
    "(1 .. 2) and true",
    "(1 .. 2) | 3",
    "(1 .. 2) ~= 3",
    "1+2",
    "10 % 1e-300",
  ];
  const wronglyMatched = negatives.filter((e) => matchesIssue52Pattern(e));
  assert.deepEqual(wronglyMatched, []);
});

test("issue52 self-test: positive controls for each higher-precedence operator", () => {
  const positives = [
    "1 + (2 .. 3)",
    "1 - (2 .. 3)",
    "1 * (2 .. 3)",
    "1 / (2 .. 3)",
    "1 // (2 .. 3)",
    "1 % (2 .. 3)",
    "1 ^ (2 .. 3)",
    "-(2 .. 3)",
    "not (2 .. 3)",
    "#(2 .. 3)",
    "~(2 .. 3)",
  ];
  const missed = positives.filter((e) => !matchesIssue52Pattern(e));
  assert.deepEqual(missed, []);
});
