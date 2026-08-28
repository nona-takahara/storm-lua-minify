import fs from "fs";
import {
  MinifierMode,
  OptimizationOptionKey,
  optimizationOptionDefinitions,
} from "./options";
import { SourceMappingUrlStyle } from "./output";

export interface FileConfiguration {
  readonly mode: MinifierMode;
  readonly sourceMappingUrlStyle?: SourceMappingUrlStyle;
}

const booleanKeys = new Map<string, keyof MinifierMode>([
  ...optimizationOptionDefinitions.map(
    (definition) =>
      [definition.name, definition.key] as [string, OptimizationOptionKey],
  ),
  ["require-wrapper", "requireWrapper"],
  ["allow-introspection-changes", "allowIntrospectionChanges"],
  ["allow-observable-table-read-changes", "allowObservableTableReadChanges"],
  ["assume-annotations", "assumeAnnotations"],
  ["collect-optimization-diagnostics", "collectOptimizationDiagnostics"],
]);

const nonBooleanKeys = new Set([
  "runtime-profile",
  "required-whitespace",
  "never-rename-globals",
  "source-mapping-url-style",
]);

function objectOf(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${path} must contain a JSON object`);
  }
  return value as Record<string, unknown>;
}

export function parseConfiguration(
  value: unknown,
  path = "configuration",
): FileConfiguration {
  const input = objectOf(value, path);
  const mode: MinifierMode = {};
  let sourceMappingUrlStyle: SourceMappingUrlStyle | undefined;

  Object.entries(input).forEach(([externalName, rawValue]) => {
    const booleanKey = booleanKeys.get(externalName);
    if (booleanKey !== undefined) {
      if (typeof rawValue !== "boolean")
        throw new Error(`${path}: ${externalName} must be boolean`);
      (mode as Record<string, unknown>)[booleanKey] = rawValue;
      return;
    }
    if (!nonBooleanKeys.has(externalName))
      throw new Error(`${path}: unknown option ${externalName}`);

    if (externalName === "runtime-profile") {
      if (rawValue !== "stormworks" && rawValue !== "lua53")
        throw new Error(`${path}: runtime-profile must be stormworks or lua53`);
      mode.runtimeProfile = rawValue;
      return;
    }
    if (externalName === "required-whitespace") {
      if (rawValue !== "space" && rawValue !== "lf")
        throw new Error(`${path}: required-whitespace must be space or LF`);
      mode.requiredWhitespace = rawValue === "space" ? " " : "\n";
      return;
    }
    if (externalName === "never-rename-globals") {
      if (
        !Array.isArray(rawValue) ||
        !rawValue.every((name) => typeof name === "string")
      )
        throw new Error(
          `${path}: never-rename-globals must be an array of strings`,
        );
      mode.neverRenameGlobals = new Set(rawValue);
      return;
    }
    if (rawValue !== "legacy" && rawValue !== "line" && rawValue !== "strict")
      throw new Error(
        `${path}: source-mapping-url-style must be legacy, line, or strict`,
      );
    sourceMappingUrlStyle = rawValue;
  });
  return { mode, sourceMappingUrlStyle };
}

export function loadConfiguration(path: string): FileConfiguration {
  if (!fs.existsSync(path))
    throw new Error(`Configuration file not found: ${path}`);
  return parseConfiguration(JSON.parse(fs.readFileSync(path, "utf8")), path);
}
