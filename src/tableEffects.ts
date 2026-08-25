import Parser from "luaparse";
import { ResolveResult, Symbol } from "./resolver";
import { Allocation, ValueFlowAnalysis } from "./valueFlow";
import { OptimizerFacts } from "./optimizerFacts";

export interface FreshTable {
  readonly allocation: Allocation;
  readonly symbol: Symbol;
  readonly declaration: Parser.LocalStatement | Parser.AssignmentStatement;
  readonly constructor: Parser.TableConstructorExpression;
  readonly functionDepth: number;
}

export interface TableEffect {
  readonly access: "read" | "write";
  readonly table: FreshTable;
  // undefinedは動的keyまたは安全にdecodeできない文字列literal。
  readonly staticKey: string | undefined;
  readonly expression: Parser.MemberExpression | Parser.IndexExpression;
  readonly owner: Parser.Statement;
  readonly baseSymbol: Symbol;
}

export type TableEscapeReason =
  "alias" | "call" | "return" | "store" | "capture" | "value-use";

export interface TableEscape {
  readonly table: FreshTable;
  readonly reason: TableEscapeReason;
  readonly identifier: Parser.Identifier;
  readonly owner: Parser.Statement;
}

export interface TableEffectAnalysis {
  readonly facts: OptimizerFacts;
  readonly freshTables: readonly FreshTable[];
  readonly effects: readonly TableEffect[];
  readonly escapes: readonly TableEscape[];
  isNonescaping(table: FreshTable): boolean;
  effectsOf(table: FreshTable): readonly TableEffect[];
  escapeReasonsOf(table: FreshTable): readonly TableEscapeReason[];
  stabilityBetween(
    table: FreshTable,
    baseSymbol: Symbol,
    first: Parser.Statement,
    last: Parser.Statement,
  ):
    | { readonly stable: true }
    | {
        readonly stable: false;
        readonly reason:
          "control-flow-barrier" | "unstable-reaching-definition";
      };
}

type ValueUse = "value-use" | "alias" | "call" | "return" | "store";

/** fresh local tableに対する構文事実を収集する。ASTは変更しない。 */
export function analyzeTableEffects(
  chunk: Parser.Chunk,
  resolved: ResolveResult,
  valueFlow: ValueFlowAnalysis,
  facts: OptimizerFacts,
): TableEffectAnalysis {
  const freshTables: FreshTable[] = [];
  const freshByAllocation = new Map<Allocation, FreshTable>();
  const allocationByStableSymbol = new Map<Symbol, Allocation | null>();
  const effects: TableEffect[] = [];
  const escapes: TableEscape[] = [];
  if (valueFlow.version !== facts.generation) {
    throw new Error("Table effects require facts from the same AST generation");
  }

  valueFlow.allocations.forEach((allocation) => {
    const binding = bindingOfAllocation(allocation);
    if (!binding) return;
    const table: FreshTable = {
      allocation,
      symbol: binding.symbol,
      declaration: binding.declaration,
      constructor: allocation.origin,
      functionDepth: depthOf(allocation.unit),
    };
    freshTables.push(table);
    freshByAllocation.set(allocation, table);
  });
  valueFlow.definitions.forEach((definition) => {
    if (
      definition.value.kind !== "allocations" ||
      definition.value.allocations.size !== 1
    ) {
      allocationByStableSymbol.set(definition.symbol, null);
      return;
    }
    const allocation = definition.value.allocations.values().next().value;
    if (!allocation) return;
    const existing = allocationByStableSymbol.get(definition.symbol);
    allocationByStableSymbol.set(
      definition.symbol,
      existing === undefined || existing === allocation ? allocation : null,
    );
  });

  analyzeBlock(chunk.body, 0);

  function escapeIdentifier(
    identifier: Parser.Identifier,
    use: ValueUse,
    owner: Parser.Statement,
    functionDepth: number,
  ): void {
    const symbol = resolved.symbolOf(identifier);
    const point = valueFlow.controlFlow.pointOf(owner);
    const allocation =
      symbol && point
        ? valueFlow.allocationOfBase(identifier, point)
        : undefined;
    const fallback = symbol ? allocationByStableSymbol.get(symbol) : undefined;
    const resolvedAllocation = allocation ?? fallback ?? undefined;
    const table = resolvedAllocation
      ? freshByAllocation.get(resolvedAllocation)
      : undefined;
    if (!table) return;
    escapes.push({
      table,
      reason: functionDepth > table.functionDepth ? "capture" : use,
      identifier,
      owner,
    });
  }

  function analyzeExpression(
    expression: Parser.Expression,
    owner: Parser.Statement,
    use: ValueUse,
    functionDepth: number,
  ): void {
    switch (expression.type) {
      case "Identifier":
        escapeIdentifier(expression, use, owner, functionDepth);
        return;
      case "StringLiteral":
      case "NumericLiteral":
      case "BooleanLiteral":
      case "NilLiteral":
      case "VarargLiteral":
        return;
      case "LogicalExpression":
      case "BinaryExpression":
        analyzeExpression(expression.left, owner, "value-use", functionDepth);
        analyzeExpression(expression.right, owner, "value-use", functionDepth);
        return;
      case "UnaryExpression":
        analyzeExpression(
          expression.argument,
          owner,
          "value-use",
          functionDepth,
        );
        return;
      case "MemberExpression":
      case "IndexExpression":
        analyzeTableAccess(expression, "read", owner, functionDepth);
        return;
      case "CallExpression":
        analyzeCallParts(
          expression.base,
          expression.arguments,
          owner,
          functionDepth,
        );
        return;
      case "TableCallExpression":
        analyzeCallParts(
          expression.base,
          [expression.arguments],
          owner,
          functionDepth,
        );
        return;
      case "StringCallExpression":
        analyzeCallParts(
          expression.base,
          [expression.argument],
          owner,
          functionDepth,
        );
        return;
      case "FunctionDeclaration":
        analyzeBlock(expression.body, functionDepth + 1);
        return;
      case "TableConstructorExpression":
        expression.fields.forEach((field) => {
          if (field.type === "TableKey") {
            analyzeExpression(field.key, owner, "value-use", functionDepth);
          }
          analyzeExpression(field.value, owner, "store", functionDepth);
        });
        return;
      default: {
        const exhaustive: never = expression;
        throw new TypeError(
          "Unknown expression type: `" + JSON.stringify(exhaustive) + "`",
        );
      }
    }
  }

  function analyzeCallParts(
    base: Parser.Expression,
    args: Parser.Expression[],
    owner: Parser.Statement,
    functionDepth: number,
  ): void {
    analyzeExpression(base, owner, "call", functionDepth);
    args.forEach((argument) => {
      analyzeExpression(argument, owner, "call", functionDepth);
    });
    if (base.type === "MemberExpression" && base.indexer === ":") {
      const table = tableOfBase(base.base, owner);
      if (table && base.base.type === "Identifier") {
        escapeIdentifier(base.base, "call", owner, functionDepth);
      }
    }
  }

  function analyzeTableAccess(
    expression: Parser.MemberExpression | Parser.IndexExpression,
    access: TableEffect["access"],
    owner: Parser.Statement,
    functionDepth: number,
  ): void {
    const baseSymbol =
      expression.base.type === "Identifier"
        ? resolved.symbolOf(expression.base)
        : undefined;
    const table = tableOfBase(expression.base, owner);
    if (table && baseSymbol) {
      effects.push({
        access,
        table,
        staticKey: staticKeyFromFacts(expression),
        expression,
        owner,
        baseSymbol,
      });
      if (
        functionDepth > table.functionDepth &&
        expression.base.type === "Identifier"
      ) {
        escapeIdentifier(expression.base, "value-use", owner, functionDepth);
      }
    } else {
      analyzeExpression(expression.base, owner, "value-use", functionDepth);
    }
    if (expression.type === "IndexExpression") {
      analyzeExpression(expression.index, owner, "value-use", functionDepth);
    }
  }

  function staticKeyFromFacts(
    expression: Parser.MemberExpression | Parser.IndexExpression,
  ): string | undefined {
    const operation = facts.operationOf(expression);
    if (
      !operation ||
      (operation.kind !== "table-read" && operation.kind !== "table-write")
    ) {
      return undefined;
    }
    return operation.location.key.kind === "static"
      ? operation.location.key.value
      : undefined;
  }

  function tableOfBase(
    base: Parser.Expression,
    owner: Parser.Statement,
  ): FreshTable | undefined {
    const point = valueFlow.controlFlow.pointOf(owner);
    if (!point) return undefined;
    const allocation = valueFlow.allocationOfBase(base, point);
    return allocation ? freshByAllocation.get(allocation) : undefined;
  }

  function isTrackedLocalAlias(
    expression: Parser.Expression,
    owner: Parser.Statement,
    functionDepth: number,
  ): boolean {
    if (expression.type !== "Identifier") return false;
    const point = valueFlow.controlFlow.pointOf(owner);
    if (!point) return false;
    const allocation = valueFlow.allocationOfBase(expression, point);
    const table = allocation ? freshByAllocation.get(allocation) : undefined;
    return table?.functionDepth === functionDepth;
  }

  function analyzeStatement(
    statement: Parser.Statement,
    functionDepth: number,
  ): void {
    switch (statement.type) {
      case "LocalStatement":
        statement.init.forEach((expression) => {
          if (!isTrackedLocalAlias(expression, statement, functionDepth)) {
            analyzeExpression(expression, statement, "alias", functionDepth);
          }
        });
        return;
      case "AssignmentStatement":
        statement.init.forEach((expression) => {
          // 既存bindingへの代入はupvalueへの公開になり得る。代入先localの
          // execution unitを証明する解析が入るまでは、単純aliasでもescape扱い。
          analyzeExpression(expression, statement, "store", functionDepth);
        });
        statement.variables.forEach((variable) => {
          if (
            variable.type === "MemberExpression" ||
            variable.type === "IndexExpression"
          ) {
            analyzeTableAccess(variable, "write", statement, functionDepth);
          }
        });
        return;
      case "CallStatement":
        analyzeExpression(
          statement.expression,
          statement,
          "call",
          functionDepth,
        );
        return;
      case "DoStatement":
        analyzeBlock(statement.body, functionDepth);
        return;
      case "WhileStatement":
        analyzeExpression(
          statement.condition,
          statement,
          "value-use",
          functionDepth,
        );
        analyzeBlock(statement.body, functionDepth);
        return;
      case "RepeatStatement":
        analyzeBlock(statement.body, functionDepth);
        analyzeExpression(
          statement.condition,
          statement,
          "value-use",
          functionDepth,
        );
        return;
      case "IfStatement":
        statement.clauses.forEach((clause) => {
          if (clause.type !== "ElseClause") {
            analyzeExpression(
              clause.condition,
              statement,
              "value-use",
              functionDepth,
            );
          }
          analyzeBlock(clause.body, functionDepth);
        });
        return;
      case "ForNumericStatement":
        analyzeExpression(
          statement.start,
          statement,
          "value-use",
          functionDepth,
        );
        analyzeExpression(statement.end, statement, "value-use", functionDepth);
        if (statement.step) {
          analyzeExpression(
            statement.step,
            statement,
            "value-use",
            functionDepth,
          );
        }
        analyzeBlock(statement.body, functionDepth);
        return;
      case "ForGenericStatement":
        statement.iterators.forEach((iterator) => {
          analyzeExpression(iterator, statement, "value-use", functionDepth);
        });
        analyzeBlock(statement.body, functionDepth);
        return;
      case "FunctionDeclaration":
        if (
          statement.identifier &&
          statement.identifier.type !== "Identifier"
        ) {
          analyzeTableAccess(
            statement.identifier,
            "write",
            statement,
            functionDepth,
          );
        }
        analyzeBlock(statement.body, functionDepth + 1);
        return;
      case "ReturnStatement":
        statement.arguments.forEach((argument) => {
          analyzeExpression(argument, statement, "return", functionDepth);
        });
        return;
      case "BreakStatement":
      case "LabelStatement":
      case "GotoStatement":
        return;
      default: {
        const exhaustive: never = statement;
        throw new TypeError(
          "Unknown statement type: `" + JSON.stringify(exhaustive) + "`",
        );
      }
    }
  }

  function analyzeBlock(body: Parser.Statement[], functionDepth: number): void {
    body.forEach((statement) => {
      analyzeStatement(statement, functionDepth);
    });
  }

  return {
    facts,
    freshTables,
    effects,
    escapes,
    isNonescaping: (table) => !escapes.some((escape) => escape.table === table),
    effectsOf: (table) => effects.filter((effect) => effect.table === table),
    escapeReasonsOf: (table) =>
      escapes
        .filter((escape) => escape.table === table)
        .map((escape) => escape.reason),
    stabilityBetween: (table, baseSymbol, first, last) => {
      const firstPoint = valueFlow.controlFlow.pointOf(first);
      const lastPoint = valueFlow.controlFlow.pointOf(last);
      if (
        !firstPoint ||
        !lastPoint ||
        firstPoint.unit !== lastPoint.unit ||
        !valueFlow.controlFlow.dominates(first, last)
      ) {
        return { stable: false, reason: "control-flow-barrier" };
      }
      return valueFlow.stableAllocationBetween(
        first,
        last,
        baseSymbol,
        table.allocation,
      )
        ? { stable: true }
        : { stable: false, reason: "unstable-reaching-definition" };
    },
  };

  function bindingOfAllocation(allocation: Allocation):
    | {
        readonly symbol: Symbol;
        readonly declaration:
          Parser.LocalStatement | Parser.AssignmentStatement;
      }
    | undefined {
    const owner = allocation.owner;
    if (
      owner.type !== "LocalStatement" &&
      owner.type !== "AssignmentStatement"
    ) {
      return undefined;
    }
    const index = owner.init.indexOf(allocation.origin);
    if (index < 0) return undefined;
    const target = owner.variables[index];
    if (target.type !== "Identifier") return undefined;
    const symbol = resolved.symbolOf(target);
    if (!symbol) return undefined;
    if (owner.type === "AssignmentStatement") {
      const declaration = facts
        .operationsOfSymbol(symbol)
        .find(
          (operation) =>
            operation.kind === "declare" &&
            operation.origin === symbol.declaration,
        );
      const declarationPoint = declaration
        ? valueFlow.controlFlow.pointOf(declaration.owner)
        : undefined;
      const allocationPoint = valueFlow.controlFlow.pointOf(owner);
      if (
        !declarationPoint ||
        !allocationPoint ||
        declarationPoint.unit !== allocation.unit ||
        allocationPoint.unit !== allocation.unit ||
        !valueFlow.controlFlow.dominates(
          declarationPoint.statement,
          allocationPoint.statement,
        )
      )
        return undefined;
    }
    return { symbol, declaration: owner };
  }

  function depthOf(unit: Allocation["unit"]): number {
    let depth = 0;
    for (let current = unit.parent; current; current = current.parent) depth++;
    return depth;
  }
}
