import Parser from "luaparse";
import {
  analyzeControlFlow,
  ControlFlowAnalysis,
  ExecutionUnit,
  ProgramPoint,
} from "./controlFlow";
import { ResolveResult, Symbol } from "./resolver";

export interface Allocation {
  readonly id: number;
  readonly kind: "table";
  readonly origin: Parser.TableConstructorExpression;
  readonly owner: Parser.Statement;
  readonly unit: ExecutionUnit;
}

export type AbstractValue =
  | {
      readonly kind: "allocations";
      readonly allocations: ReadonlySet<Allocation>;
    }
  | { readonly kind: "nil" }
  | { readonly kind: "unknown"; readonly reason: string };

export interface Definition {
  readonly id: number;
  readonly symbol: Symbol;
  readonly owner: Parser.Statement;
  readonly value: AbstractValue;
}

export interface ValueFlowAnalysis {
  readonly version: number;
  readonly controlFlow: ControlFlowAnalysis;
  readonly allocations: readonly Allocation[];
  readonly definitions: readonly Definition[];
  valueBefore(point: ProgramPoint, symbol: Symbol): AbstractValue;
  valueAfter(point: ProgramPoint, symbol: Symbol): AbstractValue;
  reachingDefinitionBefore(
    point: ProgramPoint,
    symbol: Symbol,
  ): Definition | undefined;
  aliasesBefore(
    point: ProgramPoint,
    allocation: Allocation,
  ): ReadonlySet<Symbol>;
  allocationOfBase(
    expression: Parser.Expression,
    point: ProgramPoint,
  ): Allocation | undefined;
  stableAllocationBetween(
    first: Parser.Statement,
    last: Parser.Statement,
    symbol: Symbol,
    expected: Allocation,
  ): boolean;
}

const UNKNOWN_ENTRY: AbstractValue = {
  kind: "unknown",
  reason: "region-entry",
};

/** 直線regionだけを対象にしたallocation/reaching-definition解析。 */
export function analyzeValueFlow(
  chunk: Parser.Chunk,
  resolved: ResolveResult,
  version = 0,
): ValueFlowAnalysis {
  const controlFlow = analyzeControlFlow(chunk, version);
  const allocations: Allocation[] = [];
  const definitions: Definition[] = [];
  const allocationByOrigin = new WeakMap<
    Parser.TableConstructorExpression,
    Allocation
  >();
  const beforeByPoint = new WeakMap<
    ProgramPoint,
    ReadonlyMap<Symbol, AbstractValue>
  >();
  const afterByPoint = new WeakMap<
    ProgramPoint,
    ReadonlyMap<Symbol, AbstractValue>
  >();
  const definitionBeforeByPoint = new WeakMap<
    ProgramPoint,
    ReadonlyMap<Symbol, Definition>
  >();
  let nextAllocationId = 0;
  let nextDefinitionId = 0;

  const allocationOf = (
    expression: Parser.TableConstructorExpression,
    point: ProgramPoint,
  ): Allocation => {
    const existing = allocationByOrigin.get(expression);
    if (existing) return existing;
    const allocation: Allocation = {
      id: nextAllocationId++,
      kind: "table",
      origin: expression,
      owner: point.statement,
      unit: point.unit,
    };
    allocations.push(allocation);
    allocationByOrigin.set(expression, allocation);
    return allocation;
  };

  const abstractExpression = (
    expression: Parser.Expression | undefined,
    point: ProgramPoint,
    values: ReadonlyMap<Symbol, AbstractValue>,
  ): AbstractValue => {
    if (!expression) return { kind: "nil" };
    if (expression.type === "TableConstructorExpression") {
      return {
        kind: "allocations",
        allocations: new Set([allocationOf(expression, point)]),
      };
    }
    if (expression.type === "Identifier") {
      const symbol = resolved.symbolOf(expression);
      return symbol
        ? (values.get(symbol) ?? UNKNOWN_ENTRY)
        : { kind: "unknown", reason: "global-or-unresolved" };
    }
    if (expression.type === "NilLiteral") return { kind: "nil" };
    return { kind: "unknown", reason: "unsupported-expression" };
  };

  controlFlow.regions.forEach((region) => {
    const values = new Map<Symbol, AbstractValue>();
    const reaching = new Map<Symbol, Definition>();
    region.points.forEach((point) => {
      beforeByPoint.set(point, new Map(values));
      definitionBeforeByPoint.set(point, new Map(reaching));
      const statement = point.statement;
      const writes: { symbol: Symbol; value: AbstractValue }[] = [];
      if (statement.type === "LocalStatement") {
        statement.variables.forEach((identifier, index) => {
          const symbol = resolved.symbolOf(identifier);
          if (symbol) {
            writes.push({
              symbol,
              value: abstractExpression(statement.init[index], point, values),
            });
          }
        });
      } else if (statement.type === "AssignmentStatement") {
        statement.variables.forEach((variable, index) => {
          if (variable.type !== "Identifier") return;
          const symbol = resolved.symbolOf(variable);
          if (symbol) {
            writes.push({
              symbol,
              value: abstractExpression(statement.init[index], point, values),
            });
          }
        });
      }
      writes.forEach(({ symbol, value }) => {
        const definition: Definition = {
          id: nextDefinitionId++,
          symbol,
          owner: statement,
          value,
        };
        definitions.push(definition);
        values.set(symbol, value);
        reaching.set(symbol, definition);
      });
      afterByPoint.set(point, new Map(values));
    });
  });

  const valueAt = (
    store: WeakMap<ProgramPoint, ReadonlyMap<Symbol, AbstractValue>>,
    point: ProgramPoint,
    symbol: Symbol,
  ) => store.get(point)?.get(symbol) ?? UNKNOWN_ENTRY;

  return {
    version,
    controlFlow,
    allocations,
    definitions,
    valueBefore: (point, symbol) => valueAt(beforeByPoint, point, symbol),
    valueAfter: (point, symbol) => valueAt(afterByPoint, point, symbol),
    reachingDefinitionBefore: (point, symbol) =>
      definitionBeforeByPoint.get(point)?.get(symbol),
    aliasesBefore: (point, allocation) => {
      const aliases = new Set<Symbol>();
      const values = beforeByPoint.get(point);
      values?.forEach((value, symbol) => {
        if (
          value.kind === "allocations" &&
          value.allocations.size === 1 &&
          value.allocations.has(allocation)
        ) {
          aliases.add(symbol);
        }
      });
      return aliases;
    },
    allocationOfBase: (expression, point) => {
      if (expression.type !== "Identifier") return undefined;
      const symbol = resolved.symbolOf(expression);
      if (!symbol) return undefined;
      const value = valueAt(beforeByPoint, point, symbol);
      if (value.kind !== "allocations" || value.allocations.size !== 1) {
        return undefined;
      }
      return value.allocations.values().next().value;
    },
    stableAllocationBetween: (first, last, symbol, expected) => {
      const points = controlFlow.pointsBetween(first, last);
      if (!points) return false;
      return points.every((point) => {
        const value = valueAt(beforeByPoint, point, symbol);
        return (
          value.kind === "allocations" &&
          value.allocations.size === 1 &&
          value.allocations.has(expected)
        );
      });
    },
  };
}
