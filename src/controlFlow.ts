import Parser from "luaparse";
import { walkStatement } from "./astWalk";
import { ResolveResult, Symbol } from "./resolver";

export interface ExecutionUnit {
  readonly id: number;
  readonly kind: "chunk" | "function";
  readonly body: Parser.Statement[];
  readonly owner?: Parser.FunctionDeclaration;
  readonly parent?: ExecutionUnit;
}

export interface ProgramPoint {
  readonly unit: ExecutionUnit;
  readonly body: Parser.Statement[];
  readonly index: number;
  readonly statement: Parser.Statement;
  readonly node: ControlFlowNode;
}

export type ControlFlowEdgeKind =
  | "entry"
  | "fallthrough"
  | "branch-true"
  | "branch-false"
  | "loop-body"
  | "loop-exit"
  | "loop-back"
  | "break"
  | "return"
  | "goto"
  | "exit"
  | "unknown";

export interface ControlFlowEdge {
  readonly from: ControlFlowNode;
  readonly to: ControlFlowNode;
  readonly kind: ControlFlowEdgeKind;
}

export interface ControlFlowNode {
  readonly id: number;
  readonly unit: ExecutionUnit;
  readonly kind: "entry" | "statement" | "condition" | "exit";
  readonly statement?: Parser.Statement;
  /** `elseif` conditions share their source statement and use this index as node identity. */
  readonly clauseIndex?: number;
  readonly successors: readonly ControlFlowEdge[];
  readonly predecessors: readonly ControlFlowEdge[];
}

export interface ControlFlowAnalysis {
  readonly version: number;
  readonly complete: boolean;
  readonly units: readonly ExecutionUnit[];
  readonly nodes: readonly ControlFlowNode[];
  readonly unknownEdges: readonly ControlFlowEdge[];
  pointOf(statement: Parser.Statement): ProgramPoint | undefined;
  nodeOf(statement: Parser.Statement): ControlFlowNode | undefined;
  dominates(first: Parser.Statement, last: Parser.Statement): boolean;
  nodeDominates(first: ControlFlowNode, last: ControlFlowNode): boolean;
}

interface MutableNode extends Omit<
  ControlFlowNode,
  "successors" | "predecessors"
> {
  readonly successors: ControlFlowEdge[];
  readonly predecessors: ControlFlowEdge[];
}

type BuildBlock = (
  body: Parser.Statement[],
  continuation: MutableNode,
  loopExit?: MutableNode,
  loopBack?: MutableNode,
) => MutableNode;

/**
 * Builds a conservative intraprocedural CFG. Nested function bodies are separate execution units;
 * closure construction never creates an execution edge into the nested body.
 */
export function analyzeControlFlow(
  chunk: Parser.Chunk,
  resolved: ResolveResult,
  version = 0,
): ControlFlowAnalysis {
  const units: ExecutionUnit[] = [];
  const nodes: MutableNode[] = [];
  const unknownEdges: ControlFlowEdge[] = [];
  const pointByStatement = new WeakMap<Parser.Statement, ProgramPoint>();
  const nodeByStatement = new WeakMap<Parser.Statement, MutableNode>();
  const analyzedFunctions = new WeakSet<Parser.FunctionDeclaration>();
  let nextUnitId = 0;
  let nextNodeId = 0;

  const createNode = (
    unit: ExecutionUnit,
    kind: ControlFlowNode["kind"],
    statement?: Parser.Statement,
    clauseIndex?: number,
  ): MutableNode => {
    const created: MutableNode = {
      id: nextNodeId++,
      unit,
      kind,
      ...(statement ? { statement } : {}),
      ...(clauseIndex === undefined ? {} : { clauseIndex }),
      successors: [],
      predecessors: [],
    };
    nodes.push(created);
    if (statement && !nodeByStatement.has(statement)) {
      nodeByStatement.set(statement, created);
    }
    return created;
  };

  const connect = (
    from: MutableNode,
    to: MutableNode,
    kind: ControlFlowEdgeKind,
  ): void => {
    const edge: ControlFlowEdge = { from, to, kind };
    from.successors.push(edge);
    to.predecessors.push(edge);
    if (kind === "unknown") unknownEdges.push(edge);
  };

  const analyzeUnit = (
    body: Parser.Statement[],
    kind: ExecutionUnit["kind"],
    parent?: ExecutionUnit,
    owner?: Parser.FunctionDeclaration,
  ): void => {
    const unit: ExecutionUnit = {
      id: nextUnitId++,
      kind,
      body,
      ...(parent ? { parent } : {}),
      ...(owner ? { owner } : {}),
    };
    units.push(unit);
    const entry = createNode(unit, "entry");
    const exit = createNode(unit, "exit");
    const labels = new Map<Symbol, MutableNode>();
    const pendingGotos: { node: MutableNode; target?: Symbol }[] = [];
    const buildStatement = (
      statement: Parser.Statement,
      continuation: MutableNode,
      loopExit?: MutableNode,
      loopBack?: MutableNode,
    ): MutableNode => {
      switch (statement.type) {
        case "ReturnStatement": {
          const current = createNode(unit, "statement", statement);
          connect(current, exit, "return");
          return current;
        }
        case "BreakStatement": {
          const current = createNode(unit, "statement", statement);
          connect(current, loopExit ?? exit, loopExit ? "break" : "unknown");
          return current;
        }
        case "GotoStatement": {
          const current = createNode(unit, "statement", statement);
          pendingGotos.push({
            node: current,
            target: resolved.symbolOf(statement.label),
          });
          return current;
        }
        case "LabelStatement": {
          const current = createNode(unit, "statement", statement);
          connect(current, continuation, "fallthrough");
          const symbol = resolved.symbolOf(statement.label);
          if (symbol) labels.set(symbol, current);
          return current;
        }
        case "IfStatement": {
          let falseTarget = continuation;
          for (let index = statement.clauses.length - 1; index >= 0; index--) {
            const clause = statement.clauses[index];
            const branchStart = buildBlock(
              clause.body,
              continuation,
              loopExit,
              loopBack,
            );
            if (clause.type === "ElseClause") {
              falseTarget = branchStart;
              continue;
            }
            const condition = createNode(unit, "condition", statement, index);
            connect(condition, branchStart, "branch-true");
            connect(condition, falseTarget, "branch-false");
            falseTarget = condition;
          }
          nodeByStatement.set(statement, falseTarget);
          return falseTarget;
        }
        case "DoStatement": {
          const current = createNode(unit, "statement", statement);
          const bodyStart = buildBlock(
            statement.body,
            continuation,
            loopExit,
            loopBack,
          );
          connect(current, bodyStart, "fallthrough");
          return current;
        }
        case "WhileStatement": {
          const header = createNode(unit, "condition", statement);
          const bodyStart = buildBlock(
            statement.body,
            header,
            continuation,
            header,
          );
          connect(header, bodyStart, "loop-body");
          connect(header, continuation, "loop-exit");
          return header;
        }
        case "RepeatStatement": {
          const loopEntry = createNode(unit, "statement", statement);
          const condition = createNode(unit, "condition", statement, 0);
          const bodyStart = buildBlock(
            statement.body,
            condition,
            continuation,
            condition,
          );
          connect(loopEntry, bodyStart, "loop-body");
          connect(condition, continuation, "loop-exit");
          connect(condition, bodyStart, "loop-back");
          return loopEntry;
        }
        case "ForNumericStatement":
        case "ForGenericStatement": {
          const header = createNode(unit, "condition", statement);
          const bodyStart = buildBlock(
            statement.body,
            header,
            continuation,
            header,
          );
          connect(header, bodyStart, "loop-body");
          connect(header, continuation, "loop-exit");
          return header;
        }
        case "LocalStatement":
        case "AssignmentStatement":
        case "CallStatement":
        case "FunctionDeclaration": {
          const current = createNode(unit, "statement", statement);
          connect(
            current,
            continuation,
            continuation === exit
              ? "exit"
              : continuation === loopBack
                ? "loop-back"
                : "fallthrough",
          );
          return current;
        }
      }
    };

    const buildBlock: BuildBlock = (
      statements,
      continuation,
      loopExit,
      loopBack,
    ) => {
      let next = continuation;
      for (let index = statements.length - 1; index >= 0; index--) {
        next = buildStatement(statements[index], next, loopExit, loopBack);
      }
      return next;
    };

    const first = buildBlock(body, exit);
    connect(entry, first, first === exit ? "exit" : "entry");
    pendingGotos.forEach(({ node, target: targetSymbol }) => {
      const target = targetSymbol ? labels.get(targetSymbol) : undefined;
      const known = target !== undefined;
      connect(node, known ? target : exit, known ? "goto" : "unknown");
    });

    const indexPoints = (statements: Parser.Statement[]): void => {
      statements.forEach((statement, index) => {
        const node = nodeByStatement.get(statement);
        if (node)
          pointByStatement.set(statement, {
            unit,
            body: statements,
            index,
            statement,
            node,
          });
        childBodiesOfStatement(statement).forEach(indexPoints);
      });
    };
    indexPoints(body);

    const nestedFunctions: Parser.FunctionDeclaration[] = [];
    body.forEach((statement) => {
      walkStatement(statement, {
        onFunction: (fn) => nestedFunctions.push(fn),
      });
    });
    nestedFunctions.forEach((fn) => {
      if (analyzedFunctions.has(fn)) return;
      analyzedFunctions.add(fn);
      analyzeUnit(fn.body, "function", unit, fn);
    });
  };

  analyzeUnit(chunk.body, "chunk");
  const dominators = computeDominators(units, nodes);
  const nodeDominates = (
    first: ControlFlowNode,
    last: ControlFlowNode,
  ): boolean =>
    first.unit === last.unit && (dominators.get(last)?.has(first) ?? false);

  return {
    version,
    complete: unknownEdges.length === 0,
    units,
    nodes,
    unknownEdges,
    pointOf: (statement) => pointByStatement.get(statement),
    nodeOf: (statement) => nodeByStatement.get(statement),
    dominates: (first, last) => {
      const firstNode = nodeByStatement.get(first);
      const lastNode = nodeByStatement.get(last);
      return !!firstNode && !!lastNode && nodeDominates(firstNode, lastNode);
    },
    nodeDominates,
  };
}

function computeDominators(
  units: readonly ExecutionUnit[],
  nodes: readonly MutableNode[],
): ReadonlyMap<ControlFlowNode, ReadonlySet<ControlFlowNode>> {
  const result = new Map<ControlFlowNode, Set<ControlFlowNode>>();
  units.forEach((unit) => {
    const unitNodes = nodes.filter((node) => node.unit === unit);
    const entry = unitNodes.find((node) => node.kind === "entry");
    if (!entry) return;
    unitNodes.forEach((node) =>
      result.set(node, new Set(node === entry ? [entry] : unitNodes)),
    );
    let changed = true;
    while (changed) {
      changed = false;
      [...unitNodes].reverse().forEach((node) => {
        if (node === entry) return;
        const predecessors = node.predecessors.map((edge) => edge.from);
        let next = new Set<ControlFlowNode>();
        if (predecessors.length > 0) {
          next = new Set(result.get(predecessors[0]) ?? []);
          predecessors.slice(1).forEach((predecessor) => {
            const set = result.get(predecessor) ?? new Set();
            [...next].forEach((candidate) => {
              if (!set.has(candidate)) next.delete(candidate);
            });
          });
        }
        next.add(node);
        const previous = result.get(node) ?? new Set();
        if (
          previous.size !== next.size ||
          [...previous].some((item) => !next.has(item))
        ) {
          result.set(node, next);
          changed = true;
        }
      });
    }
  });
  return result;
}

export function childStatementBodies(
  body: readonly Parser.Statement[],
): Parser.Statement[][] {
  return body.flatMap(childBodiesOfStatement);
}

function childBodiesOfStatement(
  statement: Parser.Statement,
): Parser.Statement[][] {
  switch (statement.type) {
    case "DoStatement":
    case "WhileStatement":
    case "RepeatStatement":
    case "ForNumericStatement":
    case "ForGenericStatement":
      return [statement.body];
    case "IfStatement":
      return statement.clauses.map((clause) => clause.body);
    case "FunctionDeclaration":
    case "LocalStatement":
    case "AssignmentStatement":
    case "CallStatement":
    case "ReturnStatement":
    case "BreakStatement":
    case "LabelStatement":
    case "GotoStatement":
      return [];
  }
}
