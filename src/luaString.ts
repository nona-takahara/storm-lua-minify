import Parser from "luaparse";

export interface LuaByteString {
  readonly bytes: Uint8Array;
}

export type LuaStringDecodeResult =
  | { readonly ok: true; readonly value: LuaByteString }
  | {
      readonly ok: false;
      readonly reason:
        | "invalid-delimiter"
        | "invalid-escape"
        | "out-of-range-byte"
        | "invalid-code-point";
    };

const encoder = new TextEncoder();

export function luaByteStringOfText(text: string): LuaByteString {
  return { bytes: encoder.encode(text) };
}

export function decodeLuaStringLiteral(
  node: Parser.StringLiteral,
): LuaStringDecodeResult {
  const raw = node.raw;
  const long = /^\[(=*)\[/.exec(raw);
  if (long) {
    const close = `]${long[1]}]`;
    if (!raw.endsWith(close)) {
      return { ok: false, reason: "invalid-delimiter" };
    }
    let value = raw.slice(long[0].length, -close.length);
    value = value.replace(/\r\n|\r/g, "\n");
    if (value.startsWith("\n")) value = value.slice(1);
    return { ok: true, value: luaByteStringOfText(value) };
  }

  const quote = raw[0];
  if (
    raw.length < 2 ||
    (quote !== '"' && quote !== "'") ||
    raw[raw.length - 1] !== quote
  ) {
    return { ok: false, reason: "invalid-delimiter" };
  }

  const bytes: number[] = [];
  const appendText = (text: string) => bytes.push(...encoder.encode(text));
  for (let index = 1; index < raw.length - 1; index++) {
    const current = raw[index];
    if (current !== "\\") {
      const codePoint = raw.codePointAt(index);
      if (codePoint === undefined) {
        return { ok: false, reason: "invalid-code-point" };
      }
      appendText(String.fromCodePoint(codePoint));
      if (codePoint > 0xffff) index++;
      continue;
    }

    index++;
    if (index >= raw.length - 1) {
      return { ok: false, reason: "invalid-escape" };
    }
    const escaped = raw[index];
    const simple = SIMPLE_ESCAPES[escaped];
    if (simple !== undefined) {
      bytes.push(simple);
      continue;
    }
    if (escaped === "\n" || escaped === "\r") {
      if (escaped === "\r" && raw[index + 1] === "\n") index++;
      bytes.push(0x0a);
      continue;
    }
    if (escaped === "z") {
      while (/\s/.test(raw[index + 1] ?? "")) index++;
      continue;
    }
    if (escaped === "x") {
      const hex = raw.slice(index + 1, index + 3);
      if (!/^[0-9a-fA-F]{2}$/.test(hex)) {
        return { ok: false, reason: "invalid-escape" };
      }
      bytes.push(Number.parseInt(hex, 16));
      index += 2;
      continue;
    }
    if (escaped === "u") {
      const match = /^\{([0-9a-fA-F]+)\}/.exec(raw.slice(index + 1));
      if (!match) return { ok: false, reason: "invalid-escape" };
      const codePoint = Number.parseInt(match[1], 16);
      if (
        codePoint > 0x10ffff ||
        (codePoint >= 0xd800 && codePoint <= 0xdfff)
      ) {
        return { ok: false, reason: "invalid-code-point" };
      }
      appendText(String.fromCodePoint(codePoint));
      index += match[0].length;
      continue;
    }
    if (/\d/.test(escaped)) {
      let digits = escaped;
      while (digits.length < 3 && /\d/.test(raw[index + 1] ?? "")) {
        digits += raw[++index];
      }
      const byte = Number.parseInt(digits, 10);
      if (byte > 255) return { ok: false, reason: "out-of-range-byte" };
      bytes.push(byte);
      continue;
    }
    return { ok: false, reason: "invalid-escape" };
  }
  return { ok: true, value: { bytes: Uint8Array.from(bytes) } };
}

export function luaByteStringKey(value: LuaByteString): string {
  return Array.from(value.bytes, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export function compareLuaByteStrings(
  left: LuaByteString,
  right: LuaByteString,
): number {
  const length = Math.min(left.bytes.length, right.bytes.length);
  for (let index = 0; index < length; index++) {
    if (left.bytes[index] !== right.bytes[index]) {
      return left.bytes[index] - right.bytes[index];
    }
  }
  return left.bytes.length - right.bytes.length;
}

export function concatLuaByteStrings(
  left: LuaByteString,
  right: LuaByteString,
): LuaByteString {
  const bytes = new Uint8Array(left.bytes.length + right.bytes.length);
  bytes.set(left.bytes);
  bytes.set(right.bytes, left.bytes.length);
  return { bytes };
}

/** 任意のLua byte列を、再decode可能な決定論的quoted literalへ戻す。 */
export function encodeLuaByteString(value: LuaByteString): string {
  const encodeWith = (quote: number): string => {
    let raw = String.fromCharCode(quote);
    value.bytes.forEach((byte) => {
      if (byte === quote || byte === 0x5c) {
        raw += `\\${String.fromCharCode(byte)}`;
      } else if (byte >= 0x20 && byte <= 0x7e) {
        raw += String.fromCharCode(byte);
      } else {
        raw += `\\x${byte.toString(16).padStart(2, "0")}`;
      }
    });
    return raw + String.fromCharCode(quote);
  };
  const doubleQuoted = encodeWith(0x22);
  const singleQuoted = encodeWith(0x27);
  return singleQuoted.length < doubleQuoted.length
    ? singleQuoted
    : doubleQuoted;
}

const SIMPLE_ESCAPES: Readonly<Partial<Record<string, number>>> = {
  a: 0x07,
  b: 0x08,
  f: 0x0c,
  n: 0x0a,
  r: 0x0d,
  t: 0x09,
  v: 0x0b,
  "\\": 0x5c,
  '"': 0x22,
  "'": 0x27,
};
