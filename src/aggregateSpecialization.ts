import Parser from "luaparse";
import { walkStatement } from "./astWalk";
import { CallSite, Callable } from "./callGraph";
import { copyNodeOrigin } from "./generatedNode";
import { ResolveResult, Scope, Symbol } from "./resolver";
import { SourceMetadata } from "./sourceMetadata";
import { WholeProgramFieldAnalysis } from "./wholeProgramFields";
import {
  ResolvedMethodCall,
  WholeProgramObjectAnalysis,
} from "./wholeProgramObjects";

type PrimitiveLiteral =
  | Parser.StringLiteral
  | Parser.NumericLiteral
  | Parser.BooleanLiteral
  | Parser.NilLiteral;

export type SpecializationRefusalReason =
  | "function-escape"
  | "recursive-function"
  | "vararg-function"
  | "dynamic-dispatch"
  | "callback-reassignment"
  | "multiple-callback-storage"
  | "unknown-capture"
  | "unsupported-shape"
  | "resource-budget";

export interface AggregateSpecializationDiagnostic {
  readonly callable: Callable;
  readonly reason: "variant-created" | SpecializationRefusalReason;
  readonly count: number;
}

export interface AggregateSpecializationResult {
  readonly changed: boolean;
  readonly candidateCallables: number;
  readonly createdVariants: number;
  readonly replacedCalls: number;
  readonly diagnostics: readonly AggregateSpecializationDiagnostic[];
}

export interface AggregateSpecializationModule {
  readonly name: string;
  readonly chunk: Parser.Chunk;
  readonly resolved: ResolveResult;
  readonly metadata: SourceMetadata;
  readonly maxIntroducedLocalsAt: (statement: Parser.Statement) => number;
}

interface NormalizedSite {
  readonly site: CallSite;
  readonly callable: Callable;
  readonly module: AggregateSpecializationModule;
  readonly actuals: readonly Parser.Expression[];
  readonly parameterOffset: number;
}

interface VariantGroup {
  readonly key: string;
  readonly sites: NormalizedSite[];
  readonly literals: ReadonlyMap<number, PrimitiveLiteral>;
}

const MAX_VARIANTS = 128;
const MAX_CANDIDATE_SITES = 2048;

/**
 * Build one callable-oriented plan for direct, method, and stable-field calls.
 * Every site is normalized to the callee parameter order; method receiver and
 * callback base evaluation become explicit leading actuals before grouping.
 */
export function applyAggregateSpecialization(
  objects: WholeProgramObjectAnalysis,
  fields: WholeProgramFieldAnalysis,
  modules: readonly AggregateSpecializationModule[],
): AggregateSpecializationResult {
  if (objects.generation !== fields.generation)
    throw new Error("Cannot specialize mixed whole-program generations");
  const moduleOfCallable = new Map<Callable, AggregateSpecializationModule>();
  objects.modules.forEach((module) => {
    const target = modules.find((candidate) => candidate.name === module.name);
    if (!target) return;
    module.analysis.callGraph.functions.forEach((callable) =>
      moduleOfCallable.set(callable, target),
    );
  });
  const moduleOfNode = new WeakMap<object, AggregateSpecializationModule>();
  modules.forEach((module) => {
    indexNodes(module.chunk.body, module, moduleOfNode);
  });
  const methods = new Map<Parser.Expression, ResolvedMethodCall>(
    objects.resolvedMethods.map((method) => [method.call.call, method]),
  );
  const callbacks = new Map(
    fields.resolvedCallbacks.map((callback) => [callback.call.call, callback]),
  );
  const recursive = new Set(
    fields.callGraph.sccs
      .filter((scc) => scc.recursive)
      .flatMap((scc) => scc.functions),
  );
  const sitesByCallable = new Map<Callable, NormalizedSite[]>();
  fields.callGraph.calls.forEach((site) => {
    if (site.hasUnknownTarget || site.targets.size !== 1) return;
    const callable = [...site.targets][0];
    if (site.call.type !== "CallExpression") return;
    const module = moduleOfNode.get(site.owner);
    if (!module) return;
    const method = methods.get(site.call);
    const callback = callbacks.get(site.call);
    let actuals: readonly Parser.Expression[] = site.call.arguments;
    let parameterOffset = 0;
    if (method) actuals = [method.receiver, ...site.call.arguments];
    else if (callback && site.call.base.type === "MemberExpression") {
      // Preserve evaluation of the callback receiver before its arguments.
      actuals = [site.call.base.base, ...site.call.arguments];
      parameterOffset = 1;
    }
    const normalized = sitesByCallable.get(callable) ?? [];
    normalized.push({ site, callable, module, actuals, parameterOffset });
    sitesByCallable.set(callable, normalized);
  });
  const constantParameters = inferConstantParameters(sitesByCallable);

  const diagnostics: AggregateSpecializationDiagnostic[] = [];
  const unavailableNames = new Set(
    modules.flatMap((module) => [
      ...module.resolved.symbols.map((symbol) => symbol.name),
      ...module.resolved.globals.keys(),
    ]),
  );
  const callbackFields = new Map<Callable, Set<string>>();
  fields.facts.forEach((fact) => {
    if (fact.value?.kind !== "function") return;
    const stored = callbackFields.get(fact.value.callable) ?? new Set<string>();
    stored.add(fact.field);
    callbackFields.set(fact.value.callable, stored);
    if (fact.invalidationReasons.has("field-reassignment"))
      diagnostics.push({
        callable: fact.value.callable,
        reason: "callback-reassignment",
        count: 1,
      });
    else if (fact.invalidationReasons.size > 0)
      diagnostics.push({
        callable: fact.value.callable,
        reason: "dynamic-dispatch",
        count: 1,
      });
  });
  callbackFields.forEach((stored, callable) => {
    if (stored.size > 1)
      diagnostics.push({
        callable,
        reason: "multiple-callback-storage",
        count: stored.size,
      });
  });
  let candidateCallables = 0;
  let createdVariants = 0;
  let replacedCalls = 0;
  const introducedByBody = new Map<Parser.Statement[], number>();
  const totalSites = [...sitesByCallable.values()].reduce(
    (sum, sites) => sum + sites.length,
    0,
  );
  if (totalSites > MAX_CANDIDATE_SITES) {
    sitesByCallable.forEach((_, callable) =>
      diagnostics.push({ callable, reason: "resource-budget", count: 1 }),
    );
    return {
      changed: false,
      candidateCallables: sitesByCallable.size,
      createdVariants: 0,
      replacedCalls: 0,
      diagnostics,
    };
  }

  sitesByCallable.forEach((sites, callable) => {
    const ownerModule = moduleOfCallable.get(callable);
    if (!ownerModule || sites.length === 0) return;
    candidateCallables++;
    const refusal = refusalOf(callable, sites, ownerModule, recursive);
    if (refusal) {
      diagnostics.push({ callable, reason: refusal, count: 1 });
      return;
    }
    const groups = variantGroups(callable, sites, constantParameters);
    groups.forEach((group) => {
      if (createdVariants >= MAX_VARIANTS) {
        diagnostics.push({ callable, reason: "resource-budget", count: 1 });
        return;
      }
      const insertionModule = group.sites[0].module;
      if (group.sites.some((site) => site.module !== insertionModule)) return;
      const firstOwner = group.sites[0].site.owner;
      const insertionBody = bodyContaining(
        insertionModule.chunk.body,
        firstOwner,
      );
      if (
        !insertionBody ||
        group.sites.some(
          (site) =>
            bodyContaining(insertionModule.chunk.body, site.site.owner) !==
            insertionBody,
        )
      ) {
        diagnostics.push({ callable, reason: "unknown-capture", count: 1 });
        return;
      }
      const introduced = introducedByBody.get(insertionBody) ?? 0;
      if (introduced >= insertionModule.maxIntroducedLocalsAt(firstOwner)) {
        diagnostics.push({ callable, reason: "resource-budget", count: 1 });
        return;
      }
      let variantIndex = createdVariants;
      let variantName = `__stormVariant${String(variantIndex)}`;
      while (unavailableNames.has(variantName)) {
        variantIndex++;
        variantName = `__stormVariant${String(variantIndex)}`;
      }
      unavailableNames.add(variantName);
      const variant = makeVariant(callable, group, variantName, ownerModule);
      if (!variant) {
        diagnostics.push({ callable, reason: "unknown-capture", count: 1 });
        return;
      }
      insertionBody.splice(insertionBody.indexOf(firstOwner), 0, variant);
      introducedByBody.set(insertionBody, introduced + 1);
      group.sites.forEach((normalized) => {
        const call = normalized.site.call;
        if (call.type !== "CallExpression") return;
        const retainedActuals = normalized.actuals.filter((_, index) => {
          const parameterIndex = index - normalized.parameterOffset;
          return parameterIndex < 0 || !group.literals.has(parameterIndex);
        });
        const replacement: Parser.Identifier = {
          type: "Identifier",
          name: variantName,
        };
        copyNodeOrigin(replacement, call.base);
        call.base = replacement;
        call.arguments = retainedActuals.map((actual) =>
          structuredClone(actual),
        );
        replacedCalls++;
      });
      createdVariants++;
      diagnostics.push({
        callable,
        reason: "variant-created",
        count: group.sites.length,
      });
    });
  });
  return {
    changed: createdVariants > 0,
    candidateCallables,
    createdVariants,
    replacedCalls,
    diagnostics,
  };
}

function refusalOf(
  callable: Callable,
  sites: readonly NormalizedSite[],
  ownerModule: AggregateSpecializationModule,
  recursive: ReadonlySet<Callable>,
): SpecializationRefusalReason | undefined {
  if (recursive.has(callable)) return "recursive-function";
  if (
    callable.declaration.parameters.some(
      (parameter) => parameter.type === "VarargLiteral",
    )
  )
    return "vararg-function";
  if (callable.declaration.parameters.length === 0) return "unsupported-shape";
  const annotations = ownerModule.metadata.annotationsOf(callable.declaration);
  if (annotations.keep || annotations.exported) return "unsupported-shape";
  if (!captureSafe(callable, sites, ownerModule)) return "unknown-capture";
  return undefined;
}

function captureSafe(
  callable: Callable,
  sites: readonly NormalizedSite[],
  ownerModule: AggregateSpecializationModule,
): boolean {
  const resolved = ownerModule.resolved;
  const functionScope = resolved.scopeOfFunction(callable.declaration);
  if (!functionScope) return false;
  const state = { safe: true, captures: false };
  callable.declaration.body.forEach((statement) => {
    walkStatement(statement, {
      onIdentifierReference: (identifier) => {
        const symbol = resolved.symbolOf(identifier);
        if (symbol && !insideScope(symbol, functionScope))
          state.captures = true;
      },
      onFunction: () => {
        state.safe = false;
      },
    });
  });
  return (
    state.safe &&
    (!state.captures || sites.every((site) => site.module === ownerModule))
  );
}

function insideScope(symbol: Symbol, scope: Scope): boolean {
  for (
    let current: Scope | null = symbol.scope;
    current;
    current = current.parent
  )
    if (current === scope) return true;
  return false;
}

function variantGroups(
  callable: Callable,
  sites: readonly NormalizedSite[],
  constantParameters: ReadonlyMap<Symbol, PrimitiveLiteral>,
): VariantGroup[] {
  const candidates = new Map<
    string,
    {
      parameterIndex: number;
      literal: PrimitiveLiteral;
      sites: NormalizedSite[];
      derived: boolean;
    }
  >();
  sites.forEach((site) => {
    callable.declaration.parameters.forEach((_, parameterIndex) => {
      const actual = site.actuals.at(parameterIndex + site.parameterOffset);
      const direct = primitiveLiteral(actual);
      const actualSymbol =
        !direct && actual?.type === "Identifier"
          ? site.module.resolved.symbolOf(actual)
          : undefined;
      const literal =
        direct ??
        (actualSymbol ? constantParameters.get(actualSymbol) : undefined);
      if (!literal) return;
      const key = `${String(parameterIndex)}:${literalKey(literal)}`;
      const candidate = candidates.get(key) ?? {
        parameterIndex,
        literal,
        sites: [],
        derived: direct === undefined,
      };
      candidate.sites.push(site);
      if (!direct) candidate.derived = true;
      candidates.set(key, candidate);
    });
  });
  const assigned = new Set<NormalizedSite>();
  return [...candidates.entries()]
    .filter(([, candidate]) => candidate.sites.length >= 2 || candidate.derived)
    .sort(
      ([leftKey, left], [rightKey, right]) =>
        right.sites.length - left.sites.length ||
        left.parameterIndex - right.parameterIndex ||
        leftKey.localeCompare(rightKey),
    )
    .flatMap(([key, candidate]) => {
      const grouped = candidate.sites.filter((site) => !assigned.has(site));
      if (grouped.length < 2 && !candidate.derived) return [];
      grouped.forEach((site) => assigned.add(site));
      return [
        {
          key,
          sites: grouped,
          literals: new Map([[candidate.parameterIndex, candidate.literal]]),
        },
      ];
    });
}

function inferConstantParameters(
  sitesByCallable: ReadonlyMap<Callable, readonly NormalizedSite[]>,
): ReadonlyMap<Symbol, PrimitiveLiteral> {
  const result = new Map<Symbol, PrimitiveLiteral>();
  let changed = true;
  while (changed) {
    changed = false;
    sitesByCallable.forEach((sites, callable) => {
      callable.parameters.forEach((parameter, parameterIndex) => {
        if (result.has(parameter) || sites.length === 0) return;
        const values = sites.map((site) => {
          const actual = site.actuals.at(parameterIndex + site.parameterOffset);
          const direct = primitiveLiteral(actual);
          if (direct) return direct;
          if (!actual || actual.type !== "Identifier") return undefined;
          const symbol = site.module.resolved.symbolOf(actual);
          return symbol ? result.get(symbol) : undefined;
        });
        const first = values[0];
        if (
          !first ||
          values.some(
            (value) => !value || literalKey(value) !== literalKey(first),
          )
        )
          return;
        result.set(parameter, first);
        changed = true;
      });
    });
  }
  return result;
}

function makeVariant(
  callable: Callable,
  group: VariantGroup,
  name: string,
  ownerModule: AggregateSpecializationModule,
): Parser.FunctionDeclaration | undefined {
  const declaration = callable.declaration;
  if (
    declaration.parameters.some((parameter) => parameter.type !== "Identifier")
  )
    return undefined;
  const copiedBody = declaration.body.map((statement) =>
    structuredClone(statement),
  );
  replaceParameterReferences(
    declaration.body,
    copiedBody,
    ownerModule.resolved,
    new Map(
      [...group.literals].map(
        ([index, literal]) => [callable.parameters[index], literal] as const,
      ),
    ),
  );
  const parameters = declaration.parameters
    .filter((_, index) => !group.literals.has(index))
    .map((parameter) => structuredClone(parameter as Parser.Identifier));
  if (group.sites[0].parameterOffset > 0)
    parameters.unshift({ type: "Identifier", name: "__stormReceiver" });
  const identifier: Parser.Identifier = { type: "Identifier", name };
  copyNodeOrigin(identifier, declaration.identifier ?? declaration);
  const variant: Parser.FunctionDeclaration = {
    type: "FunctionDeclaration",
    identifier,
    isLocal: true,
    parameters,
    body: copiedBody,
  };
  copyNodeOrigin(variant, declaration);
  return variant;
}

function replaceParameterReferences(
  originals: readonly unknown[],
  copies: readonly unknown[],
  resolved: ResolveResult,
  literals: ReadonlyMap<Symbol, PrimitiveLiteral>,
): void {
  const visit = (original: unknown, copy: unknown): void => {
    if (
      !original ||
      !copy ||
      typeof original !== "object" ||
      typeof copy !== "object"
    )
      return;
    if (Array.isArray(original)) {
      if (!Array.isArray(copy)) return;
      original.forEach((item, index) => {
        visit(item, copy[index]);
      });
      return;
    }
    if ((original as Parser.Node).type === "Identifier") {
      const symbol = resolved.symbolOf(original as Parser.Identifier);
      const literal = symbol ? literals.get(symbol) : undefined;
      if (literal) Object.assign(copy, structuredClone(literal));
      return;
    }
    Object.keys(original).forEach((key) => {
      visit(
        (original as Record<string, unknown>)[key],
        (copy as Record<string, unknown>)[key],
      );
    });
  };
  visit(originals, copies);
}

function primitiveLiteral(
  expression: Parser.Expression | undefined,
): PrimitiveLiteral | undefined {
  if (!expression) return { type: "NilLiteral", value: null, raw: "nil" };
  switch (expression.type) {
    case "StringLiteral":
    case "NumericLiteral":
    case "BooleanLiteral":
    case "NilLiteral":
      return expression;
    default:
      return undefined;
  }
}

function literalKey(literal: PrimitiveLiteral): string {
  return `${literal.type}:${literal.raw}`;
}

function indexNodes(
  body: readonly Parser.Statement[],
  module: AggregateSpecializationModule,
  index: WeakMap<object, AggregateSpecializationModule>,
): void {
  const visit = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    index.set(value, module);
    if (Array.isArray(value)) value.forEach(visit);
    else Object.values(value).forEach(visit);
  };
  visit(body);
}

function bodyContaining(
  body: Parser.Statement[],
  owner: Parser.Statement,
): Parser.Statement[] | undefined {
  if (body.includes(owner)) return body;
  for (const statement of body)
    for (const child of childBlocks(statement)) {
      const found = bodyContaining(child, owner);
      if (found) return found;
    }
  return undefined;
}

function childBlocks(statement: Parser.Statement): Parser.Statement[][] {
  switch (statement.type) {
    case "DoStatement":
    case "WhileStatement":
    case "RepeatStatement":
    case "FunctionDeclaration":
    case "ForNumericStatement":
    case "ForGenericStatement":
      return [statement.body];
    case "IfStatement":
      return statement.clauses.map((clause) => clause.body);
    default:
      return [];
  }
}
