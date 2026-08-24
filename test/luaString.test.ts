import Parser from "luaparse";
import { describe, expect, test } from "vitest";
import {
  decodeLuaStringLiteral,
  encodeLuaByteString,
  luaByteStringKey,
} from "../src/luaString";

function decode(raw: string): number[] | undefined {
  const chunk = Parser.parse(`return ${raw}`, { luaVersion: "5.3" });
  const statement = chunk.body[0];
  if (
    statement.type !== "ReturnStatement" ||
    statement.arguments[0]?.type !== "StringLiteral"
  ) {
    throw new Error("expected a string literal");
  }
  const result = decodeLuaStringLiteral(statement.arguments[0]);
  return result.ok ? [...result.value.bytes] : undefined;
}

describe("Lua byte string decoder", () => {
  test.each([
    ['"x"', [0x78]],
    ['"\\120"', [0x78]],
    ['"\\x78"', [0x78]],
    ['"a\\0b"', [0x61, 0x00, 0x62]],
    ['"\\u{3042}"', [0xe3, 0x81, 0x82]],
    ['"a\\z  \n b"', [0x61, 0x62]],
    ["[[\nline\r\nnext]]", [...new TextEncoder().encode("line\nnext")]],
    ["[=[value]=]", [...new TextEncoder().encode("value")]],
  ])("decodes %s as Lua bytes", (raw, expected) => {
    expect(decode(raw)).toEqual(expected);
  });

  test("uses a collision-free canonical byte key", () => {
    const literal = Parser.parse('return "\\120"', {
      luaVersion: "5.3",
    }).body[0];
    if (
      literal.type !== "ReturnStatement" ||
      literal.arguments[0]?.type !== "StringLiteral"
    ) {
      throw new Error("expected a string literal");
    }
    const decoded = decodeLuaStringLiteral(literal.arguments[0]);
    expect(decoded.ok && luaByteStringKey(decoded.value)).toBe("78");
  });

  test.each([
    { bytes: [] },
    { bytes: [0, 10, 13, 255] },
    { bytes: [0x22, 0x27, 0x5c] },
    { bytes: [0x61, 0xe3, 0x81, 0x82] },
  ])("printer representation round-trips byte sequence $bytes", ({ bytes }) => {
    const raw = encodeLuaByteString({ bytes: Uint8Array.from(bytes) });
    expect(decode(raw)).toEqual(bytes);
  });

  test.each([
    ['"\\xg0"', "invalid-escape"],
    ['"\\256"', "out-of-range-byte"],
    ['"\\u{110000}"', "invalid-code-point"],
    ['"unterminated', "invalid-delimiter"],
  ] as const)("rejects malformed literal %s", (raw, reason) => {
    const result = decodeLuaStringLiteral({
      type: "StringLiteral",
      raw,
      value: "",
    });
    expect(result).toEqual({ ok: false, reason });
  });
});
