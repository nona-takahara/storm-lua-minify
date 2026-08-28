import Parser from "luaparse";
import { RESERVED_MODULE_FUNCTION_NAMES } from "./linker";
import { ResolveResult } from "./resolver";

export interface InsertGlobalAliasesOptions {
  /** Names already owned by global rename or protected by the public API contract. */
  readonly excludeNames: ReadonlySet<string>;
}

const ALIAS_TEMP_NAME_PREFIX = "__mergeAlias";
const aliasedOriginalNames = new WeakMap<Parser.Identifier, string>();

export function originalNameOf(
  identifier: Parser.Identifier,
): string | undefined {
  return aliasedOriginalNames.get(identifier);
}

function isWorthAliasing(name: string, referenceCount: number): boolean {
  const savingsPerReference = name.length - 1;
  const declarationCost = 8 + name.length;
  return referenceCount * savingsPerReference > declarationCost;
}

/** Inserts aliases for profitable read-only external globals before statement scheduling. */
export function insertGlobalAliases(
  chunk: Parser.Chunk,
  resolveResult: ResolveResult,
  options: InsertGlobalAliasesOptions,
): boolean {
  const newLocals: Parser.LocalStatement[] = [];
  let aliasCounter = 0;
  resolveResult.globals.forEach((binding) => {
    if (
      binding.writes.length > 0 ||
      options.excludeNames.has(binding.name) ||
      RESERVED_MODULE_FUNCTION_NAMES.has(binding.name) ||
      !isWorthAliasing(binding.name, binding.references.length)
    )
      return;
    const tempName = ALIAS_TEMP_NAME_PREFIX + String(aliasCounter++);
    binding.references.forEach((reference) => {
      aliasedOriginalNames.set(reference, reference.name);
      reference.name = tempName;
    });
    newLocals.push({
      type: "LocalStatement",
      variables: [{ type: "Identifier", name: tempName }],
      init: [{ type: "Identifier", name: binding.name }],
    });
  });
  if (newLocals.length > 0) chunk.body.unshift(...newLocals);
  return newLocals.length > 0;
}
