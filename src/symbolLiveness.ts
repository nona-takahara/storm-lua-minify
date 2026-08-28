import { ControlFlowAnalysis, ControlFlowNode } from "./controlFlow";
import { OptimizerFacts, OptimizerOperation } from "./optimizerFacts";
import { Symbol } from "./resolver";

export interface SymbolLivenessAnalysis {
  readonly controlFlow: ControlFlowAnalysis;
  uses(node: ControlFlowNode): ReadonlySet<Symbol>;
  defs(node: ControlFlowNode): ReadonlySet<Symbol>;
  liveIn(node: ControlFlowNode): ReadonlySet<Symbol>;
  liveOut(node: ControlFlowNode): ReadonlySet<Symbol>;
}

/**
 * Computes the symbol liveness shared by scheduling and identifier coloring.
 * Nested functions are independent CFG units; upvalue reads remain uses in the
 * nested unit, while parameter declarations owned by a function syntax node
 * must not be mistaken for definitions in its parent's unit.
 */
export function analyzeSymbolLiveness(
  controlFlow: ControlFlowAnalysis,
  facts: OptimizerFacts,
): SymbolLivenessAnalysis {
  const directUses = new Map<ControlFlowNode, ReadonlySet<Symbol>>();
  const directDefs = new Map<ControlFlowNode, ReadonlySet<Symbol>>();
  const liveIn = new Map<ControlFlowNode, ReadonlySet<Symbol>>();
  const liveOut = new Map<ControlFlowNode, ReadonlySet<Symbol>>();

  controlFlow.nodes.forEach((node) => {
    const operations = node.statement ? facts.operationsOf(node.statement) : [];
    directUses.set(
      node,
      new Set(
        operations.flatMap((operation) => {
          if (operation.kind !== "read") return [];
          const symbol = symbolOf(operation);
          return symbol ? [symbol] : [];
        }),
      ),
    );
    directDefs.set(
      node,
      new Set(
        operations.flatMap((operation) => {
          if (operation.kind !== "write" && operation.kind !== "declare")
            return [];
          const symbol = symbolOf(operation);
          if (!symbol) return [];
          // Parameter declaration operations are attached to the function
          // syntax node in its parent unit. Their simultaneous binding is
          // represented explicitly by the interference builder instead.
          return operation.kind === "declare" && symbol.kind === "param"
            ? []
            : [symbol];
        }),
      ),
    );
  });

  controlFlow.units.forEach((unit) => {
    const unitNodes = controlFlow.nodes.filter((node) => node.unit === unit);
    unitNodes.forEach((node) => {
      liveIn.set(node, new Set());
      liveOut.set(node, new Set());
    });
    let changed = true;
    while (changed) {
      changed = false;
      // CFG nodes are built in reverse lexical order, which is a useful and
      // deterministic work-list order for this backward fixed point.
      unitNodes.forEach((node) => {
        const nextOut = new Set<Symbol>();
        node.successors.forEach((edge) =>
          liveIn.get(edge.to)?.forEach((symbol) => nextOut.add(symbol)),
        );
        const nextIn = new Set(directUses.get(node) ?? []);
        nextOut.forEach((symbol) => {
          if (!(directDefs.get(node) ?? new Set()).has(symbol))
            nextIn.add(symbol);
        });
        if (!setsEqual(liveOut.get(node), nextOut)) {
          liveOut.set(node, nextOut);
          changed = true;
        }
        if (!setsEqual(liveIn.get(node), nextIn)) {
          liveIn.set(node, nextIn);
          changed = true;
        }
      });
    }
  });

  return {
    controlFlow,
    uses: (node) => directUses.get(node) ?? new Set(),
    defs: (node) => directDefs.get(node) ?? new Set(),
    liveIn: (node) => liveIn.get(node) ?? new Set(),
    liveOut: (node) => liveOut.get(node) ?? new Set(),
  };
}

function symbolOf(operation: OptimizerOperation): Symbol | undefined {
  if (!("location" in operation)) return undefined;
  const location = operation.location;
  return location.kind === "local" ||
    location.kind === "parameter" ||
    location.kind === "upvalue"
    ? location.symbol
    : undefined;
}

function setsEqual<T>(
  left: ReadonlySet<T> | undefined,
  right: ReadonlySet<T>,
): boolean {
  if (!left || left.size !== right.size) return false;
  for (const value of left) if (!right.has(value)) return false;
  return true;
}
