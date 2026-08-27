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

  test("lets a leaf override its groups within one source", () => {
    const mode = resolveMinifierMode(
      optionsOf(
        "--no-optimizations",
        "--function-optimizations",
        "--no-function-inlining",
      ),
    );
    expect(mode.parameterPruning).toBe(true);
    expect(mode.functionInlining).toBe(false);
    expect(mode.localRenaming).toBe(false);
    expect(mode.functionOptimizations).toBe(true);
  });

  test("lets a CLI group override config leaves", () => {
    const configuration = parseConfiguration({
      "parameter-pruning": false,
      "function-inlining": false,
    });
    const mode = resolveMinifierMode({
      config: configuration.mode,
      cli: optionsOf("--function-optimizations"),
    });
    expect(mode.parameterPruning).toBe(true);
    expect(mode.functionInlining).toBe(true);
  });

  test("lets a CLI leaf override a config group", () => {
    const configuration = parseConfiguration({
      "function-optimizations": false,
    });
    const mode = resolveMinifierMode({
      config: configuration.mode,
      cli: optionsOf("--function-inlining"),
    });
    expect(mode.parameterPruning).toBe(false);
    expect(mode.functionInlining).toBe(true);
  });

  test("keeps assumptions outside the optimization hierarchy", () => {
    const mode = resolveMinifierMode(optionsOf("--optimizations"));
    expect(mode.allowIntrospectionChanges).toBeUndefined();
    expect(mode.allowObservableTableReadChanges).toBeUndefined();
    expect(mode.assumeAnnotations).toBeUndefined();
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
