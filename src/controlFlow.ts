import Parser from "luaparse";
import { walkStatement } from "./astWalk";

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
}

export interface LinearRegion {
  readonly id: number;
  readonly unit: ExecutionUnit;
  readonly body: Parser.Statement[];
  readonly points: readonly ProgramPoint[];
  readonly certified: true;
}

export interface ControlFlowEdge {
  readonly from: ControlFlowNode;
  readonly to: ControlFlowNode;
  readonly kind: "entry" | "fallthrough" | "unknown" | "exit";
}

export interface ControlFlowNode {
  readonly id: number;
  readonly unit: ExecutionUnit;
  readonly kind: "entry" | "statement" | "opaque" | "exit";
  readonly statement?: Parser.Statement;
  readonly successors: readonly ControlFlowEdge[];
  readonly predecessors: readonly ControlFlowEdge[];
}

export interface ControlFlowAnalysis {
  readonly version: number;
  readonly complete: false;
  readonly units: readonly ExecutionUnit[];
  readonly regions: readonly LinearRegion[];
  readonly nodes: readonly ControlFlowNode[];
  pointOf(statement: Parser.Statement): ProgramPoint | undefined;
  nodeOf(statement: Parser.Statement): ControlFlowNode | undefined;
  regionOf(statement: Parser.Statement): LinearRegion | undefined;
  pointsBetween(
    first: Parser.Statement,
    last: Parser.Statement,
  ): readonly ProgramPoint[] | undefined;
  dominates(first: Parser.Statement, last: Parser.Statement): boolean;
}

export function analyzeControlFlow(
  chunk: Parser.Chunk,
  version = 0,
): ControlFlowAnalysis {
  const units: ExecutionUnit[] = [];
  const regions: LinearRegion[] = [];
  const nodes: ControlFlowNode[] = [];
  const pointByStatement = new WeakMap<Parser.Statement, ProgramPoint>();
  const regionByStatement = new WeakMap<Parser.Statement, LinearRegion>();
  const nodeByStatement = new WeakMap<Parser.Statement, ControlFlowNode>();
  let nextUnitId = 0;
  let nextRegionId = 0;
  let nextNodeId = 0;

  type MutableNode = Omit<ControlFlowNode, "successors" | "predecessors"> & {
    successors: ControlFlowEdge[];
    predecessors: ControlFlowEdge[];
  };
  const node = (
    unit: ExecutionUnit,
    kind: ControlFlowNode["kind"],
    statement?: Parser.Statement,
  ): MutableNode => {
    const created: MutableNode = {
      id: nextNodeId++,
      unit,
      kind,
      ...(statement ? { statement } : {}),
      successors: [],
      predecessors: [],
    };
    nodes.push(created);
    if (statement) nodeByStatement.set(statement, created);
    return created;
  };
  const connect = (
    from: MutableNode,
    to: MutableNode,
    kind: ControlFlowEdge["kind"],
  ) => {
    const edge: ControlFlowEdge = { from, to, kind };
    from.successors.push(edge);
    to.predecessors.push(edge);
  };

  const analyzeBody = (body: Parser.Statement[], unit: ExecutionUnit) => {
    let pending: ProgramPoint[] = [];
    const flush = () => {
      if (pending.length === 0) return;
      const region: LinearRegion = {
        id: nextRegionId++,
        unit,
        body,
        points: pending,
        certified: true,
      };
      regions.push(region);
      pending.forEach((point) =>
        regionByStatement.set(point.statement, region),
      );
      pending = [];
    };

    body.forEach((statement, index) => {
      if (isCertifiedLinearStatement(statement)) {
        const point: ProgramPoint = { unit, body, index, statement };
        pending.push(point);
        pointByStatement.set(statement, point);
      } else {
        flush();
      }

      const nestedFunctions: Parser.FunctionDeclaration[] = [];
      walkStatement(statement, {
        onFunction: (fn) => {
          nestedFunctions.push(fn);
        },
      });
      nestedFunctions.forEach((fn) => {
        analyzeUnit(fn.body, "function", unit, fn);
      });
      if (statement.type !== "FunctionDeclaration") {
        childBodiesOfStatement(statement).forEach((child) => {
          analyzeBody(child, unit);
        });
      }
    });
    flush();
  };

  const analyzeUnit = (
    body: Parser.Statement[],
    kind: ExecutionUnit["kind"],
    parent?: ExecutionUnit,
    owner?: Parser.FunctionDeclaration,
  ) => {
    const unit: ExecutionUnit = {
      id: nextUnitId++,
      kind,
      body,
      ...(parent ? { parent } : {}),
      ...(owner ? { owner } : {}),
    };
    units.push(unit);
    analyzeBody(body, unit);
    const entry = node(unit, "entry");
    const exit = node(unit, "exit");
    let previous = entry;
    body.forEach((statement) => {
      const current = node(
        unit,
        isCertifiedLinearStatement(statement) ? "statement" : "opaque",
        statement,
      );
      connect(
        previous,
        current,
        previous === entry
          ? "entry"
          : previous.kind === "statement" && current.kind === "statement"
            ? "fallthrough"
            : "unknown",
      );
      previous = current;
    });
    connect(previous, exit, previous.kind === "statement" ? "exit" : "unknown");
  };

  analyzeUnit(chunk.body, "chunk");
  return {
    version,
    complete: false,
    units,
    regions,
    nodes,
    pointOf: (statement) => pointByStatement.get(statement),
    nodeOf: (statement) => nodeByStatement.get(statement),
    regionOf: (statement) => regionByStatement.get(statement),
    pointsBetween: (first, last) => {
      const firstRegion = regionByStatement.get(first);
      if (!firstRegion || firstRegion !== regionByStatement.get(last)) {
        return undefined;
      }
      const from = firstRegion.points.findIndex(
        (point) => point.statement === first,
      );
      const to = firstRegion.points.findIndex(
        (point) => point.statement === last,
      );
      return from >= 0 && to >= from
        ? firstRegion.points.slice(from, to + 1)
        : undefined;
    },
    dominates: (first, last) => {
      const firstRegion = regionByStatement.get(first);
      if (!firstRegion || firstRegion !== regionByStatement.get(last)) {
        return false;
      }
      const firstIndex = firstRegion.points.findIndex(
        (point) => point.statement === first,
      );
      const lastIndex = firstRegion.points.findIndex(
        (point) => point.statement === last,
      );
      return firstIndex >= 0 && lastIndex >= firstIndex;
    },
  };
}

export function childStatementBodies(
  body: readonly Parser.Statement[],
): Parser.Statement[][] {
  return body.flatMap(childBodiesOfStatement);
}

function isCertifiedLinearStatement(statement: Parser.Statement): boolean {
  return (
    statement.type === "LocalStatement" ||
    statement.type === "AssignmentStatement" ||
    statement.type === "CallStatement"
  );
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
    default: {
      const exhaustive: never = statement;
      throw new TypeError(
        `Unknown statement type: ${JSON.stringify(exhaustive)}`,
      );
    }
  }
}
