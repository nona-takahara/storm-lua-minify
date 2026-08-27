import { describe, expect, test } from "vitest";
import {
  optimizationLeafDefinitions,
  OptimizationOverrides,
  resolveMinifierMode,
} from "../src/options";

describe("optimization option resolution decision table", () => {
  test.each(optimizationLeafDefinitions)(
    "$name uses its documented default when no layer selects it",
    (definition) => {
      expect(resolveMinifierMode({})[definition.key]).toBe(
        definition.defaultValue,
      );
    },
  );

  test.each(optimizationLeafDefinitions)(
    "$name overrides its parent in the same layer",
    (definition) => {
      const layer = {
        [definition.parent]: true,
        [definition.key]: false,
      } as OptimizationOverrides;

      expect(resolveMinifierMode(layer)[definition.key]).toBe(false);
    },
  );

  test.each(optimizationLeafDefinitions)(
    "$name follows source precedence before hierarchy depth",
    (definition) => {
      const config = {
        [definition.key]: false,
      } as OptimizationOverrides;
      const cli = {
        [definition.parent]: true,
      } as OptimizationOverrides;

      expect(resolveMinifierMode({ config, cli })[definition.key]).toBe(true);
      expect(
        resolveMinifierMode({ config: cli, cli: config })[definition.key],
      ).toBe(false);
    },
  );
});
