import { describe, test } from "vitest";
import assert from "node:assert/strict";
import Parser from "luaparse";
import { SourceNode } from "source-map";
import { buildMinifiedOutput } from "../src/output";

function makeNode(): SourceNode {
  return new SourceNode(1, 0, "main.lua", "print(1)");
}

describe("buildMinifiedOutput", () => {
  test("sets the map file field", () => {
    const { map } = buildMinifiedOutput(
      makeNode(),
      "main.min.lua",
      "main.lua.map",
    );

    const parsed = JSON.parse(map) as { file?: string };
    assert.equal(parsed.file, "main.min.lua");
  });

  test("defaults to a legacy multiline block comment that remains valid Lua", () => {
    const { code } = buildMinifiedOutput(
      makeNode(),
      "main.min.lua",
      "main.lua.map",
    );

    assert.equal(code, "print(1)\n--[[\n//# sourceMappingURL=main.lua.map\n]]");
    assert.doesNotThrow(() => Parser.parse(code, { luaVersion: "5.3" }));
  });

  test('produces the default output when "legacy" is explicit', () => {
    const { code } = buildMinifiedOutput(
      makeNode(),
      "main.min.lua",
      "main.lua.map",
      {
        sourceMappingUrlStyle: "legacy",
      },
    );

    assert.equal(code, "print(1)\n--[[\n//# sourceMappingURL=main.lua.map\n]]");
  });

  test('puts the "line" sourceMappingURL on the final nonempty line and keeps valid Lua', () => {
    const { code } = buildMinifiedOutput(
      makeNode(),
      "main.min.lua",
      "main.lua.map",
      {
        sourceMappingUrlStyle: "line",
      },
    );

    const lines = code.split("\n");
    while (lines.length > 0 && lines[lines.length - 1] === "") {
      lines.pop();
    }
    const lastLine = lines[lines.length - 1];

    assert.equal(lastLine, "-- //# sourceMappingURL=main.lua.map");
    assert.ok(lastLine.startsWith("--") && !lastLine.startsWith("--[["));
    assert.doesNotThrow(() => Parser.parse(code, { luaVersion: "5.3" }));
  });

  // Lua parses `/` and `//` as binary operators, so the strict annotation cannot
  // also be valid Lua when it appears at the start of a line.
  test('emits an uncommented "strict" annotation that is not valid Lua', () => {
    const { code } = buildMinifiedOutput(
      makeNode(),
      "main.min.lua",
      "main.lua.map",
      {
        sourceMappingUrlStyle: "strict",
      },
    );

    const lines = code.split("\n");
    while (lines.length > 0 && lines[lines.length - 1] === "") {
      lines.pop();
    }
    const lastLine = lines[lines.length - 1];

    assert.equal(lastLine, "//# sourceMappingURL=main.lua.map");
    assert.throws(() => Parser.parse(code, { luaVersion: "5.3" }));
  });
});
