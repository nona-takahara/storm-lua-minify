import { RuntimeProfile } from "./runtimeEnvironment";

export const optimizationOptionDefinitions = [
  { key: "optimizations", name: "optimizations", defaultValue: undefined },
  {
    key: "identifierOptimizations",
    name: "identifier-optimizations",
    parent: "optimizations",
    defaultValue: undefined,
  },
  {
    key: "localRenaming",
    name: "local-renaming",
    parent: "identifierOptimizations",
    defaultValue: true,
  },
  {
    key: "localNameReuse",
    name: "local-name-reuse",
    parent: "identifierOptimizations",
    defaultValue: true,
  },
  {
    key: "globalRenaming",
    name: "global-renaming",
    parent: "identifierOptimizations",
    defaultValue: false,
  },
  {
    key: "fieldRenaming",
    name: "field-renaming",
    parent: "identifierOptimizations",
    defaultValue: true,
  },
  {
    key: "globalAliasing",
    name: "global-aliasing",
    parent: "identifierOptimizations",
    defaultValue: true,
  },
  {
    key: "statementOptimizations",
    name: "statement-optimizations",
    parent: "optimizations",
    defaultValue: undefined,
  },
  {
    key: "localDeclarationMerging",
    name: "local-declaration-merging",
    parent: "statementOptimizations",
    defaultValue: true,
  },
  {
    key: "localDeclarationHoisting",
    name: "local-declaration-hoisting",
    parent: "statementOptimizations",
    defaultValue: true,
  },
  {
    key: "tableReadMerging",
    name: "table-read-merging",
    parent: "statementOptimizations",
    defaultValue: true,
  },
  {
    key: "fieldSensitiveTableEffects",
    name: "field-sensitive-table-effects",
    parent: "statementOptimizations",
    defaultValue: true,
  },
  {
    key: "constantOptimizations",
    name: "constant-optimizations",
    parent: "optimizations",
    defaultValue: undefined,
  },
  {
    key: "constantExpressionEvaluation",
    name: "constant-expression-evaluation",
    parent: "constantOptimizations",
    defaultValue: false,
  },
  {
    key: "localConstantPropagation",
    name: "local-constant-propagation",
    parent: "constantOptimizations",
    defaultValue: false,
  },
  {
    key: "interproceduralConstantPropagation",
    name: "interprocedural-constant-propagation",
    parent: "constantOptimizations",
    defaultValue: false,
  },
  {
    key: "functionOptimizations",
    name: "function-optimizations",
    parent: "optimizations",
    defaultValue: undefined,
  },
  {
    key: "parameterPruning",
    name: "parameter-pruning",
    parent: "functionOptimizations",
    defaultValue: true,
  },
  {
    key: "functionInlining",
    name: "function-inlining",
    parent: "functionOptimizations",
    defaultValue: true,
  },
  {
    key: "functionSpecialization",
    name: "function-specialization",
    parent: "functionOptimizations",
    defaultValue: true,
  },
  {
    key: "objectOptimizations",
    name: "object-optimizations",
    parent: "optimizations",
    defaultValue: undefined,
  },
  {
    key: "fieldValuePropagation",
    name: "field-value-propagation",
    parent: "objectOptimizations",
    defaultValue: true,
  },
  {
    key: "deadCodeOptimizations",
    name: "dead-code-optimizations",
    parent: "optimizations",
    defaultValue: undefined,
  },
  {
    key: "unusedCodeRemoval",
    name: "unused-code-removal",
    parent: "deadCodeOptimizations",
    defaultValue: undefined,
  },
  {
    key: "unusedLocalRemoval",
    name: "unused-local-removal",
    parent: "unusedCodeRemoval",
    defaultValue: true,
  },
  {
    key: "unusedFunctionRemoval",
    name: "unused-function-removal",
    parent: "unusedCodeRemoval",
    defaultValue: true,
  },
  {
    key: "unusedFieldInitializerRemoval",
    name: "unused-field-initializer-removal",
    parent: "unusedCodeRemoval",
    defaultValue: true,
  },
  {
    key: "unusedExportRemoval",
    name: "unused-export-removal",
    parent: "deadCodeOptimizations",
    defaultValue: true,
  },
] as const;

export type OptimizationOptionKey =
  (typeof optimizationOptionDefinitions)[number]["key"];
export type OptimizationOverrides = Partial<
  Record<OptimizationOptionKey, boolean>
>;

type LeafDefinition = (typeof optimizationOptionDefinitions)[number] & {
  readonly defaultValue: boolean;
};

const definitionsByKey = new Map(
  optimizationOptionDefinitions.map((definition) => [
    definition.key,
    definition,
  ]),
);

export const optimizationLeafDefinitions = optimizationOptionDefinitions.filter(
  (definition): definition is LeafDefinition =>
    definition.defaultValue !== undefined,
);

export interface SemanticAssumptions {
  allowIntrospectionChanges?: boolean;
  allowObservableTableReadChanges?: boolean;
  assumeAnnotations?: boolean;
}

export interface MinifierMode
  extends OptimizationOverrides, SemanticAssumptions {
  requireWrapper?: boolean;
  runtimeProfile?: RuntimeProfile;
  requiredWhitespace?: " " | "\n";
  neverRenameGlobals?: ReadonlySet<string>;
  collectOptimizationDiagnostics?: boolean;
}

export type ResolvedMinifierMode = Omit<
  MinifierMode,
  OptimizationOptionKey | "requireWrapper" | "runtimeProfile"
> &
  Record<OptimizationOptionKey, boolean> & {
    requireWrapper: boolean;
    runtimeProfile: RuntimeProfile;
  };

export interface OptionLayers {
  readonly config?: Readonly<MinifierMode>;
  readonly cli?: Readonly<MinifierMode>;
  readonly defaults?: Readonly<Partial<MinifierMode>>;
}

function isOptionLayers(
  value: OptionLayers | Readonly<MinifierMode>,
): value is OptionLayers {
  return "config" in value || "cli" in value || "defaults" in value;
}

function valueFromLayer(
  key: OptimizationOptionKey,
  layer: Readonly<OptimizationOverrides>,
): boolean | undefined {
  let current: OptimizationOptionKey | undefined = key;
  while (current !== undefined) {
    const value = layer[current];
    if (value !== undefined) return value;
    const definition = definitionsByKey.get(current);
    current =
      definition && "parent" in definition ? definition.parent : undefined;
  }
  return undefined;
}

export function resolveMinifierMode(
  layers: OptionLayers | Readonly<MinifierMode>,
): ResolvedMinifierMode {
  const normalized: OptionLayers = isOptionLayers(layers)
    ? layers
    : { cli: layers };
  const defaults = normalized.defaults ?? {};
  const config = normalized.config ?? {};
  const cli = normalized.cli ?? {};
  const runtimeProfile =
    cli.runtimeProfile ??
    config.runtimeProfile ??
    defaults.runtimeProfile ??
    "lua53";
  const requireWrapper =
    cli.requireWrapper ??
    config.requireWrapper ??
    defaults.requireWrapper ??
    false;
  const resolved = {
    ...defaults,
    ...config,
    ...cli,
    requireWrapper,
    runtimeProfile,
  } as ResolvedMinifierMode;

  optimizationLeafDefinitions.forEach((definition) => {
    resolved[definition.key] =
      valueFromLayer(definition.key, cli) ??
      valueFromLayer(definition.key, config) ??
      valueFromLayer(definition.key, defaults) ??
      definition.defaultValue;
  });
  optimizationOptionDefinitions
    .filter((definition) => definition.defaultValue === undefined)
    .forEach((definition) => {
      resolved[definition.key] =
        valueFromLayer(definition.key, cli) ??
        valueFromLayer(definition.key, config) ??
        valueFromLayer(definition.key, defaults) ??
        false;
    });
  return resolved;
}

export function isOptimizationOptionKey(
  value: string,
): value is OptimizationOptionKey {
  return definitionsByKey.has(value as OptimizationOptionKey);
}
