import { describe, expect, test } from "vitest";
import {
  minifyTemporaryLuaProject,
  minifyTemporaryLuaSource,
} from "./lib/minifierHarness";

const closed = {
  requireWrapper: true,
  runtimeProfile: "stormworks" as const,
  optimizations: false,
  fieldRenaming: true,
  globalAliasing: false,
  assumeClosedFieldNames: true,
  collectOptimizationDiagnostics: true,
};

function plan(source: string, extra: object = {}) {
  const result = minifyTemporaryLuaSource(source, { ...closed, ...extra });
  return {
    code: result.code,
    plan: result.minifier.wholeProgramFieldRenames,
    diagnostics: result.minifier.optimizationDiagnostics,
  };
}

describe("name-based field shortening (assume-closed-field-names)", () => {
  test("shortens a program-defined name at every syntax site and module", () => {
    const result = minifyTemporaryLuaProject(
      {
        "dep.lua": `
local M = {}
function M.long_function_name(value) return value + 1 end
function M:long_method_name() return self.long_data_field end
M.long_data_field = 3
return M`,
        "main.lua": `
local dep = require("dep")
local table_value = { long_data_field = 4 }
return dep.long_function_name(table_value.long_data_field) + dep:long_method_name()`,
      },
      closed,
    );
    for (const name of [
      "long_function_name",
      "long_method_name",
      "long_data_field",
    ])
      expect(result.code).not.toContain(name);
    expect(result.minifier.wholeProgramFieldRenames?.shortenedFields).toBe(3);
  });

  test("shortens fields reached through a parameter that object analysis cannot resolve", () => {
    const source = `
function onTick(unknown_holder)
  unknown_holder.long_resolved_by_name = 1
  return unknown_holder.long_resolved_by_name
end`;
    const defaultPlan = plan(source, { assumeClosedFieldNames: false });
    expect(defaultPlan.code).toContain("long_resolved_by_name");
    expect(plan(source).code).not.toContain("long_resolved_by_name");
  });

  test("leaves the identity planner in charge unless the assumption is on", () => {
    const source = `
local object = { long_identity_field = 1 }
return object.long_identity_field`;
    const withoutAssumption = plan(source, { assumeClosedFieldNames: false });
    expect(withoutAssumption.code).not.toContain("long_identity_field");
    expect(withoutAssumption.plan?.keyTransfers).toBe(0);
  });

  test("does nothing when field renaming is off", () => {
    const { code } = plan(
      `local t = { long_field_name = 1 } return t.long_field_name`,
      {
        fieldRenaming: false,
      },
    );
    expect(code).toContain("long_field_name");
  });

  test("keeps a name that is also used as a string", () => {
    const { code, diagnostics } = plan(`
local command_table = { long_command_name = function() return 1 end }
local requested = "long_command_name"
return command_table[requested]() + command_table.long_command_name()`);
    expect(code).toContain("long_command_name");
    expect(diagnostics).toContainEqual(
      expect.objectContaining({
        pass: "whole-program-field-rename",
        fieldName: "long_command_name",
        reason: "string-key",
        decision: "rejected",
      }),
    );
  });

  test("keeps a name that appears only as a string key", () => {
    const { code } = plan(`
local commands = {}
commands["long_only_string_key"] = function() return 1 end
return commands["long_only_string_key"]()`);
    expect(code).toContain("long_only_string_key");
  });

  test("keeps names read out of Stormworks API results, even when the program defines them", () => {
    const { code, diagnostics } = plan(`
local players = server.getPlayers()
local own = { long_player_name = 1 }
return players[1].long_player_name + own.long_player_name`);
    expect(code).toContain("long_player_name");
    expect(diagnostics).toContainEqual(
      expect.objectContaining({
        pass: "whole-program-field-rename",
        fieldName: "long_player_name",
        reason: "external-value",
        decision: "rejected",
      }),
    );
  });

  test("follows an external table through loop variables, locals, and arguments", () => {
    const { code } = plan(`
local function describe(entry) return entry.long_looped_field end
local total = 0
for _, item in ipairs(server.getVehicleComponents(1).components.signs) do
  total = total + describe(item)
end
local own = { long_looped_field = 2 }
return total + own.long_looped_field`);
    expect(code).toContain("long_looped_field");
  });

  test("keeps the identifier keys of a table that is indexed with a computed key", () => {
    const { code, diagnostics } = plan(`
local handlers = { long_handler_key = function() return 1 end }
local plain = { long_plain_field = 2 }
handlers.long_late_handler = function() return 3 end
local selected = handlers[server.getKey()]
return selected() + plain.long_plain_field`);
    expect(code).toContain("long_handler_key");
    expect(code).toContain("long_late_handler");
    expect(code).not.toContain("long_plain_field");
    expect(diagnostics).toContainEqual(
      expect.objectContaining({
        pass: "whole-program-field-rename",
        fieldName: "long_handler_key",
        reason: "dynamic-key",
      }),
    );
  });

  test("keeps keys of a nested lookup table reached through a field", () => {
    const { code } = plan(`
local config = { long_station_table = { long_station_code = 1 } }
local function find(name) return config.long_station_table[name] end
return find(server.getKey())`);
    expect(code).toContain("long_station_code");
  });

  test("keeps names of tables handed to the API", () => {
    const { code } = plan(`
local options = { long_popup_title = "x" }
server.setPopup(1, options)
server.setOther({ long_inline_option = 1 })
return options.long_popup_title`);
    expect(code).toContain("long_popup_title");
    expect(code).toContain("long_inline_option");
  });

  test("keeps keys written into g_savedata and annotated exports", () => {
    const { code } = plan(`
--@storm export
g_savedata = { long_saved_setting = 1 }
local function read() return g_savedata.long_saved_setting end
return read()`);
    expect(code).toContain("long_saved_setting");
  });

  test("protects only the annotated statement, not the whole function body", () => {
    const { code } = plan(`
--@storm export
function onTick()
  local state = { long_inner_state = 1 }
  return state.long_inner_state
end`);
    expect(code).not.toContain("long_inner_state");
  });

  test("keeps explicitly protected names", () => {
    const { code } = plan(
      `local t = { long_protected_name = 1, long_other_name = 2 } return t.long_protected_name + t.long_other_name`,
      { neverRenameFields: new Set(["long_protected_name"]) },
    );
    expect(code).toContain("long_protected_name");
    expect(code).not.toContain("long_other_name");
  });

  test("keeps library and metamethod spellings and names the program never defines", () => {
    const { code } = plan(`
local class = {}
class.__index = class
function class.insert(list, value) return value end
function class.format(value) return value end
local function read(holder) return holder.long_undefined_elsewhere end
return setmetatable({}, class), read`);
    expect(code).toContain("__index");
    expect(code).toContain("class.insert");
    expect(code).toContain("class.format");
    expect(code).toContain("long_undefined_elsewhere");
  });

  test("does not let one external argument taint every caller of a pass-through function", () => {
    const { code } = plan(`
local function create(target, prototype) return target end
local function wrap(value) return value end
local mine = create({ long_pass_through_field = 1 }, {})
local external = wrap(server.getStartTile())
return mine.long_pass_through_field + external.x`);
    expect(code).not.toContain("long_pass_through_field");
  });

  test("still follows an external value that a function returns unchanged", () => {
    const { code } = plan(`
local function wrap(value) return value end
local own = { long_wrapped_field = 1 }
local external = wrap(server.getStartTile())
return own.long_wrapped_field + external.long_wrapped_field`);
    expect(code).toContain("long_wrapped_field");
  });

  test("names the renamed field in diagnostics and is deterministic", () => {
    const source = `local t = { long_first = 1, long_second = 2 } return t.long_first + t.long_second`;
    const first = plan(source);
    const second = plan(source);
    expect(first.code).toBe(second.code);
    expect(first.plan?.diagnostics).toContainEqual(
      expect.objectContaining({
        field: "long_first",
        reason: "field-renamed",
        accepted: true,
      }),
    );
  });

  test("never picks a new name that another field or string already uses", () => {
    const { code } = plan(`
local t = { long_candidate = 1, a = 2, b = 3 }
local labels = { "c", "d" }
return t.long_candidate + t.a + t.b + #labels`);
    expect(code).toMatch(/\.e\b|\be=/);
    expect(code).not.toMatch(/\bc=1/);
  });
});
