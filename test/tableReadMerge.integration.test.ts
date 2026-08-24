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
    moduleLikeLua: false,
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
    const enabled = minify(source, { effectAwareLocalHoist: false });
    const disabled = minify(source, {
      effectAwareTableReads: false,
      effectAwareLocalHoist: false,
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
    const fieldSensitive = minify(source, { effectAwareLocalHoist: false });
    const wholeTable = minify(source, {
      fieldSensitiveTableEffects: false,
      effectAwareLocalHoist: false,
    });

    expect(Buffer.byteLength(fieldSensitive)).toBeLessThan(
      Buffer.byteLength(wholeTable),
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
    const enabled = minify(source, { effectAwareLocalHoist: false });
    const disabled = minify(source, {
      effectAwareTableReads: false,
      effectAwareLocalHoist: false,
    });

    expect(Buffer.byteLength(enabled)).toBeLessThan(
      Buffer.byteLength(disabled),
    );
  });

  test("does not move reads for an escaped table", () => {
    const source = `
local tableValue={x=1,y=2}
local first=tableValue.x
consume(tableValue)
local second=tableValue.y
use(first,second)
`;
    expect(minify(source)).toBe(
      minify(source, { effectAwareTableReads: false }),
    );
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
    expect(minify(source)).toBe(
      minify(source, { effectAwareTableReads: false }),
    );
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
    expect(minify(source)).toBe(
      minify(source, { effectAwareTableReads: false }),
    );
  });

  test("master safe opt-out disables table read movement", () => {
    const source = `
local tableValue={x=1,y=2}
local first=tableValue.x
tick()
local second=tableValue.y
use(first,second)
`;
    expect(minify(source, { effectAwareTransforms: false })).toBe(
      minify(source, {
        effectAwareTableReads: false,
        effectAwareLocalHoist: false,
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
      moduleLikeLua: false,
      effectAwareLocalHoist: false,
    });
    const explicitLua = minifyExact(source, {
      moduleLikeLua: false,
      runtimeProfile: "lua53",
      effectAwareLocalHoist: false,
    });
    const optedInLua = minifyExact(source, {
      moduleLikeLua: false,
      runtimeProfile: "lua53",
      allowLocalLifetimeChanges: true,
      effectAwareLocalHoist: false,
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
    const enabled = minify(source, { effectAwareLocalHoist: false });
    const disabled = minify(source, {
      effectAwareTableReads: false,
      effectAwareLocalHoist: false,
    });

    expect(enabled).toBe(disabled);
    expect(enabled.indexOf("tick()")).toBeLessThan(enabled.indexOf("--#"));
  });
});
