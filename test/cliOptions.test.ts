import { describe, expect, test } from "vitest";
import { createCliProgram } from "../src/cliOptions";
import { parseConfiguration } from "../src/config";
import { MinifierMode, resolveMinifierMode } from "../src/options";

function optionsOf(...args: string[]): MinifierMode {
  const program = createCliProgram();
  program.exitOverride();
  program.parse(args, { from: "user" });
  return program.opts<MinifierMode>();
}

describe("v1 option hierarchy", () => {
  test("keeps omitted CLI switches sparse", () => {
    expect(optionsOf()).toEqual({});
  });

  test("supports positive and negative kebab-case leaf switches", () => {
    expect(optionsOf("--function-inlining")).toMatchObject({
      functionInlining: true,
    });
    expect(optionsOf("--no-function-inlining")).toMatchObject({
      functionInlining: false,
    });
  });

  test("keeps -m as the compatible require-wrapper switch", () => {
    expect(optionsOf("-m")).toMatchObject({ requireWrapper: true });
    expect(optionsOf("--no-require-wrapper")).toMatchObject({
      requireWrapper: false,
    });
    const legacyProgram = createCliProgram();
    legacyProgram.exitOverride();
    legacyProgram.configureOutput({ writeErr: () => undefined });
    expect(() =>
      legacyProgram.parse(["--module-like-lua"], { from: "user" }),
    ).toThrow();
  });

  test("supports explicit progress overrides without materializing a default", () => {
    expect(optionsOf()).not.toHaveProperty("progress");
    expect(optionsOf("--progress")).toMatchObject({ progress: true });
    expect(optionsOf("--no-progress")).toMatchObject({ progress: false });
  });

  test("collects repeated global exclusions without consuming input files", () => {
    const program = createCliProgram();
    program.parse(
      [
        "--never-rename-global",
        "onTick",
        "--never-rename-global",
        "onDraw",
        "main.lua",
      ],
      { from: "user" },
    );
    expect(program.opts()).toMatchObject({
      neverRenameGlobal: ["onTick", "onDraw"],
    });
    expect(program.args).toEqual(["main.lua"]);
  });

  test("keeps assumptions outside the optimization hierarchy", () => {
    const mode = resolveMinifierMode(optionsOf("--optimizations"));
    expect(mode.allowIntrospectionChanges).toBeUndefined();
    expect(mode.allowObservableTableReadChanges).toBeUndefined();
    expect(mode.assumeAnnotations).toBeUndefined();
    expect(mode.assumeClosedFieldNames).toBeUndefined();
  });

  test("keeps closed field names an explicit opt-in on the CLI and in a config file", () => {
    expect(
      resolveMinifierMode(optionsOf("--optimizations")).assumeClosedFieldNames,
    ).toBeUndefined();
    expect(optionsOf("--assume-closed-field-names")).toMatchObject({
      assumeClosedFieldNames: true,
    });
    expect(optionsOf("--no-assume-closed-field-names")).toMatchObject({
      assumeClosedFieldNames: false,
    });
    expect(
      parseConfiguration({ "assume-closed-field-names": true }).mode,
    ).toEqual({ assumeClosedFieldNames: true });
  });

  test("collects repeated protected field names and validates the config list", () => {
    const program = createCliProgram();
    program.parse(
      [
        "--never-rename-field",
        "ui_id",
        "--never-rename-field",
        "cheat",
        "main.lua",
      ],
      { from: "user" },
    );
    expect(program.opts()).toMatchObject({
      neverRenameField: ["ui_id", "cheat"],
    });
    expect(program.args).toEqual(["main.lua"]);
    expect(
      parseConfiguration({ "never-rename-fields": ["ui_id"] }).mode
        .neverRenameFields,
    ).toEqual(new Set(["ui_id"]));
    expect(() =>
      parseConfiguration({ "never-rename-fields": "ui_id" }),
    ).toThrow(/array of strings/);
  });

  test("keeps module interpretation outside the optimization hierarchy", () => {
    expect(resolveMinifierMode(optionsOf()).requireWrapper).toBe(false);
    const mode = resolveMinifierMode(optionsOf("-m", "--no-optimizations"));
    expect(mode.requireWrapper).toBe(true);
    expect(mode.functionInlining).toBe(false);
  });

  test("validates config names and values", () => {
    expect(() => parseConfiguration({ functionInlining: true })).toThrow(
      /unknown option/,
    );
    expect(() => parseConfiguration({ "function-inlining": "yes" })).toThrow(
      /must be boolean/,
    );
  });

  test("rejects an unknown runtime profile", () => {
    const program = createCliProgram();
    program.exitOverride();
    program.configureOutput({ writeErr: () => undefined });
    expect(() =>
      program.parse(["--runtime-profile", "unknown"], { from: "user" }),
    ).toThrow(/allowed choices/i);
  });
});
