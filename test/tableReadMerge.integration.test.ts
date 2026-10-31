import Parser from "luaparse";
import { describe, expect, test } from "vitest";
import { MinifierMode } from "../src/minifier";
import { minifyTemporaryLuaSource } from "./lib/minifierHarness";

function minifyExact(source: string, mode: MinifierMode): string {
  return minifyTemporaryLuaSource(source, mode, {
    prefix: "storm-table-read-merge-test-",
  }).code;
}

function minify(source: string, mode: Partial<MinifierMode> = {}): string {
  return minifyExact(source, {
    requireWrapper: false,
    runtimeProfile: "stormworks",
    ...mode,
  });
}

describe("effect-aware table read merge pipeline", () => {
  test("merges stable fresh-table reads and shortens valid output", () => {
    const source = `
local tableValue={x=1,y=2}
local first=tableValue.x
tick()
local second=tableValue.y
use(first,second)
`;
    const enabled = minify(source, { localDeclarationHoisting: false });
    const disabled = minify(source, {
      tableReadMerging: false,
      localDeclarationHoisting: false,
    });

    expect(Buffer.byteLength(enabled)).toBeLessThan(
      Buffer.byteLength(disabled),
    );
    expect(() => Parser.parse(enabled, { luaVersion: "5.3" })).not.toThrow();
  });

  test("field-sensitive mode crosses a different-key write", () => {
    const source = `
local tableValue={x=1}
local first=tableValue.x
tableValue.y=2
local second=tableValue.x
use(first,second)
`;
    const fieldSensitive = minify(source, { localDeclarationHoisting: false });
    const wholeTable = minify(source, {
      fieldSensitiveTableEffects: false,
      localDeclarationHoisting: false,
    });

    expect(Buffer.byteLength(fieldSensitive)).toBeLessThan(
      Buffer.byteLength(wholeTable),
    );
  });

  test("projects a known helper write onto only the affected field", () => {
    const source = `
--@storm keep
local function writeY(value) value.y=2 end
local tableValue={x=1}
local first=tableValue.x
writeY(tableValue)
local second=tableValue.x
use(first,second)
`;
    const fieldSensitive = minify(source, { localDeclarationHoisting: false });
    const wholeTable = minify(source, {
      fieldSensitiveTableEffects: false,
      localDeclarationHoisting: false,
    });

    expect(Buffer.byteLength(fieldSensitive)).toBeLessThan(
      Buffer.byteLength(wholeTable),
    );
  });

  test("does not treat a proven no-escape helper argument as an unknown escape", () => {
    const source = `
local function observe(value) return value.x end
local tableValue={x=1,y=2}
local first=tableValue.x
observe(tableValue)
local second=tableValue.y
use(first,second)
`;
    const enabled = minify(source, { localDeclarationHoisting: false });
    const disabled = minify(source, {
      tableReadMerging: false,
      localDeclarationHoisting: false,
    });
    expect(Buffer.byteLength(enabled)).toBeLessThan(
      Buffer.byteLength(disabled),
    );
  });

  test("merges reads through a stable local alias", () => {
    const source = `
local tableValue={x=1,y=2}
local alias=tableValue
local first=alias.x
tick()
local second=tableValue.y
use(first,second)
`;
    const enabled = minify(source, { localDeclarationHoisting: false });
    const disabled = minify(source, {
      tableReadMerging: false,
      localDeclarationHoisting: false,
    });

    expect(Buffer.byteLength(enabled)).toBeLessThan(
      Buffer.byteLength(disabled),
    );
  });

  test("merges reads from a proven fresh factory call", () => {
    const source = `
local function makeValue() return {x=1,y=2} end
local tableValue=makeValue()
local first=tableValue.x
tick()
local second=tableValue.y
use(first,second)
`;
    const enabled = minify(source, { localDeclarationHoisting: false });
    const disabled = minify(source, {
      tableReadMerging: false,
      localDeclarationHoisting: false,
    });

    expect(Buffer.byteLength(enabled)).toBeLessThan(
      Buffer.byteLength(disabled),
    );
    expect(() => Parser.parse(enabled, { luaVersion: "5.3" })).not.toThrow();
  });

  test("does not move reads for an escaped table", () => {
    const source = `
local tableValue={x=1,y=2}
local first=tableValue.x
consume(tableValue)
local second=tableValue.y
use(first,second)
`;
    expect(minify(source)).toBe(minify(source, { tableReadMerging: false }));
  });

  test("does not move reads when a closure publishes an alias", () => {
    const source = `
local tableValue={x=1,y=2}
local alias
local bind=function() alias=tableValue end
local mutate=function() alias.y=9 end
local first=tableValue.x
bind()
mutate()
local second=tableValue.y
use(first,second)
`;
    expect(minify(source)).toBe(minify(source, { tableReadMerging: false }));
  });

  test("does not move reads for a fresh table assigned to an upvalue", () => {
    const source = `
local tableValue
local function evil() tableValue.y=9 end
local function make()
  tableValue={x=1,y=2}
  local first=tableValue.x
  evil()
  local second=tableValue.y
  use(first,second)
end
make()
`;
    expect(minify(source)).toBe(minify(source, { tableReadMerging: false }));
  });

  test("master safe opt-out disables table read movement", () => {
    const source = `
local tableValue={x=1,y=2}
local first=tableValue.x
tick()
local second=tableValue.y
use(first,second)
`;
    expect(minify(source, { statementOptimizations: false })).toBe(
      minify(source, {
        tableReadMerging: false,
        localDeclarationHoisting: false,
      }),
    );
  });

  test("keeps the API default conservative for pure Lua", () => {
    const source = `
local tableValue={x=1,y=2}
local first=tableValue.x
tick()
local second=tableValue.y
use(first,second)
`;
    const apiDefault = minifyExact(source, {
      requireWrapper: false,
      localDeclarationHoisting: false,
    });
    const explicitLua = minifyExact(source, {
      requireWrapper: false,
      runtimeProfile: "lua53",
      localDeclarationHoisting: false,
    });
    const optedInLua = minifyExact(source, {
      requireWrapper: false,
      runtimeProfile: "lua53",
      allowIntrospectionChanges: true,
      localDeclarationHoisting: false,
    });

    expect(apiDefault).toBe(explicitLua);
    expect(Buffer.byteLength(optedInLua)).toBeLessThan(
      Buffer.byteLength(apiDefault),
    );
  });

  test("does not move a preserved comment across an intervening call", () => {
    const source = `
local tableValue={x=1,y=2}
local first=tableValue.x
tick()
--# second stays after tick
local second=tableValue.y
use(first,second)
`;
    const enabled = minify(source, { localDeclarationHoisting: false });
    const disabled = minify(source, {
      tableReadMerging: false,
      localDeclarationHoisting: false,
    });

    expect(enabled).toBe(disabled);
    expect(enabled.indexOf("tick()")).toBeLessThan(enabled.indexOf("--#"));
  });
});
