import Parser from "luaparse";
import { OptimizerFacts } from "./optimizerFacts";
import { ResolveResult, Symbol } from "./resolver";

export interface Callable {
  readonly id: number;
  readonly declaration: Parser.FunctionDeclaration;
  readonly symbol?: Symbol;
  readonly parameters: readonly Symbol[];
}

export interface CallSite {
  readonly id: number;
  readonly call:
    | Parser.CallExpression
    | Parser.TableCallExpression
    | Parser.StringCallExpression;
  readonly owner: Parser.Statement;
  readonly caller?: Callable;
  readonly targets: ReadonlySet<Callable>;
  readonly hasUnknownTarget: boolean;
  /** Name eligible for an explicit runtime/module contract; never a local spelling. */
  readonly externalTargetName?: string;
}

export interface CallGraphScc {
  readonly id: number;
  readonly functions: readonly Callable[];
  readonly recursive: boolean;
}

export interface CallGraphAnalysis {
  readonly generation: number;
  readonly functions: readonly Callable[];
  readonly calls: readonly CallSite[];
  readonly sccs: readonly CallGraphScc[];
  functionOf(declaration: Parser.FunctionDeclaration): Callable | undefined;
  functionOfSymbol(symbol: Symbol): Callable | undefined;
  callSiteOf(
    call:
      | Parser.CallExpression
      | Parser.TableCallExpression
      | Parser.StringCallExpression,
  ): CallSite | undefined;
}

/**
 * Resolve identityに基づくmodule-local call graphを構築する。
 *
 * 名前文字列やsource rangeからcall targetを推測しない。現行のoptimizer snapshotは
 * module単位なので、global/module/external edgeはknown targetと偽らずunknown bitとして
 * 保持する。local aliasは単一代入の関数値だけを有限固定点で解決する。
 */
export function analyzeCallGraph(
  chunk: Parser.Chunk,
  resolved: ResolveResult,
  facts: OptimizerFacts,
): CallGraphAnalysis {
  const functions: Callable[] = [];
  const functionByDeclaration = new WeakMap<
    Parser.FunctionDeclaration,
    Callable
  >();
  const functionBySymbol = new Map<Symbol, Callable>();
  const ownerFunction = new WeakMap<Parser.Statement, Callable>();
  const directFunctionBySymbol = new Map<Symbol, Callable>();
  const aliasSources = new Map<Symbol, Symbol>();
  const assignmentOriginBySymbol = new Map<Symbol, Parser.Identifier>();
  const conflictingBindings = new Set<Symbol>();

  const registerFunction = (
    declaration: Parser.FunctionDeclaration,
    symbol?: Symbol,
  ): Callable => {
    const existing = functionByDeclaration.get(declaration);
    if (existing) return existing;
    const scope = resolved.scopeOfFunction(declaration);
    const callable: Callable = {
      id: functions.length,
      declaration,
      ...(symbol ? { symbol } : {}),
      parameters:
        scope?.symbols.filter((candidate) => candidate.kind === "param") ?? [],
    };
    functions.push(callable);
    functionByDeclaration.set(declaration, callable);
    if (symbol) directFunctionBySymbol.set(symbol, callable);
    return callable;
  };

  const visitExpression = (
    expression: Parser.Expression,
    current?: Callable,
  ): void => {
    switch (expression.type) {
      case "FunctionDeclaration": {
        const callable = registerFunction(expression);
        visitBlock(expression.body, callable);
        return;
      }
      case "CallExpression":
        visitExpression(expression.base, current);
        expression.arguments.forEach((argument) => {
          visitExpression(argument, current);
        });
        return;
      case "TableCallExpression":
        visitExpression(expression.base, current);
        visitExpression(expression.arguments, current);
        return;
      case "StringCallExpression":
        visitExpression(expression.base, current);
        visitExpression(expression.argument, current);
        return;
      case "BinaryExpression":
      case "LogicalExpression":
        visitExpression(expression.left, current);
        visitExpression(expression.right, current);
        return;
      case "UnaryExpression":
        visitExpression(expression.argument, current);
        return;
      case "MemberExpression":
        visitExpression(expression.base, current);
        return;
      case "IndexExpression":
        visitExpression(expression.base, current);
        visitExpression(expression.index, current);
        return;
      case "TableConstructorExpression":
        expression.fields.forEach((field) => {
          if (field.type === "TableKey") visitExpression(field.key, current);
          visitExpression(field.value, current);
        });
        return;
      case "Identifier":
      case "NilLiteral":
      case "BooleanLiteral":
      case "NumericLiteral":
      case "StringLiteral":
      case "VarargLiteral":
        return;
    }
  };

  const rememberBinding = (
    target: Parser.Identifier,
    expression: Parser.Expression | undefined,
    assignment = false,
  ): void => {
    const symbol = resolved.symbolOf(target);
    if (!symbol || !expression) return;
    if (
      directFunctionBySymbol.has(symbol) ||
      aliasSources.has(symbol) ||
      assignmentOriginBySymbol.has(symbol)
    )
      conflictingBindings.add(symbol);
    if (assignment) assignmentOriginBySymbol.set(symbol, target);
    if (expression.type === "FunctionDeclaration") {
      directFunctionBySymbol.set(symbol, registerFunction(expression, symbol));
      return;
    }
    if (expression.type !== "Identifier") return;
    const source = resolved.symbolOf(expression);
    if (source) aliasSources.set(symbol, source);
  };

  function visitStatement(
    statement: Parser.Statement,
    current?: Callable,
  ): void {
    if (current) ownerFunction.set(statement, current);
    switch (statement.type) {
      case "LocalStatement":
        statement.variables.forEach((target, index) => {
          rememberBinding(target, statement.init[index]);
        });
        statement.init.forEach((expression) => {
          visitExpression(expression, current);
        });
        return;
      case "AssignmentStatement":
        statement.variables.forEach((target, index) => {
          if (target.type === "Identifier")
            rememberBinding(target, statement.init[index], true);
        });
        statement.init.forEach((expression) => {
          visitExpression(expression, current);
        });
        return;
      case "FunctionDeclaration": {
        const symbol =
          statement.identifier?.type === "Identifier"
            ? resolved.symbolOf(statement.identifier)
            : undefined;
        const callable = registerFunction(statement, symbol);
        visitBlock(statement.body, callable);
        return;
      }
      case "CallStatement":
        visitExpression(statement.expression, current);
        return;
      case "ReturnStatement":
        statement.arguments.forEach((expression) => {
          visitExpression(expression, current);
        });
        return;
      case "DoStatement":
        visitBlock(statement.body, current);
        return;
      case "WhileStatement":
        visitExpression(statement.condition, current);
        visitBlock(statement.body, current);
        return;
      case "RepeatStatement":
        visitBlock(statement.body, current);
        visitExpression(statement.condition, current);
        return;
      case "IfStatement":
        statement.clauses.forEach((clause) => {
          if (clause.type !== "ElseClause")
            visitExpression(clause.condition, current);
          visitBlock(clause.body, current);
        });
        return;
      case "ForNumericStatement":
        visitExpression(statement.start, current);
        visitExpression(statement.end, current);
        if (statement.step) visitExpression(statement.step, current);
        visitBlock(statement.body, current);
        return;
      case "ForGenericStatement":
        statement.iterators.forEach((expression) => {
          visitExpression(expression, current);
        });
        visitBlock(statement.body, current);
        return;
      case "BreakStatement":
      case "LabelStatement":
      case "GotoStatement":
        return;
    }
  }

  function visitBlock(
    body: readonly Parser.Statement[],
    current?: Callable,
  ): void {
    body.forEach((statement) => {
      visitStatement(statement, current);
    });
  }

  visitBlock(chunk.body);

  const isStableBinding = (symbol: Symbol): boolean => {
    if (conflictingBindings.has(symbol)) return false;
    const writes = facts
      .operationsOfSymbol(symbol)
      .filter((operation) => operation.kind === "write");
    const assignmentOrigin = assignmentOriginBySymbol.get(symbol);
    return assignmentOrigin
      ? writes.length === 1 && writes[0].origin === assignmentOrigin
      : writes.length === 0;
  };
  directFunctionBySymbol.forEach((callable, symbol) => {
    if (isStableBinding(symbol)) functionBySymbol.set(symbol, callable);
  });
  let changed = true;
  while (changed) {
    changed = false;
    aliasSources.forEach((source, target) => {
      if (functionBySymbol.has(target)) return;
      if (!isStableBinding(target) || !isStableBinding(source)) return;
      const callable = functionBySymbol.get(source);
      if (!callable) return;
      functionBySymbol.set(target, callable);
      changed = true;
    });
  }

  const calls: CallSite[] = [];
  const callSiteByExpression = new WeakMap<
    | Parser.CallExpression
    | Parser.TableCallExpression
    | Parser.StringCallExpression,
    CallSite
  >();
  facts.operations.forEach((operation) => {
    if (operation.kind !== "call") return;
    const targets = new Set<Callable>();
    if (
      operation.target.kind === "local" ||
      operation.target.kind === "parameter" ||
      operation.target.kind === "upvalue"
    ) {
      const target = functionBySymbol.get(operation.target.symbol);
      if (target) targets.add(target);
    }
    const site: CallSite = {
      id: calls.length,
      call: operation.call,
      owner: operation.owner,
      caller: ownerFunction.get(operation.owner),
      targets,
      hasUnknownTarget: targets.size === 0,
      ...(operation.call.base.type === "Identifier" &&
      (operation.target.kind === "global" ||
        operation.target.kind === "external")
        ? { externalTargetName: operation.call.base.name }
        : {}),
    };
    calls.push(site);
    callSiteByExpression.set(operation.call, site);
  });

  const sccs = stronglyConnectedComponents(functions, calls);
  return {
    generation: facts.generation,
    functions,
    calls,
    sccs,
    functionOf: (declaration) => functionByDeclaration.get(declaration),
    functionOfSymbol: (symbol) => functionBySymbol.get(symbol),
    callSiteOf: (call) => callSiteByExpression.get(call),
  };
}

function stronglyConnectedComponents(
  functions: readonly Callable[],
  calls: readonly CallSite[],
): CallGraphScc[] {
  const edges = new Map<Callable, Set<Callable>>(
    functions.map((callable) => [callable, new Set()]),
  );
  calls.forEach((call) => {
    if (!call.caller) return;
    const outgoing = edges.get(call.caller);
    call.targets.forEach((target) => outgoing?.add(target));
  });
  let nextIndex = 0;
  const index = new Map<Callable, number>();
  const lowlink = new Map<Callable, number>();
  const stack: Callable[] = [];
  const onStack = new Set<Callable>();
  const components: Callable[][] = [];

  const connect = (callable: Callable): void => {
    index.set(callable, nextIndex);
    lowlink.set(callable, nextIndex++);
    stack.push(callable);
    onStack.add(callable);
    edges.get(callable)?.forEach((target) => {
      if (!index.has(target)) {
        connect(target);
        const callableLowlink = lowlink.get(callable);
        const targetLowlink = lowlink.get(target);
        if (callableLowlink === undefined || targetLowlink === undefined)
          throw new Error("Tarjan lowlink is missing");
        lowlink.set(callable, Math.min(callableLowlink, targetLowlink));
      } else if (onStack.has(target)) {
        const callableLowlink = lowlink.get(callable);
        const targetIndex = index.get(target);
        if (callableLowlink === undefined || targetIndex === undefined)
          throw new Error("Tarjan index is missing");
        lowlink.set(callable, Math.min(callableLowlink, targetIndex));
      }
    });
    if (lowlink.get(callable) !== index.get(callable)) return;
    const component: Callable[] = [];
    while (stack.length > 0) {
      const member = stack.pop();
      if (!member) throw new Error("Tarjan stack underflow");
      onStack.delete(member);
      component.push(member);
      if (member === callable) break;
    }
    components.push(component.sort((left, right) => left.id - right.id));
  };
  functions.forEach((callable) => {
    if (!index.has(callable)) connect(callable);
  });
  return components
    .sort((left, right) => left[0].id - right[0].id)
    .map((component, id) => ({
      id,
      functions: component,
      recursive:
        component.length > 1 ||
        (component.length === 1 &&
          edges.get(component[0])?.has(component[0])) ||
        false,
    }));
}
