import Parser from "luaparse";
import {
  analyzeControlFlow,
  ControlFlowAnalysis,
  ControlFlowNode,
  ExecutionUnit,
  ProgramPoint,
} from "./controlFlow";
import { ResolveResult, Symbol } from "./resolver";
import { OptimizerFacts, ValueSlotFact } from "./optimizerFacts";

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
  reason: "function-entry",
};

interface MutableDefinition extends Definition {
  value: AbstractValue;
}

interface Write {
  readonly definition: MutableDefinition;
  readonly slot?: ValueSlotFact;
}

/** CFG fixed-point value and reaching-definition analysis for intraprocedural optimizer facts. */
export function analyzeValueFlow(
  chunk: Parser.Chunk,
  resolved: ResolveResult,
  facts: OptimizerFacts,
  version = facts.generation,
): ValueFlowAnalysis {
  if (facts.generation !== version) {
    throw new Error("Value flow requires facts from the same AST generation");
  }
  const controlFlow = analyzeControlFlow(chunk, resolved, version);
  const allocations: Allocation[] = [];
  const definitions: MutableDefinition[] = [];
  const allocationByOrigin = new WeakMap<
    Parser.TableConstructorExpression,
    Allocation
  >();
  const writesByNode = new Map<ControlFlowNode, readonly Write[]>();
  const beforeByNode = new Map<
    ControlFlowNode,
    ReadonlyMap<Symbol, AbstractValue>
  >();
  const afterByNode = new Map<
    ControlFlowNode,
    ReadonlyMap<Symbol, AbstractValue>
  >();
  const reachingBeforeByNode = new Map<
    ControlFlowNode,
    ReadonlyMap<Symbol, ReadonlySet<Definition>>
  >();
  const reachingAfterByNode = new Map<
    ControlFlowNode,
    ReadonlyMap<Symbol, ReadonlySet<Definition>>
  >();
  const reachableFrom = computeReachability(controlFlow);

  facts.operations.forEach((operation) => {
    if (operation.kind !== "allocate" || operation.allocationKind !== "table")
      return;
    if (operation.origin.type !== "TableConstructorExpression") return;
    const point = controlFlow.pointOf(operation.owner);
    if (!point || allocationByOrigin.has(operation.origin)) return;
    const allocation: Allocation = {
      id: allocations.length,
      kind: "table",
      origin: operation.origin,
      owner: operation.owner,
      unit: point.unit,
    };
    allocations.push(allocation);
    allocationByOrigin.set(operation.origin, allocation);
  });

  controlFlow.nodes.forEach((node) => {
    const statement = node.statement;
    if (!statement || node !== controlFlow.nodeOf(statement)) return;
    if (
      statement.type !== "LocalStatement" &&
      statement.type !== "AssignmentStatement"
    )
      return;
    const slots = facts.valueSlotsOf(statement);
    const writes: Write[] = [];
    statement.variables.forEach((target, index) => {
      if (target.type !== "Identifier") return;
      const symbol = resolved.symbolOf(target);
      if (!symbol) return;
      const definition: MutableDefinition = {
        id: definitions.length,
        symbol,
        owner: statement,
        value: UNKNOWN_ENTRY,
      };
      definitions.push(definition);
      writes.push({ definition, slot: slots[index] });
    });
    if (writes.length > 0) writesByNode.set(node, writes);
  });

  controlFlow.units.forEach((unit) => {
    const unitNodes = controlFlow.nodes.filter((node) => node.unit === unit);
    const entry = unitNodes.find((node) => node.kind === "entry");
    if (!entry) return;
    beforeByNode.set(entry, new Map());
    afterByNode.set(entry, new Map());
    reachingBeforeByNode.set(entry, new Map());
    reachingAfterByNode.set(entry, new Map());
    let changed = true;
    let iterations = 0;
    const iterationLimit = Math.max(
      1,
      unitNodes.length * (definitions.length + 1),
    );
    while (changed) {
      if (iterations++ > iterationLimit) {
        throw new Error("Value-flow finite lattice failed to converge");
      }
      changed = false;
      // CFG nodes are constructed from the continuation backwards. Reverse iteration is therefore
      // source-forward and reaches a straight-line fixed point in one pass.
      [...unitNodes].reverse().forEach((node) => {
        if (node === entry) return;
        const predecessorValues = node.predecessors.flatMap((edge) => {
          const values = afterByNode.get(edge.from);
          return values ? [values] : [];
        });
        // An absent predecessor state is lattice bottom (not an unknown runtime value). Waiting until
        // one reachable predecessor has propagated prevents a not-yet-visited loop back-edge from
        // poisoning the first forward value with `function-entry`.
        if (predecessorValues.length === 0) return;
        const before = joinValueMaps(predecessorValues);
        const predecessorDefinitions = node.predecessors.flatMap((edge) => {
          const definitions = reachingAfterByNode.get(edge.from);
          return definitions ? [definitions] : [];
        });
        const reachingBefore = joinDefinitionMaps(predecessorDefinitions);
        const after = new Map(before);
        const reachingAfter = cloneDefinitionMap(reachingBefore);
        (writesByNode.get(node) ?? []).forEach((write) => {
          const value = abstractSlot(
            write.slot,
            before,
            resolved,
            allocationByOrigin,
          );
          write.definition.value = value;
          after.set(write.definition.symbol, value);
          reachingAfter.set(
            write.definition.symbol,
            new Set([write.definition]),
          );
        });
        if (!valueMapsEqual(beforeByNode.get(node), before)) {
          beforeByNode.set(node, before);
          changed = true;
        }
        if (!valueMapsEqual(afterByNode.get(node), after)) {
          afterByNode.set(node, after);
          changed = true;
        }
        if (
          !definitionMapsEqual(reachingBeforeByNode.get(node), reachingBefore)
        ) {
          reachingBeforeByNode.set(node, reachingBefore);
          changed = true;
        }
        if (
          !definitionMapsEqual(reachingAfterByNode.get(node), reachingAfter)
        ) {
          reachingAfterByNode.set(node, reachingAfter);
          changed = true;
        }
      });
    }
  });

  const valueAt = (
    store: ReadonlyMap<ControlFlowNode, ReadonlyMap<Symbol, AbstractValue>>,
    point: ProgramPoint,
    symbol: Symbol,
  ): AbstractValue => store.get(point.node)?.get(symbol) ?? UNKNOWN_ENTRY;

  return {
    version,
    controlFlow,
    allocations,
    definitions,
    valueBefore: (point, symbol) => valueAt(beforeByNode, point, symbol),
    valueAfter: (point, symbol) => valueAt(afterByNode, point, symbol),
    reachingDefinitionBefore: (point, symbol) => {
      const reaching = reachingBeforeByNode.get(point.node)?.get(symbol);
      return reaching?.size === 1 ? reaching.values().next().value : undefined;
    },
    aliasesBefore: (point, allocation) => {
      const aliases = new Set<Symbol>();
      beforeByNode.get(point.node)?.forEach((value, symbol) => {
        if (
          value.kind === "allocations" &&
          value.allocations.size === 1 &&
          value.allocations.has(allocation)
        )
          aliases.add(symbol);
      });
      return aliases;
    },
    allocationOfBase: (expression, point) => {
      if (expression.type !== "Identifier") return undefined;
      const symbol = resolved.symbolOf(expression);
      if (!symbol) return undefined;
      const value = valueAt(beforeByNode, point, symbol);
      return value.kind === "allocations" && value.allocations.size === 1
        ? value.allocations.values().next().value
        : undefined;
    },
    stableAllocationBetween: (first, last, symbol, expected) => {
      const firstPoint = controlFlow.pointOf(first);
      const lastPoint = controlFlow.pointOf(last);
      if (!firstPoint || !lastPoint || firstPoint.unit !== lastPoint.unit)
        return false;
      if (!controlFlow.nodeDominates(firstPoint.node, lastPoint.node))
        return false;
      if (!isExpected(valueAt(afterByNode, firstPoint, symbol), expected))
        return false;
      if (!isExpected(valueAt(beforeByNode, lastPoint, symbol), expected))
        return false;
      return !controlFlow.nodes.some((node) => {
        if (
          node.unit !== firstPoint.unit ||
          node === firstPoint.node ||
          node === lastPoint.node
        )
          return false;
        if (
          !reachableFrom.get(firstPoint.node)?.has(node) ||
          !reachableFrom.get(node)?.has(lastPoint.node)
        )
          return false;
        return (writesByNode.get(node) ?? []).some(
          (write) => write.definition.symbol === symbol,
        );
      });
    },
  };
}

function abstractSlot(
  slot: ValueSlotFact | undefined,
  values: ReadonlyMap<Symbol, AbstractValue>,
  resolved: ResolveResult,
  allocations: WeakMap<Parser.TableConstructorExpression, Allocation>,
): AbstractValue {
  if (!slot || slot.source.kind === "nil-padding") return { kind: "nil" };
  if (slot.source.kind === "tail-expansion" && slot.source.offset > 0) {
    return { kind: "unknown", reason: "multi-value-tail" };
  }
  const expression = slot.source.expression;
  if (expression.type === "TableConstructorExpression") {
    const allocation = allocations.get(expression);
    return allocation
      ? { kind: "allocations", allocations: new Set([allocation]) }
      : { kind: "unknown", reason: "allocation-unindexed" };
  }
  if (expression.type === "Identifier") {
    const symbol = resolved.symbolOf(expression);
    return symbol
      ? (values.get(symbol) ?? UNKNOWN_ENTRY)
      : { kind: "unknown", reason: "global-or-unresolved" };
  }
  if (expression.type === "NilLiteral") return { kind: "nil" };
  return { kind: "unknown", reason: "unsupported-expression" };
}

function joinValueMaps(
  inputs: readonly ReadonlyMap<Symbol, AbstractValue>[],
): Map<Symbol, AbstractValue> {
  if (inputs.length === 0) return new Map();
  const symbols = new Set(inputs.flatMap((input) => [...input.keys()]));
  const joined = new Map<Symbol, AbstractValue>();
  symbols.forEach((symbol) => {
    let value = inputs[0].get(symbol) ?? UNKNOWN_ENTRY;
    for (let index = 1; index < inputs.length; index++) {
      value = joinValue(value, inputs[index].get(symbol) ?? UNKNOWN_ENTRY);
    }
    joined.set(symbol, value);
  });
  return joined;
}

function joinValue(left: AbstractValue, right: AbstractValue): AbstractValue {
  if (left.kind === "nil" && right.kind === "nil") return left;
  if (left.kind === "allocations" && right.kind === "allocations") {
    return {
      kind: "allocations",
      allocations: new Set([...left.allocations, ...right.allocations]),
    };
  }
  if (
    left.kind === "unknown" &&
    right.kind === "unknown" &&
    left.reason === right.reason
  )
    return left;
  return { kind: "unknown", reason: "control-flow-join" };
}

function joinDefinitionMaps(
  inputs: readonly ReadonlyMap<Symbol, ReadonlySet<Definition>>[],
): Map<Symbol, ReadonlySet<Definition>> {
  const joined = new Map<Symbol, Set<Definition>>();
  inputs.forEach((input) => {
    input.forEach((definitions, symbol) => {
      const target = joined.get(symbol) ?? new Set<Definition>();
      definitions.forEach((definition) => target.add(definition));
      joined.set(symbol, target);
    });
  });
  return joined;
}

function cloneDefinitionMap(
  input: ReadonlyMap<Symbol, ReadonlySet<Definition>>,
): Map<Symbol, ReadonlySet<Definition>> {
  return new Map(
    [...input].map(([symbol, definitions]) => [symbol, new Set(definitions)]),
  );
}

function valueMapsEqual(
  left: ReadonlyMap<Symbol, AbstractValue> | undefined,
  right: ReadonlyMap<Symbol, AbstractValue>,
): boolean {
  if (!left || left.size !== right.size) return false;
  return [...left].every(([symbol, value]) =>
    valuesEqual(value, right.get(symbol)),
  );
}

function valuesEqual(
  left: AbstractValue,
  right: AbstractValue | undefined,
): boolean {
  if (!right || left.kind !== right.kind) return false;
  if (left.kind === "nil") return true;
  if (left.kind === "unknown")
    return right.kind === "unknown" && left.reason === right.reason;
  return (
    right.kind === "allocations" &&
    left.allocations.size === right.allocations.size &&
    [...left.allocations].every((allocation) =>
      right.allocations.has(allocation),
    )
  );
}

function definitionMapsEqual(
  left: ReadonlyMap<Symbol, ReadonlySet<Definition>> | undefined,
  right: ReadonlyMap<Symbol, ReadonlySet<Definition>>,
): boolean {
  if (!left || left.size !== right.size) return false;
  return [...left].every(([symbol, definitions]) => {
    const other = right.get(symbol);
    return (
      !!other &&
      definitions.size === other.size &&
      [...definitions].every((item) => other.has(item))
    );
  });
}

function isExpected(value: AbstractValue, expected: Allocation): boolean {
  return (
    value.kind === "allocations" &&
    value.allocations.size === 1 &&
    value.allocations.has(expected)
  );
}

function computeReachability(
  flow: ControlFlowAnalysis,
): ReadonlyMap<ControlFlowNode, ReadonlySet<ControlFlowNode>> {
  const result = new Map<ControlFlowNode, ReadonlySet<ControlFlowNode>>();
  flow.nodes.forEach((first) => {
    const pending = [first];
    const seen = new Set<ControlFlowNode>();
    while (pending.length > 0) {
      const node = pending.pop();
      if (!node || seen.has(node) || node.unit !== first.unit) continue;
      seen.add(node);
      node.successors.forEach((edge) => pending.push(edge.to));
    }
    result.set(first, seen);
  });
  return result;
}
