import Parser from "luaparse";
import { GlobalBinding, ResolveResult, Scope, Symbol } from "./resolver";
import { RuntimeEnvironment } from "./runtimeEnvironment";
import {
  decodeLuaStringLiteral,
  luaByteStringKey,
  luaByteStringOfText,
} from "./luaString";

export type FactEvidence =
  | { readonly kind: "language"; readonly reason: string }
  | {
      readonly kind: "runtime";
      readonly profile: RuntimeEnvironment["profile"];
      readonly reason: string;
    }
  | {
      readonly kind: "assumption";
      readonly name: string;
      readonly reason: string;
    };

export interface EffectClaim {
  readonly value: "no" | "may";
  readonly evidence: FactEvidence;
}

export interface ExpressionEffects {
  readonly mayError: EffectClaim;
  readonly mayInvokeMetamethod: EffectClaim;
}

export type ValueCardinality =
  | { readonly kind: "single" }
  | {
      readonly kind: "tuple";
      readonly knownPrefixLength: number;
      readonly tail: "none" | "unknown";
    }
  | { readonly kind: "unknown"; readonly reason: string };

export type Location =
  | { readonly kind: "local"; readonly symbol: Symbol }
  | { readonly kind: "parameter"; readonly symbol: Symbol }
  | { readonly kind: "upvalue"; readonly symbol: Symbol }
  | { readonly kind: "global"; readonly binding: GlobalBinding }
  | {
      readonly kind: "table";
      readonly base: Parser.Expression;
      readonly key:
        | { readonly kind: "static"; readonly value: string }
        | { readonly kind: "dynamic" };
    }
  | { readonly kind: "external"; readonly reason: string };

export interface ExpressionFact {
  readonly expression: Parser.Expression;
  readonly value: OptimizerValue;
  readonly cardinality: ValueCardinality;
  readonly effects: ExpressionEffects;
}

export type OptimizerValue =
  | { readonly kind: "nil" }
  | { readonly kind: "boolean"; readonly value: boolean }
  | { readonly kind: "number"; readonly raw: string }
  | { readonly kind: "string"; readonly raw: string }
  | {
      readonly kind: "allocation";
      readonly allocationKind: "table" | "function";
      readonly origin: Parser.Expression;
    }
  | { readonly kind: "external"; readonly reason: string }
  | { readonly kind: "unknown"; readonly reason: string };

export type ValueSlotSource =
  | { readonly kind: "expression"; readonly expression: Parser.Expression }
  | {
      readonly kind: "tail-expansion";
      readonly expression: Parser.Expression;
      readonly offset: number;
    }
  | { readonly kind: "nil-padding" };

export interface ValueSlotFact {
  readonly index: number;
  readonly source: ValueSlotSource;
}

export interface EvaluationPosition {
  /** Deterministic traversal group, not a claim that Lua sequences sibling expressions. */
  readonly group: number;
  readonly ordering: "sequenced" | "unordered";
}

interface OperationBase {
  readonly id: number;
  readonly owner: Parser.Statement;
  readonly origin: Parser.Node;
  /** Stable source correspondence; generated nodes may legitimately omit it. */
  readonly sourceRange?: readonly [number, number];
  readonly position: EvaluationPosition;
}

export type OptimizerOperation =
  | (OperationBase & { readonly kind: "declare"; readonly location: Location })
  | (OperationBase & {
      readonly kind: "read" | "write";
      readonly location: Location;
    })
  | (OperationBase & {
      readonly kind: "call";
      readonly call:
        | Parser.CallExpression
        | Parser.TableCallExpression
        | Parser.StringCallExpression;
      readonly target: Location | { readonly kind: "unknown" };
    })
  | (OperationBase & {
      readonly kind: "allocate";
      readonly allocationKind: "table" | "function";
    })
  | (OperationBase & {
      readonly kind: "table-read" | "table-write";
      readonly location: Extract<Location, { kind: "table" }>;
    });

type OperationInput = OptimizerOperation extends infer Operation
  ? Operation extends OptimizerOperation
    ? Omit<Operation, "id">
    : never
  : never;

export interface OptimizerFacts {
  readonly generation: number;
  readonly policy: {
    readonly runtime?: RuntimeEnvironment;
    readonly assumptions: ReadonlyMap<string, string>;
  };
  readonly operations: readonly OptimizerOperation[];
  readonly unknowns: readonly OptimizerUnknownFact[];
  operationsOf(owner: Parser.Node): readonly OptimizerOperation[];
  operationsWithin(owner: Parser.Statement): readonly OptimizerOperation[];
  operationOf(origin: Parser.Node): OptimizerOperation | undefined;
  operationsOfSymbol(symbol: Symbol): readonly OptimizerOperation[];
  expressionFact(expression: Parser.Expression): ExpressionFact | undefined;
  valueSlotsOf(owner: Parser.Statement): readonly ValueSlotFact[];
  discardabilityOf(
    expression: Parser.Expression,
  ):
    | { readonly discardable: true; readonly evidence: FactEvidence }
    | { readonly discardable: false; readonly reason: string };
}

export interface OptimizerUnknownFact {
  readonly origin: Parser.Node;
  readonly domain: "location" | "value" | "cardinality";
  readonly reason: string;
}

export interface OptimizerFactOptions {
  readonly generation?: number;
  readonly runtime?: RuntimeEnvironment;
  /** Assumptions remain provenance, and never masquerade as language/runtime facts. */
  readonly assumptions?: ReadonlyMap<string, string>;
}

/** Stable cache identity used by PassOrchestrator for language-level facts. */
export const OPTIMIZER_FACTS_CACHE_KEY = {};

export function analyzeOptimizerFactsAtGeneration(
  chunk: Parser.Chunk,
  resolved: ResolveResult,
  generation: number,
): OptimizerFacts {
  return analyzeOptimizerFacts(chunk, resolved, { generation });
}

const LANGUAGE_NO_EFFECT: ExpressionEffects = {
  mayError: {
    value: "no",
    evidence: { kind: "language", reason: "literal-or-function-construction" },
  },
  mayInvokeMetamethod: {
    value: "no",
    evidence: { kind: "language", reason: "literal-or-function-construction" },
  },
};

const LANGUAGE_MAY_EFFECT: ExpressionEffects = {
  mayError: {
    value: "may",
    evidence: { kind: "language", reason: "operation-may-raise" },
  },
  mayInvokeMetamethod: {
    value: "may",
    evidence: { kind: "language", reason: "operation-may-dispatch-metamethod" },
  },
};

/** Collects syntax-level optimizer facts. It deliberately performs no CFG or interprocedural inference. */
export function analyzeOptimizerFacts(
  chunk: Parser.Chunk,
  resolved: ResolveResult,
  options: OptimizerFactOptions = {},
): OptimizerFacts {
  const operations: OptimizerOperation[] = [];
  const unknowns: OptimizerUnknownFact[] = [];
  const byOwner = new WeakMap<Parser.Node, OptimizerOperation[]>();
  const withinOwner = new WeakMap<Parser.Statement, OptimizerOperation[]>();
  const byOrigin = new WeakMap<Parser.Node, OptimizerOperation>();
  const bySymbol = new Map<Symbol, OptimizerOperation[]>();
  const expressionFacts = new WeakMap<Parser.Expression, ExpressionFact>();
  const valueSlots = new WeakMap<Parser.Statement, readonly ValueSlotFact[]>();
  let nextOperationId = 0;
  let nextGroupId = 0;

  const conservativeEffects = (): ExpressionEffects => ({
    mayError: LANGUAGE_MAY_EFFECT.mayError,
    mayInvokeMetamethod:
      options.runtime?.semantics.mutableMetatables === false
        ? {
            value: "no",
            evidence: {
              kind: "runtime",
              profile: options.runtime.profile,
              reason: "runtime-has-no-mutable-metatables",
            },
          }
        : LANGUAGE_MAY_EFFECT.mayInvokeMetamethod,
  });

  const record = (operation: OperationInput): void => {
    const sourceRange = (operation.origin as { range?: [number, number] })
      .range;
    const complete = {
      ...operation,
      ...(sourceRange ? { sourceRange } : {}),
      id: nextOperationId++,
    } as OptimizerOperation;
    operations.push(complete);
    if ("location" in complete && complete.location.kind === "external") {
      unknowns.push({
        origin: complete.origin,
        domain: "location",
        reason: complete.location.reason,
      });
    }
    byOrigin.set(complete.origin, complete);
    const owned = byOwner.get(complete.owner) ?? [];
    owned.push(complete);
    byOwner.set(complete.owner, owned);
    if (
      "location" in complete &&
      (complete.location.kind === "local" ||
        complete.location.kind === "parameter" ||
        complete.location.kind === "upvalue")
    ) {
      const symbolOperations = bySymbol.get(complete.location.symbol) ?? [];
      symbolOperations.push(complete);
      bySymbol.set(complete.location.symbol, symbolOperations);
    }
  };

  function nearestFunctionScope(scope: Scope): Scope | undefined {
    for (let current: Scope | null = scope; current; current = current.parent) {
      if (current.kind === "function") return current;
    }
    return undefined;
  }

  function bindingLocation(
    identifier: Parser.Identifier,
    currentFunction: Scope | undefined,
  ): Location {
    const symbol = resolved.symbolOf(identifier);
    if (symbol) {
      if (nearestFunctionScope(symbol.scope) !== currentFunction)
        return { kind: "upvalue", symbol };
      if (symbol.kind === "param") return { kind: "parameter", symbol };
      return { kind: "local", symbol };
    }
    if (resolved.isGlobalReference(identifier)) {
      const binding = resolved.globals.get(identifier.name);
      if (binding) return { kind: "global", binding };
    }
    return { kind: "external", reason: "unresolved-identifier" };
  }

  function tableLocation(
    expression: Parser.MemberExpression | Parser.IndexExpression,
  ): Extract<Location, { kind: "table" }> {
    let key: Extract<Location, { kind: "table" }>["key"] = { kind: "dynamic" };
    if (expression.type === "MemberExpression") {
      key = {
        kind: "static",
        value: luaByteStringKey(
          luaByteStringOfText(expression.identifier.name),
        ),
      };
    } else if (expression.index.type === "StringLiteral") {
      const decoded = decodeLuaStringLiteral(expression.index);
      if (decoded.ok)
        key = { kind: "static", value: luaByteStringKey(decoded.value) };
    }
    return { kind: "table", base: expression.base, key };
  }

  function effectsOf(expression: Parser.Expression): ExpressionEffects {
    switch (expression.type) {
      case "NilLiteral":
      case "BooleanLiteral":
      case "NumericLiteral":
      case "StringLiteral":
      case "VarargLiteral":
      case "Identifier":
      case "FunctionDeclaration":
        return LANGUAGE_NO_EFFECT;
      case "TableConstructorExpression":
        return mergeEffects(
          expression.fields.flatMap((field) => [
            ...(field.type === "TableKey" ? [field.key] : []),
            field.value,
          ]),
        );
      case "UnaryExpression":
        return expression.operator === "-" &&
          expression.argument.type === "NumericLiteral"
          ? LANGUAGE_NO_EFFECT
          : conservativeEffects();
      default:
        return conservativeEffects();
    }
  }

  function mergeEffects(
    expressions: readonly Parser.Expression[],
  ): ExpressionEffects {
    const effects = expressions.map(effectsOf);
    return {
      mayError:
        effects.find((effect) => effect.mayError.value === "may")?.mayError ??
        LANGUAGE_NO_EFFECT.mayError,
      mayInvokeMetamethod:
        effects.find((effect) => effect.mayInvokeMetamethod.value === "may")
          ?.mayInvokeMetamethod ?? LANGUAGE_NO_EFFECT.mayInvokeMetamethod,
    };
  }

  function cardinalityOf(expression: Parser.Expression): ValueCardinality {
    switch (expression.type) {
      case "CallExpression":
      case "TableCallExpression":
      case "StringCallExpression":
      case "VarargLiteral":
        return { kind: "tuple", knownPrefixLength: 0, tail: "unknown" };
      default:
        return { kind: "single" };
    }
  }

  function valueOf(expression: Parser.Expression): OptimizerValue {
    switch (expression.type) {
      case "NilLiteral":
        return { kind: "nil" };
      case "BooleanLiteral":
        return { kind: "boolean", value: expression.value };
      case "NumericLiteral":
        return { kind: "number", raw: expression.raw };
      case "StringLiteral":
        return { kind: "string", raw: expression.raw };
      case "TableConstructorExpression":
        return {
          kind: "allocation",
          allocationKind: "table",
          origin: expression,
        };
      case "FunctionDeclaration":
        return {
          kind: "allocation",
          allocationKind: "function",
          origin: expression,
        };
      case "Identifier":
        return bindingLocation(expression, undefined).kind === "global"
          ? { kind: "external", reason: "global-binding" }
          : { kind: "unknown", reason: "binding-value-requires-flow" };
      case "CallExpression":
      case "TableCallExpression":
      case "StringCallExpression":
        return { kind: "unknown", reason: "call-result" };
      case "VarargLiteral":
        return { kind: "unknown", reason: "vararg-value" };
      default:
        return { kind: "unknown", reason: "computed-expression" };
    }
  }

  function recordValueSlots(
    owner: Parser.Statement,
    expressions: readonly Parser.Expression[],
    targetCount: number,
  ): void {
    const slots: ValueSlotFact[] = [];
    const last = expressions.at(-1);
    const lastExpands =
      last !== undefined && cardinalityOf(last).kind === "tuple";
    for (let index = 0; index < targetCount; index++) {
      if (
        index < expressions.length - 1 ||
        (index < expressions.length && !lastExpands)
      ) {
        slots.push({
          index,
          source: { kind: "expression", expression: expressions[index] },
        });
      } else if (last && lastExpands && index >= expressions.length - 1) {
        slots.push({
          index,
          source: {
            kind: "tail-expansion",
            expression: last,
            offset: index - (expressions.length - 1),
          },
        });
      } else {
        slots.push({ index, source: { kind: "nil-padding" } });
      }
    }
    valueSlots.set(owner, slots);
  }

  function visitExpression(
    expression: Parser.Expression,
    owner: Parser.Statement,
    currentFunction: Scope | undefined,
    group: number,
  ): void {
    const value = valueOf(expression);
    const cardinality = cardinalityOf(expression);
    expressionFacts.set(expression, {
      expression,
      value,
      cardinality,
      effects: effectsOf(expression),
    });
    if (value.kind === "unknown") {
      unknowns.push({
        origin: expression,
        domain: "value",
        reason: value.reason,
      });
    }
    if (cardinality.kind === "unknown") {
      unknowns.push({
        origin: expression,
        domain: "cardinality",
        reason: cardinality.reason,
      });
    }
    const position: EvaluationPosition = { group, ordering: "unordered" };
    switch (expression.type) {
      case "Identifier":
        record({
          kind: "read",
          location: bindingLocation(expression, currentFunction),
          owner,
          origin: expression,
          position,
        });
        return;
      case "NilLiteral":
      case "BooleanLiteral":
      case "NumericLiteral":
      case "StringLiteral":
      case "VarargLiteral":
        return;
      case "UnaryExpression":
        visitExpression(expression.argument, owner, currentFunction, group);
        return;
      case "BinaryExpression":
      case "LogicalExpression":
        visitExpression(expression.left, owner, currentFunction, group);
        visitExpression(expression.right, owner, currentFunction, group);
        return;
      case "TableConstructorExpression":
        record({
          kind: "allocate",
          allocationKind: "table",
          owner,
          origin: expression,
          position,
        });
        expression.fields.forEach((field) => {
          if (field.type === "TableKey")
            visitExpression(field.key, owner, currentFunction, group);
          visitExpression(field.value, owner, currentFunction, group);
        });
        return;
      case "FunctionDeclaration":
        record({
          kind: "allocate",
          allocationKind: "function",
          owner,
          origin: expression,
          position,
        });
        visitFunction(expression);
        return;
      case "MemberExpression":
      case "IndexExpression": {
        visitExpression(expression.base, owner, currentFunction, group);
        if (expression.type === "IndexExpression")
          visitExpression(expression.index, owner, currentFunction, group);
        record({
          kind: "table-read",
          location: tableLocation(expression),
          owner,
          origin: expression,
          position,
        });
        return;
      }
      case "CallExpression":
      case "TableCallExpression":
      case "StringCallExpression": {
        visitExpression(expression.base, owner, currentFunction, group);
        if (expression.type === "CallExpression")
          expression.arguments.forEach((argument) => {
            visitExpression(argument, owner, currentFunction, group);
          });
        else
          visitExpression(
            expression.type === "TableCallExpression"
              ? expression.arguments
              : expression.argument,
            owner,
            currentFunction,
            group,
          );
        const target =
          expression.base.type === "Identifier"
            ? bindingLocation(expression.base, currentFunction)
            : { kind: "unknown" as const };
        record({
          kind: "call",
          call: expression,
          target,
          owner,
          origin: expression,
          position,
        });
        return;
      }
    }
  }

  function declare(
    identifier: Parser.Identifier,
    owner: Parser.Statement,
    currentFunction: Scope | undefined,
    group: number,
  ): void {
    record({
      kind: "declare",
      location: bindingLocation(identifier, currentFunction),
      owner,
      origin: identifier,
      position: { group, ordering: "sequenced" },
    });
  }

  function visitFunction(fn: Parser.FunctionDeclaration): void {
    const functionScope = resolved.scopeOfFunction(fn);
    const owner = fn as Parser.Statement;
    fn.parameters.forEach((parameter) => {
      if (parameter.type === "Identifier")
        declare(parameter, owner, functionScope, nextGroupId++);
    });
    visitBlock(fn.body, functionScope);
  }

  function visitStatementContents(
    statement: Parser.Statement,
    currentFunction: Scope | undefined,
  ): void {
    const group = nextGroupId++;
    const expressions = (items: readonly Parser.Expression[]) => {
      items.forEach((item) => {
        visitExpression(item, statement, currentFunction, group);
      });
    };
    switch (statement.type) {
      case "LocalStatement":
        expressions(statement.init);
        recordValueSlots(statement, statement.init, statement.variables.length);
        statement.variables.forEach((id) => {
          declare(id, statement, currentFunction, group);
        });
        return;
      case "AssignmentStatement":
        expressions(statement.init);
        recordValueSlots(statement, statement.init, statement.variables.length);
        statement.variables.forEach((target) => {
          if (target.type === "Identifier")
            record({
              kind: "write",
              location: bindingLocation(target, currentFunction),
              owner: statement,
              origin: target,
              position: { group, ordering: "unordered" },
            });
          else {
            visitExpression(target.base, statement, currentFunction, group);
            if (target.type === "IndexExpression")
              visitExpression(target.index, statement, currentFunction, group);
            record({
              kind: "table-write",
              location: tableLocation(target),
              owner: statement,
              origin: target,
              position: { group, ordering: "unordered" },
            });
          }
        });
        return;
      case "CallStatement":
        visitExpression(
          statement.expression,
          statement,
          currentFunction,
          group,
        );
        return;
      case "ReturnStatement":
        expressions(statement.arguments);
        return;
      case "WhileStatement":
        visitExpression(statement.condition, statement, currentFunction, group);
        visitBlock(statement.body, currentFunction);
        return;
      case "RepeatStatement":
        visitBlock(statement.body, currentFunction);
        visitExpression(statement.condition, statement, currentFunction, group);
        return;
      case "DoStatement":
        visitBlock(statement.body, currentFunction);
        return;
      case "IfStatement":
        statement.clauses.forEach((clause) => {
          if (clause.type !== "ElseClause")
            visitExpression(
              clause.condition,
              statement,
              currentFunction,
              group,
            );
          visitBlock(clause.body, currentFunction);
        });
        return;
      case "ForNumericStatement":
        expressions([
          statement.start,
          statement.end,
          ...(statement.step ? [statement.step] : []),
        ]);
        declare(statement.variable, statement, currentFunction, group);
        visitBlock(statement.body, currentFunction);
        return;
      case "ForGenericStatement":
        expressions(statement.iterators);
        statement.variables.forEach((id) => {
          declare(id, statement, currentFunction, group);
        });
        visitBlock(statement.body, currentFunction);
        return;
      case "FunctionDeclaration":
        if (statement.identifier) {
          if (statement.identifier.type === "Identifier")
            record({
              kind: statement.isLocal ? "declare" : "write",
              location: bindingLocation(statement.identifier, currentFunction),
              owner: statement,
              origin: statement.identifier,
              position: { group, ordering: "sequenced" },
            });
          else {
            visitExpression(
              statement.identifier.base,
              statement,
              currentFunction,
              group,
            );
            record({
              kind: "table-write",
              location: tableLocation(statement.identifier),
              owner: statement,
              origin: statement.identifier,
              position: { group, ordering: "unordered" },
            });
          }
        }
        record({
          kind: "allocate",
          allocationKind: "function",
          owner: statement,
          origin: statement,
          position: { group, ordering: "sequenced" },
        });
        visitFunction(statement);
        return;
      case "BreakStatement":
      case "LabelStatement":
      case "GotoStatement":
        return;
    }
  }

  function visitStatement(
    statement: Parser.Statement,
    currentFunction: Scope | undefined,
  ): void {
    const operationStart = operations.length;
    visitStatementContents(statement, currentFunction);
    withinOwner.set(statement, operations.slice(operationStart));
  }

  function visitBlock(
    body: readonly Parser.Statement[],
    currentFunction: Scope | undefined,
  ): void {
    body.forEach((statement) => {
      visitStatement(statement, currentFunction);
    });
  }
  visitBlock(chunk.body, undefined);
  return {
    generation: options.generation ?? 0,
    policy: {
      runtime: options.runtime,
      assumptions: new Map(options.assumptions ?? []),
    },
    operations,
    unknowns,
    operationsOf: (owner) => byOwner.get(owner) ?? [],
    operationsWithin: (owner) => withinOwner.get(owner) ?? [],
    operationOf: (origin) => byOrigin.get(origin),
    operationsOfSymbol: (symbol) => bySymbol.get(symbol) ?? [],
    expressionFact: (expression) => expressionFacts.get(expression),
    valueSlotsOf: (owner) => valueSlots.get(owner) ?? [],
    discardabilityOf: (expression) => {
      const fact = expressionFacts.get(expression);
      if (!fact) return { discardable: false, reason: "expression-unindexed" };
      if (
        fact.effects.mayError.value === "may" ||
        fact.effects.mayInvokeMetamethod.value === "may"
      ) {
        return { discardable: false, reason: "observable-effect" };
      }
      const syntacticallyDiscardable =
        expression.type === "NilLiteral" ||
        expression.type === "BooleanLiteral" ||
        expression.type === "NumericLiteral" ||
        expression.type === "StringLiteral" ||
        expression.type === "FunctionDeclaration" ||
        (expression.type === "UnaryExpression" &&
          expression.operator === "-" &&
          expression.argument.type === "NumericLiteral");
      return syntacticallyDiscardable
        ? {
            discardable: true,
            evidence: { kind: "language", reason: "nonobserving-value" },
          }
        : { discardable: false, reason: "value-or-allocation-observable" };
    },
  };
}
