import { describe, expect, test } from "vitest";
import { createCliProgram } from "../src/cliOptions";

function optionsOf(...args: string[]): Record<string, unknown> {
  const program = createCliProgram();
  program.exitOverride();
  program.parse(args, { from: "user" });
  return program.opts<Record<string, unknown>>();
}

describe("effect-aware CLI options", () => {
  test("uses the Stormworks safe profile by default", () => {
    expect(optionsOf()).toMatchObject({
      runtimeProfile: "stormworks",
      effectAwareTransforms: true,
      effectAwareLocalHoist: true,
      effectAwareTableReads: true,
      fieldSensitiveTableEffects: true,
    });
  });

  test("keeps runtime profile and pure-Lua lifetime permission separate", () => {
    expect(
      optionsOf("--runtime-profile", "lua53", "--allow-local-lifetime-changes"),
    ).toMatchObject({
      runtimeProfile: "lua53",
      allowLocalLifetimeChanges: true,
    });
  });

  test("supports master and individual opt-outs", () => {
    expect(
      optionsOf(
        "--no-effect-aware-transforms",
        "--no-effect-aware-local-hoist",
        "--no-effect-aware-table-reads",
        "--no-field-sensitive-table-effects",
      ),
    ).toMatchObject({
      effectAwareTransforms: false,
      effectAwareLocalHoist: false,
      effectAwareTableReads: false,
      fieldSensitiveTableEffects: false,
    });
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
