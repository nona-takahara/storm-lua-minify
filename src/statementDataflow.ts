import Parser from "luaparse";
import { ControlFlowAnalysis, ControlFlowNode } from "./controlFlow";
import { Location, OptimizerFacts, OptimizerOperation } from "./optimizerFacts";
import { GlobalBinding, Symbol } from "./resolver";
import {
  analyzeSymbolLiveness,
  SymbolLivenessAnalysis,
} from "./symbolLiveness";
import { ValueFlowAnalysis } from "./valueFlow";

export type DependenceKind =
  | "read-after-write"
  | "write-after-read"
  | "write-after-write"
  | "call-order"
  | "error-order"
  | "metamethod-order"
  | "allocation-order"
  | "control-order"
  | "scope-order";

export interface StatementDependenceEdge {
  readonly from: Parser.Statement;
  readonly to: Parser.Statement;
  readonly kind: DependenceKind;
  readonly locations: readonly string[];
}

export interface StatementDataflowAnalysis {
  readonly generation: number;
  readonly controlFlow: ControlFlowAnalysis;
  readonly symbolLiveness: SymbolLivenessAnalysis;
  readonly dependencies: readonly StatementDependenceEdge[];
  liveIn(node: ControlFlowNode): ReadonlySet<Symbol>;
  liveOut(node: ControlFlowNode): ReadonlySet<Symbol>;
  isLiveBefore(statement: Parser.Statement, symbol: Symbol): boolean;
  isLiveAfter(statement: Parser.Statement, symbol: Symbol): boolean;
  dependenciesBetween(
    first: Parser.Statement,
    last: Parser.Statement,
  ): readonly StatementDependenceEdge[];
  canMoveBefore(
    moving: Parser.Statement,
    target: Parser.Statement,
  ):
    | { readonly allowed: true }
    | {
        readonly allowed: false;
        readonly reason: DependenceKind | "different-block" | "unknown-edge";
      };
}

interface Access {
  readonly family: "symbol" | "global" | "table" | "external";
  readonly identity: string;
  readonly tableIdentity?: string;
  readonly tableKey?: string;
}

interface StatementSummary {
  readonly reads: readonly Access[];
  readonly writes: readonly Access[];
  readonly hasCall: boolean;
  readonly mayError: boolean;
  readonly mayMetamethod: boolean;
  readonly allocates: boolean;
  readonly controlsFlow: boolean;
  readonly declares: boolean;
}

/** Shared CFG liveness and lexical statement-dependence analysis used by every scheduler rewrite. */
export function analyzeStatementDataflow(
  chunk: Parser.Chunk,
  facts: OptimizerFacts,
  valueFlow: ValueFlowAnalysis,
): StatementDataflowAnalysis {
  if (facts.generation !== valueFlow.version) {
    throw new Error("Statement dataflow requires one AST generation");
  }
  const controlFlow = valueFlow.controlFlow;
  const symbolIds = new Map<Symbol, number>();
  const globalIds = new Map<GlobalBinding, number>();
  const dependencies: StatementDependenceEdge[] = [];
  const dependenciesByFrom = new WeakMap<
    Parser.Statement,
    WeakMap<Parser.Statement, readonly StatementDependenceEdge[]>
  >();
  const bodyOf = new WeakMap<Parser.Statement, Parser.Statement[]>();
  const indexOf = new WeakMap<Parser.Statement, number>();

  const symbolId = (symbol: Symbol): number => {
    const existing = symbolIds.get(symbol);
    if (existing !== undefined) return existing;
    const id = symbolIds.size;
    symbolIds.set(symbol, id);
    return id;
  };
  const globalId = (binding: GlobalBinding): number => {
    const existing = globalIds.get(binding);
    if (existing !== undefined) return existing;
    const id = globalIds.size;
    globalIds.set(binding, id);
    return id;
  };

  const locationAccess = (
    location: Location,
    owner: Parser.Statement,
  ): Access => {
    switch (location.kind) {
      case "local":
      case "parameter":
      case "upvalue":
        return {
          family: "symbol",
          identity: `symbol:${String(symbolId(location.symbol))}`,
        };
      case "global":
        return {
          family: "global",
          identity: `global:${String(globalId(location.binding))}`,
        };
      case "external":
        return { family: "external", identity: "external:*" };
      case "table": {
        const point = controlFlow.pointOf(owner);
        const allocation = point
          ? valueFlow.allocationOfBase(location.base, point)
          : undefined;
        if (!allocation) return { family: "external", identity: "external:*" };
        const tableIdentity = `allocation:${String(allocation.id)}`;
        const tableKey =
          location.key.kind === "static" ? location.key.value : "*";
        return {
          family: "table",
          identity: `${tableIdentity}:${tableKey}`,
          tableIdentity,
          tableKey,
        };
      }
    }
  };

  const accessesOf = (
    operations: readonly OptimizerOperation[],
    kind: "read" | "write",
  ): Access[] => {
    const result: Access[] = [];
    operations.forEach((operation) => {
      if (
        kind === "read" &&
        (operation.kind === "read" || operation.kind === "table-read")
      )
        result.push(locationAccess(operation.location, operation.owner));
      if (
        kind === "write" &&
        (operation.kind === "write" ||
          operation.kind === "declare" ||
          operation.kind === "table-write")
      )
        result.push(locationAccess(operation.location, operation.owner));
    });
    return deduplicateAccesses(result);
  };

  const summarize = (statement: Parser.Statement): StatementSummary => {
    const operations = facts.operationsWithin(statement);
    const expressionEffects = operations.flatMap((operation) => {
      const origin = operation.origin;
      return isExpression(origin) ? [facts.expressionFact(origin)] : [];
    });
    return {
      reads: accessesOf(operations, "read"),
      writes: accessesOf(operations, "write"),
      hasCall: operations.some((operation) => operation.kind === "call"),
      mayError: expressionEffects.some(
        (fact) => fact?.effects.mayError.value === "may",
      ),
      mayMetamethod: expressionEffects.some(
        (fact) => fact?.effects.mayInvokeMetamethod.value === "may",
      ),
      allocates: operations.some((operation) => operation.kind === "allocate"),
      controlsFlow: isControlStatement(statement),
      declares: operations.some((operation) => operation.kind === "declare"),
    };
  };

  const liveness = analyzeSymbolLiveness(controlFlow, facts);

  const analyzeBody = (body: Parser.Statement[]): void => {
    body.forEach((statement, index) => {
      bodyOf.set(statement, body);
      indexOf.set(statement, index);
    });
    const summaries = body.map(summarize);
    for (let left = 0; left < body.length; left++) {
      for (let right = left + 1; right < body.length; right++) {
        dependencies.push(
          ...edgesBetween(
            body[left],
            summaries[left],
            body[right],
            summaries[right],
          ),
        );
      }
    }
    body.forEach((statement) => {
      childBodies(statement).forEach(analyzeBody);
    });
  };
  analyzeBody(chunk.body);
  dependencies.forEach((edge) => {
    let byTarget = dependenciesByFrom.get(edge.from);
    if (!byTarget) {
      byTarget = new WeakMap();
      dependenciesByFrom.set(edge.from, byTarget);
    }
    const current = byTarget.get(edge.to) ?? [];
    byTarget.set(edge.to, [...current, edge]);
  });

  return {
    generation: facts.generation,
    controlFlow,
    symbolLiveness: liveness,
    dependencies,
    liveIn: (node) => liveness.liveIn(node),
    liveOut: (node) => liveness.liveOut(node),
    isLiveBefore: (statement, symbol) => {
      const node = controlFlow.nodeOf(statement);
      return !!node && liveness.liveIn(node).has(symbol);
    },
    isLiveAfter: (statement, symbol) => {
      const node = controlFlow.nodeOf(statement);
      return !!node && liveness.liveOut(node).has(symbol);
    },
    dependenciesBetween: (first, last) =>
      dependenciesByFrom.get(first)?.get(last) ?? [],
    canMoveBefore: (moving, target) => {
      const body = bodyOf.get(moving);
      if (!body || body !== bodyOf.get(target)) {
        return { allowed: false, reason: "different-block" };
      }
      const movingIndex = indexOf.get(moving);
      const targetIndex = indexOf.get(target);
      if (
        movingIndex === undefined ||
        targetIndex === undefined ||
        targetIndex >= movingIndex
      )
        return { allowed: false, reason: "different-block" };
      const point = controlFlow.pointOf(moving);
      if (
        !point ||
        controlFlow.unknownEdges.some((edge) => edge.from.unit === point.unit)
      )
        return { allowed: false, reason: "unknown-edge" };
      for (let index = targetIndex; index < movingIndex; index++) {
        const obstacle = body[index];
        const edge = dependencies.find(
          (candidate) => candidate.from === obstacle && candidate.to === moving,
        );
        if (edge) return { allowed: false, reason: edge.kind };
      }
      return { allowed: true };
    },
  };
}

function edgesBetween(
  first: Parser.Statement,
  left: StatementSummary,
  last: Parser.Statement,
  right: StatementSummary,
): StatementDependenceEdge[] {
  const edges: StatementDependenceEdge[] = [];
  const addHazard = (
    kind: DependenceKind,
    a: readonly Access[],
    b: readonly Access[],
  ): void => {
    const locations = conflictingIdentities(a, b);
    if (locations.length > 0)
      edges.push({ from: first, to: last, kind, locations });
  };
  addHazard("read-after-write", left.writes, right.reads);
  addHazard("write-after-read", left.reads, right.writes);
  addHazard("write-after-write", left.writes, right.writes);
  if (left.hasCall && right.hasCall)
    edges.push({ from: first, to: last, kind: "call-order", locations: [] });
  if (left.mayError && right.mayError)
    edges.push({ from: first, to: last, kind: "error-order", locations: [] });
  if (left.mayMetamethod && right.mayMetamethod)
    edges.push({
      from: first,
      to: last,
      kind: "metamethod-order",
      locations: [],
    });
  if (left.allocates && right.allocates)
    edges.push({
      from: first,
      to: last,
      kind: "allocation-order",
      locations: [],
    });
  if (left.controlsFlow || right.controlsFlow)
    edges.push({ from: first, to: last, kind: "control-order", locations: [] });
  if (left.declares || right.declares)
    edges.push({ from: first, to: last, kind: "scope-order", locations: [] });
  return edges;
}

function conflictingIdentities(
  left: readonly Access[],
  right: readonly Access[],
): string[] {
  const conflicts = new Set<string>();
  left.forEach((a) => {
    right.forEach((b) => {
      if (accessesConflict(a, b))
        conflicts.add(a.identity === "external:*" ? b.identity : a.identity);
    });
  });
  return [...conflicts].sort();
}

function accessesConflict(left: Access, right: Access): boolean {
  if (left.family === "external" || right.family === "external") return true;
  if (left.family !== right.family) return false;
  if (left.family !== "table") return left.identity === right.identity;
  return (
    left.tableIdentity === right.tableIdentity &&
    (left.tableKey === "*" ||
      right.tableKey === "*" ||
      left.tableKey === right.tableKey)
  );
}

function deduplicateAccesses(accesses: readonly Access[]): Access[] {
  const seen = new Set<string>();
  return accesses.filter((access) => {
    if (seen.has(access.identity)) return false;
    seen.add(access.identity);
    return true;
  });
}

function isExpression(node: Parser.Node): node is Parser.Expression {
  return (
    node.type.endsWith("Expression") ||
    node.type.endsWith("Literal") ||
    node.type === "Identifier"
  );
}

function isControlStatement(statement: Parser.Statement): boolean {
  return (
    statement.type === "IfStatement" ||
    statement.type === "WhileStatement" ||
    statement.type === "RepeatStatement" ||
    statement.type === "ForNumericStatement" ||
    statement.type === "ForGenericStatement" ||
    statement.type === "BreakStatement" ||
    statement.type === "ReturnStatement" ||
    statement.type === "GotoStatement" ||
    statement.type === "LabelStatement"
  );
}

function childBodies(statement: Parser.Statement): Parser.Statement[][] {
  switch (statement.type) {
    case "DoStatement":
    case "WhileStatement":
    case "RepeatStatement":
    case "ForNumericStatement":
    case "ForGenericStatement":
      return [statement.body];
    case "IfStatement":
      return statement.clauses.map((clause) => clause.body);
    default:
      return [];
  }
}
