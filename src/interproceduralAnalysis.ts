import Parser from "luaparse";
import { CallGraphAnalysis, CallSite, Callable } from "./callGraph";
import {
  EMPTY_OPTIMIZER_TUPLE,
  FiniteOptimizerTuple,
  FiniteOptimizerValue,
  finiteOptimizerTuple,
  finiteOptimizerValue,
  joinOptimizerTuples,
  joinOptimizerValues,
  OptimizerValueAtom,
  unknownOptimizerValue,
  valueAtOptimizerTupleSlot,
} from "./optimizerValueDomain";
import { ResolveResult, Symbol } from "./resolver";
import { luaByteStringKey, luaByteStringOfText } from "./luaString";
import { decodeLuaStringLiteral } from "./luaString";

export type SummaryEffectAccess = "read" | "write";
export interface ParameterFieldEffect {
  readonly parameterIndex: number;
  readonly access: SummaryEffectAccess;
  readonly staticKey?: string;
}

export type ParameterEscapeReason =
  "unknown-call" | "store" | "capture" | "return";

export interface ParameterEscape {
  readonly parameterIndex: number;
  readonly reason: ParameterEscapeReason;
}

export interface ExternalSummaryEffect {
  readonly access: "read" | "write" | "call";
  readonly id: string;
}

export interface AllocationShapeField {
  readonly staticKey: string;
  readonly value: FiniteOptimizerValue;
}

export interface AllocationShape {
  readonly templateId: string;
  readonly fields: readonly AllocationShapeField[];
  readonly unknownKeyWrite: boolean;
}

export interface FunctionSummary {
  readonly callable: Callable;
  readonly returns: FiniteOptimizerTuple;
  readonly effects: readonly ParameterFieldEffect[];
  readonly escapes: readonly ParameterEscape[];
  readonly externalEffects: readonly ExternalSummaryEffect[];
  readonly allocationShapes: readonly AllocationShape[];
  readonly escapedAllocations: readonly string[];
  readonly mayError: boolean;
  readonly mayInvokeMetamethod: boolean;
  readonly converged: boolean;
}

export interface InterproceduralDiagnostic {
  readonly reason:
    | "resolved-call-target"
    | "unknown-call-target"
    | "recursive-scc-converged"
    | "parameter-field-effect"
    | "parameter-escape"
    | "external-contract-used";
  readonly callId?: number;
  readonly functionId?: number;
  readonly sourceRange?: readonly [number, number];
}

export interface InstantiatedCallEffect {
  readonly argumentIndex: number;
  readonly access: SummaryEffectAccess;
  readonly staticKey?: string;
}

export interface ExternalFunctionContract {
  readonly name: string;
  readonly provenance:
    | { readonly kind: "runtime"; readonly profile: string }
    | { readonly kind: "module-contract"; readonly moduleName: string };
  readonly returns: FiniteOptimizerTuple;
  readonly effects?: readonly InstantiatedCallEffect[];
  readonly escapingArguments?: ReadonlySet<number>;
  readonly mayError?: boolean;
  readonly mayInvokeMetamethod?: boolean;
}

export interface InterproceduralOptions {
  readonly externalContracts?: ReadonlyMap<string, ExternalFunctionContract>;
}

export interface InterproceduralAnalysis {
  readonly generation: number;
  readonly callGraph: CallGraphAnalysis;
  readonly summaries: readonly FunctionSummary[];
  readonly diagnostics: readonly InterproceduralDiagnostic[];
  summaryOf(callable: Callable): FunctionSummary;
  symbolicReturnsOf(call: CallSite): FiniteOptimizerTuple;
  returnsOf(call: CallSite): FiniteOptimizerTuple;
  effectsOf(call: CallSite): readonly InstantiatedCallEffect[];
  escapesArgument(call: CallSite, argumentIndex: number): boolean;
  shapeOfAllocation(allocationId: string): AllocationShape | undefined;
}

interface MutableSummary {
  returns?: FiniteOptimizerTuple;
  effects: ParameterFieldEffect[];
  escapes: ParameterEscape[];
  externalEffects: ExternalSummaryEffect[];
  allocationShapes: AllocationShape[];
  escapedAllocations: string[];
  mayError: boolean;
  mayInvokeMetamethod: boolean;
}

interface Evaluation {
  readonly returns: FiniteOptimizerTuple[];
  readonly effects: ParameterFieldEffect[];
  readonly escapes: ParameterEscape[];
  readonly externalEffects: ExternalSummaryEffect[];
  readonly allocationShapes: AllocationShape[];
  readonly escapedAllocations: string[];
  readonly evaluatedCalls: WeakMap<Parser.Expression, EvaluatedCall>;
  mayError: boolean;
  mayInvokeMetamethod: boolean;
}

interface EvaluatedCall {
  readonly actuals: readonly FiniteOptimizerValue[];
  readonly returns: FiniteOptimizerTuple;
}

type Environment = Map<Symbol, FiniteOptimizerValue>;

/**
 * Function summaries are symbolic transfers over parameter atoms. Recursive SCCs start at
 * lattice bottom and grow monotonically, so a recursive edge cannot erase a provable base case.
 */
export function analyzeInterprocedural(
  chunk: Parser.Chunk,
  resolved: ResolveResult,
  callGraph: CallGraphAnalysis,
  options: InterproceduralOptions = {},
): InterproceduralAnalysis {
  const mutable = new Map<Callable, MutableSummary>(
    callGraph.functions.map((callable) => [
      callable,
      {
        returns: undefined,
        effects: [],
        escapes: [],
        externalEffects: [],
        allocationShapes: [],
        escapedAllocations: [],
        mayError: false,
        mayInvokeMetamethod: false,
      },
    ]),
  );
  const callByExpression = new WeakMap<Parser.Expression, CallSite>();
  callGraph.calls.forEach((call) => callByExpression.set(call.call, call));
  const allocationTemplate = new WeakMap<
    Parser.TableConstructorExpression,
    string
  >();
  let nextAllocation = 0;
  const contractOf = (call: CallSite): ExternalFunctionContract | undefined =>
    call.externalTargetName
      ? options.externalContracts?.get(call.externalTargetName)
      : undefined;
  visitExpressions(chunk.body, (expression) => {
    if (expression.type === "TableConstructorExpression")
      allocationTemplate.set(expression, `table:${String(nextAllocation++)}`);
  });

  let changed = true;
  let iterations = 0;
  const iterationLimit = Math.max(1, callGraph.functions.length * 64);
  while (changed) {
    if (iterations++ > iterationLimit)
      throw new Error("Interprocedural finite lattice failed to converge");
    changed = false;
    callGraph.functions.forEach((callable) => {
      const evaluated = evaluateFunction(callable);
      const previous = mutable.get(callable);
      if (!previous) throw new Error("Function summary is missing");
      const next: MutableSummary = {
        returns: joinOptimizerTuples([
          ...(previous.returns ? [previous.returns] : []),
          ...evaluated.returns,
        ]),
        effects: uniqueEffects([...previous.effects, ...evaluated.effects]),
        escapes: uniqueEscapes([...previous.escapes, ...evaluated.escapes]),
        externalEffects: uniqueExternalEffects([
          ...previous.externalEffects,
          ...evaluated.externalEffects,
        ]),
        allocationShapes: joinAllocationShapes([
          ...previous.allocationShapes,
          ...evaluated.allocationShapes,
        ]),
        escapedAllocations: uniqueStrings([
          ...previous.escapedAllocations,
          ...evaluated.escapedAllocations,
        ]),
        mayError: previous.mayError || evaluated.mayError,
        mayInvokeMetamethod:
          previous.mayInvokeMetamethod || evaluated.mayInvokeMetamethod,
      };
      if (summaryKey(previous) !== summaryKey(next)) {
        mutable.set(callable, next);
        changed = true;
      }
    });
  }

  const summaries = callGraph.functions.map((callable) => {
    const summary = mutable.get(callable);
    if (!summary) throw new Error("Function summary is missing");
    return {
      callable,
      ...summary,
      returns: summary.returns ?? EMPTY_OPTIMIZER_TUPLE,
      converged: true,
    } satisfies FunctionSummary;
  });
  const summaryByCallable = new Map(
    summaries.map((summary) => [summary.callable, summary]),
  );
  const diagnostics: InterproceduralDiagnostic[] = [
    ...callGraph.calls.map((call) => ({
      reason: contractOf(call)
        ? ("external-contract-used" as const)
        : call.hasUnknownTarget
          ? ("unknown-call-target" as const)
          : ("resolved-call-target" as const),
      callId: call.id,
      ...sourceRangeOf(call.call),
    })),
    ...callGraph.sccs
      .filter((scc) => scc.recursive)
      .map((scc) => ({
        reason: "recursive-scc-converged" as const,
        functionId: scc.functions[0].id,
        ...sourceRangeOf(scc.functions[0].declaration),
      })),
    ...summaries.flatMap((summary) => [
      ...summary.effects.map(() => ({
        reason: "parameter-field-effect" as const,
        functionId: summary.callable.id,
        ...sourceRangeOf(summary.callable.declaration),
      })),
      ...summary.escapes.map(() => ({
        reason: "parameter-escape" as const,
        functionId: summary.callable.id,
        ...sourceRangeOf(summary.callable.declaration),
      })),
    ]),
  ];

  const returnsOf = (call: CallSite): FiniteOptimizerTuple => {
    const actuals = actualValues(call.call, new Map());
    const instantiated = [...call.targets].map((target) =>
      instantiateTuple(
        safeSummaryReturns(summaryByCallable.get(target)),
        actuals,
        call,
      ),
    );
    const contract = contractOf(call);
    if (contract)
      instantiated.push(instantiateTuple(contract.returns, actuals, call));
    else if (call.hasUnknownTarget)
      instantiated.push(
        finiteOptimizerTuple([], {
          kind: "unknown",
          reasons: ["unknown-call-target"],
        }),
      );
    return instantiated.length > 0
      ? joinOptimizerTuples(instantiated)
      : finiteOptimizerTuple([], {
          kind: "unknown",
          reasons: ["unresolved-call-target"],
        });
  };

  const symbolicReturnsOf = (call: CallSite): FiniteOptimizerTuple => {
    const tuples = [...call.targets].map((target) =>
      safeSummaryReturns(summaryByCallable.get(target)),
    );
    const contract = contractOf(call);
    if (contract) tuples.push(contract.returns);
    else if (call.hasUnknownTarget)
      tuples.push(
        finiteOptimizerTuple([], {
          kind: "unknown",
          reasons: ["unknown-call-target"],
        }),
      );
    return tuples.length > 0
      ? joinOptimizerTuples(tuples)
      : EMPTY_OPTIMIZER_TUPLE;
  };

  return {
    generation: callGraph.generation,
    callGraph,
    summaries,
    diagnostics,
    summaryOf: (callable) => {
      const summary = summaryByCallable.get(callable);
      if (!summary) throw new Error("Function summary is missing");
      return summary;
    },
    symbolicReturnsOf,
    returnsOf,
    effectsOf: (call) => {
      const effects = [...call.targets].flatMap(
        (target) => summaryByCallable.get(target)?.effects ?? [],
      );
      return uniqueInstantiatedEffects([
        ...effects.map((effect) => ({
          argumentIndex: effect.parameterIndex,
          access: effect.access,
          ...(effect.staticKey === undefined
            ? {}
            : { staticKey: effect.staticKey }),
        })),
        ...(contractOf(call)?.effects ?? []),
      ]);
    },
    escapesArgument: (call, argumentIndex) =>
      (call.hasUnknownTarget &&
        (contractOf(call)
          ? (contractOf(call)?.escapingArguments?.has(argumentIndex) ?? false)
          : true)) ||
      [...call.targets].some((target) =>
        (summaryByCallable.get(target)?.escapes ?? []).some(
          (escape) =>
            escape.parameterIndex === argumentIndex &&
            escape.reason !== "return",
        ),
      ),
    shapeOfAllocation: (allocationId) => {
      const templateId = allocationId.split("/").at(-1);
      return summaries
        .flatMap((summary) => summary.allocationShapes)
        .find((shape) => shape.templateId === templateId);
    },
  };

  function evaluateFunction(callable: Callable): Evaluation {
    const evaluation: Evaluation = {
      returns: [],
      effects: [],
      escapes: [],
      externalEffects: [],
      allocationShapes: [],
      escapedAllocations: [],
      evaluatedCalls: new WeakMap(),
      mayError: false,
      mayInvokeMetamethod: false,
    };
    const environment: Environment = new Map();
    callable.parameters.forEach((parameter, index) =>
      environment.set(
        parameter,
        finiteOptimizerValue([{ kind: "parameter", index }]),
      ),
    );
    evaluateBlock(callable.declaration.body, environment, evaluation);
    if (evaluation.returns.length === 0)
      evaluation.returns.push(EMPTY_OPTIMIZER_TUPLE);
    return evaluation;
  }

  function evaluateBlock(
    body: readonly Parser.Statement[],
    environment: Environment,
    evaluation: Evaluation,
  ): void {
    body.forEach((statement) => {
      switch (statement.type) {
        case "LocalStatement":
        case "AssignmentStatement": {
          const values = valuesOfExpressionList(
            statement.init,
            environment,
            evaluation,
            statement.variables.length,
          );
          statement.variables.forEach((target, index) => {
            if (target.type === "Identifier") {
              const symbol = resolved.symbolOf(target);
              if (
                symbol &&
                (statement.type === "LocalStatement" || environment.has(symbol))
              )
                environment.set(
                  symbol,
                  values[index] ?? finiteOptimizerValue([{ kind: "nil" }]),
                );
              else {
                recordStoreEscapes(
                  values[index] ?? finiteOptimizerValue([{ kind: "nil" }]),
                  evaluation,
                );
                evaluation.externalEffects.push({
                  access: "write",
                  id: symbol ? `upvalue:${String(symbol.id)}` : target.name,
                });
              }
            } else {
              recordStoreEscapes(
                values[index] ?? finiteOptimizerValue([{ kind: "nil" }]),
                evaluation,
              );
              recordTableEffect(target, "write", environment, evaluation);
            }
          });
          return;
        }
        case "ReturnStatement": {
          const tuple = tupleOfExpressionList(
            statement.arguments,
            environment,
            evaluation,
          );
          tuple.prefix.forEach((value) => {
            parameterIndexes(value).forEach((parameterIndex) =>
              evaluation.escapes.push({
                parameterIndex,
                reason: "return",
              }),
            );
          });
          evaluation.returns.push(tuple);
          return;
        }
        case "CallStatement":
          valueOf(statement.expression, environment, evaluation);
          return;
        case "IfStatement": {
          const branches = statement.clauses.map((clause) => {
            if (clause.type !== "ElseClause")
              valueOf(clause.condition, environment, evaluation);
            const branch = new Map(environment);
            evaluateBlock(clause.body, branch, evaluation);
            return branch;
          });
          if (!statement.clauses.some((clause) => clause.type === "ElseClause"))
            branches.push(new Map(environment));
          joinEnvironments(environment, branches);
          return;
        }
        case "DoStatement": {
          const block = new Map(environment);
          evaluateBlock(statement.body, block, evaluation);
          projectOuterEnvironment(environment, block);
          return;
        }
        case "WhileStatement":
        case "RepeatStatement": {
          valueOf(statement.condition, environment, evaluation);
          const loop = new Map(environment);
          evaluateBlock(statement.body, loop, evaluation);
          joinEnvironments(environment, [environment, loop]);
          return;
        }
        case "ForNumericStatement": {
          valueOf(statement.start, environment, evaluation);
          valueOf(statement.end, environment, evaluation);
          if (statement.step) valueOf(statement.step, environment, evaluation);
          const loop = new Map(environment);
          evaluateBlock(statement.body, loop, evaluation);
          joinEnvironments(environment, [new Map(environment), loop]);
          return;
        }
        case "ForGenericStatement": {
          valuesOfExpressionList(
            statement.iterators,
            environment,
            evaluation,
            statement.variables.length,
          );
          const loop = new Map(environment);
          evaluateBlock(statement.body, loop, evaluation);
          joinEnvironments(environment, [new Map(environment), loop]);
          return;
        }
        case "FunctionDeclaration":
          recordCaptures(statement, environment, evaluation);
          return;
        case "BreakStatement":
        case "LabelStatement":
        case "GotoStatement":
          return;
      }
    });
  }

  function valueOf(
    expression: Parser.Expression | undefined,
    environment: Environment,
    evaluation: Evaluation,
  ): FiniteOptimizerValue {
    if (!expression) return finiteOptimizerValue([{ kind: "nil" }]);
    switch (expression.type) {
      case "NilLiteral":
        return finiteOptimizerValue([{ kind: "nil" }]);
      case "BooleanLiteral":
        return finiteOptimizerValue([
          { kind: "boolean", value: expression.value },
        ]);
      case "NumericLiteral":
        return finiteOptimizerValue([{ kind: "number", raw: expression.raw }]);
      case "StringLiteral":
        return finiteOptimizerValue([
          { kind: "string", value: expression.value },
        ]);
      case "Identifier": {
        const symbol = resolved.symbolOf(expression);
        const knownFunction = symbol
          ? callGraph.functionOfSymbol(symbol)
          : undefined;
        if (knownFunction)
          return finiteOptimizerValue([
            { kind: "function", id: String(knownFunction.id) },
          ]);
        return symbol
          ? (environment.get(symbol) ??
              unknownOptimizerValue("symbol-value-unavailable"))
          : (evaluation.externalEffects.push({
              access: "read",
              id: expression.name,
            }),
            finiteOptimizerValue(
              [{ kind: "external", id: expression.name }],
              ["external-value"],
            ));
      }
      case "FunctionDeclaration": {
        const target = callGraph.functionOf(expression);
        recordCaptures(expression, environment, evaluation);
        return target
          ? finiteOptimizerValue([{ kind: "function", id: String(target.id) }])
          : unknownOptimizerValue("function-unindexed");
      }
      case "TableConstructorExpression": {
        const fields: AllocationShapeField[] = [];
        let unknownKeyWrite = false;
        let arrayIndex = 1;
        expression.fields.forEach((field) => {
          let staticKey: string | undefined;
          if (field.type === "TableKeyString") {
            staticKey = luaByteStringKey(luaByteStringOfText(field.key.name));
          } else if (field.type === "TableKey") {
            if (field.key.type === "StringLiteral") {
              const decoded = decodeLuaStringLiteral(field.key);
              if (decoded.ok) staticKey = luaByteStringKey(decoded.value);
            }
            valueOf(field.key, environment, evaluation);
          } else {
            staticKey = `number:${String(arrayIndex++)}`;
          }
          const fieldValue = valueOf(field.value, environment, evaluation);
          if (staticKey === undefined) unknownKeyWrite = true;
          else fields.push({ staticKey, value: fieldValue });
        });
        const templateId =
          allocationTemplate.get(expression) ?? "table:unindexed";
        evaluation.allocationShapes.push({
          templateId,
          fields,
          unknownKeyWrite,
        });
        return finiteOptimizerValue([
          {
            kind: "allocation",
            allocationKind: "table",
            id: templateId,
          },
        ]);
      }
      case "MemberExpression":
      case "IndexExpression":
        recordTableEffect(expression, "read", environment, evaluation);
        evaluation.mayError = true;
        evaluation.mayInvokeMetamethod = true;
        return unknownOptimizerValue("table-read-value");
      case "CallExpression":
      case "TableCallExpression":
      case "StringCallExpression": {
        const cached = evaluation.evaluatedCalls.get(expression);
        if (cached) return valueAtOptimizerTupleSlot(cached.returns, 0);
        const call = callByExpression.get(expression);
        const actuals = actualValues(expression, environment, evaluation);
        const contract = call ? contractOf(call) : undefined;
        if (!call || (call.hasUnknownTarget && !contract)) {
          evaluation.externalEffects.push({
            access: "call",
            id:
              expression.base.type === "Identifier"
                ? expression.base.name
                : "unknown-call",
          });
          actuals.forEach((actual) => {
            recordStoreEscapes(actual, evaluation, "unknown-call");
            parameterIndexes(actual).forEach((parameterIndex) =>
              evaluation.escapes.push({
                parameterIndex,
                reason: "unknown-call",
              }),
            );
          });
          evaluation.mayError = true;
          evaluation.mayInvokeMetamethod = true;
        }
        if (!call) return unknownOptimizerValue("call-unindexed");
        const tuples = [...call.targets].flatMap((target) => {
          const targetSummary = mutable.get(target);
          if (!targetSummary) throw new Error("Function summary is missing");
          targetSummary.effects.forEach((effect) => {
            parameterIndexes(actuals[effect.parameterIndex]).forEach(
              (parameterIndex) =>
                evaluation.effects.push({
                  parameterIndex,
                  access: effect.access,
                  ...(effect.staticKey === undefined
                    ? {}
                    : { staticKey: effect.staticKey }),
                }),
            );
          });
          targetSummary.escapes.forEach((escape) => {
            if (escape.reason !== "return")
              allocationIds(actuals[escape.parameterIndex]).forEach((id) =>
                evaluation.escapedAllocations.push(id),
              );
            parameterIndexes(actuals[escape.parameterIndex]).forEach(
              (parameterIndex) =>
                evaluation.escapes.push({
                  parameterIndex,
                  reason: escape.reason,
                }),
            );
          });
          evaluation.externalEffects.push(...targetSummary.externalEffects);
          evaluation.mayError ||= targetSummary.mayError;
          evaluation.mayInvokeMetamethod ||= targetSummary.mayInvokeMetamethod;
          return targetSummary.returns
            ? [
                instantiateTuple(
                  rejectEscapedAllocations(
                    targetSummary.returns,
                    targetSummary.escapedAllocations,
                  ),
                  actuals,
                  call,
                ),
              ]
            : [];
        });
        if (contract) {
          evaluation.mayError ||= contract.mayError ?? false;
          evaluation.mayInvokeMetamethod ||=
            contract.mayInvokeMetamethod ?? false;
          (contract.effects ?? []).forEach((effect) => {
            parameterIndexes(actuals[effect.argumentIndex]).forEach(
              (parameterIndex) =>
                evaluation.effects.push({
                  parameterIndex,
                  access: effect.access,
                  ...(effect.staticKey === undefined
                    ? {}
                    : { staticKey: effect.staticKey }),
                }),
            );
          });
          contract.escapingArguments?.forEach((argumentIndex) => {
            const actual = actuals.at(argumentIndex);
            if (actual) recordStoreEscapes(actual, evaluation, "unknown-call");
            parameterIndexes(actual).forEach((parameterIndex) =>
              evaluation.escapes.push({
                parameterIndex,
                reason: "unknown-call",
              }),
            );
          });
          tuples.push(instantiateTuple(contract.returns, actuals, call));
        } else if (call.hasUnknownTarget)
          tuples.push(
            finiteOptimizerTuple([], {
              kind: "unknown",
              reasons: ["unknown-call-target"],
            }),
          );
        const returns =
          tuples.length > 0
            ? joinOptimizerTuples(tuples)
            : call.targets.size > 0
              ? finiteOptimizerTuple([], {
                  kind: "unknown",
                  reasons: ["recursive-summary-bottom"],
                })
              : EMPTY_OPTIMIZER_TUPLE;
        evaluation.evaluatedCalls.set(expression, { actuals, returns });
        return valueAtOptimizerTupleSlot(returns, 0);
      }
      case "BinaryExpression":
      case "LogicalExpression":
        valueOf(expression.left, environment, evaluation);
        valueOf(expression.right, environment, evaluation);
        evaluation.mayError = true;
        evaluation.mayInvokeMetamethod = true;
        return unknownOptimizerValue("computed-expression");
      case "UnaryExpression":
        valueOf(expression.argument, environment, evaluation);
        evaluation.mayError = true;
        evaluation.mayInvokeMetamethod = true;
        return unknownOptimizerValue("computed-expression");
      case "VarargLiteral":
        return unknownOptimizerValue("vararg-value");
    }
  }

  function actualValues(
    call:
      | Parser.CallExpression
      | Parser.TableCallExpression
      | Parser.StringCallExpression,
    environment: Environment,
    evaluation?: Evaluation,
  ): FiniteOptimizerValue[] {
    const sink =
      evaluation ??
      ({
        returns: [],
        effects: [],
        escapes: [],
        externalEffects: [],
        allocationShapes: [],
        escapedAllocations: [],
        evaluatedCalls: new WeakMap(),
        mayError: false,
        mayInvokeMetamethod: false,
      } satisfies Evaluation);
    const explicit =
      call.type === "CallExpression"
        ? call.arguments
        : [
            call.type === "TableCallExpression"
              ? call.arguments
              : call.argument,
          ];
    const receiver =
      call.base.type === "MemberExpression" && call.base.indexer === ":"
        ? [call.base.base]
        : [];
    return valuesOfExpressionList(
      [...receiver, ...explicit],
      environment,
      sink,
      Number.POSITIVE_INFINITY,
    );
  }

  function valuesOfExpressionList(
    expressions: readonly Parser.Expression[],
    environment: Environment,
    evaluation: Evaluation,
    count: number,
  ): FiniteOptimizerValue[] {
    const tuple = tupleOfExpressionList(expressions, environment, evaluation);
    const available = Number.isFinite(count)
      ? count
      : Math.max(expressions.length, tuple.prefix.length);
    return Array.from({ length: available }, (_, index) =>
      valueAtOptimizerTupleSlot(tuple, index),
    );
  }

  function tupleOfExpressionList(
    expressions: readonly Parser.Expression[],
    environment: Environment,
    evaluation: Evaluation,
  ): FiniteOptimizerTuple {
    if (expressions.length === 0) return EMPTY_OPTIMIZER_TUPLE;
    const leading = expressions
      .slice(0, -1)
      .map((expression) => valueOf(expression, environment, evaluation));
    const last = expressions.at(-1);
    if (!last) return finiteOptimizerTuple(leading);
    const single = valueOf(last, environment, evaluation);
    const tail = tupleOfLastExpression(last, environment, evaluation, single);
    return finiteOptimizerTuple([...leading, ...tail.prefix], tail.tail);
  }

  function tupleOfLastExpression(
    expression: Parser.Expression,
    environment: Environment,
    evaluation: Evaluation,
    singleValue: FiniteOptimizerValue,
  ): FiniteOptimizerTuple {
    if (expression.type === "VarargLiteral") {
      return finiteOptimizerTuple([], {
        kind: "unknown",
        reasons: ["vararg-tail"],
      });
    }
    if (
      expression.type !== "CallExpression" &&
      expression.type !== "TableCallExpression" &&
      expression.type !== "StringCallExpression"
    )
      return finiteOptimizerTuple([singleValue]);
    const call = callByExpression.get(expression);
    if (!call)
      return finiteOptimizerTuple([], {
        kind: "unknown",
        reasons: ["call-unindexed"],
      });
    valueOf(expression, environment, evaluation);
    const actuals = evaluation.evaluatedCalls.get(expression)?.actuals;
    if (!actuals)
      return finiteOptimizerTuple([], {
        kind: "unknown",
        reasons: ["call-evaluation-missing"],
      });
    const tuples = [...call.targets].flatMap((target) => {
      const returns = mutable.get(target)?.returns;
      return returns
        ? [
            instantiateTuple(
              rejectEscapedAllocations(
                returns,
                mutable.get(target)?.escapedAllocations ?? [],
              ),
              actuals,
              call,
            ),
          ]
        : [];
    });
    const contract = contractOf(call);
    if (contract)
      tuples.push(instantiateTuple(contract.returns, actuals, call));
    else if (call.hasUnknownTarget)
      tuples.push(
        finiteOptimizerTuple([], {
          kind: "unknown",
          reasons: ["unknown-call-target"],
        }),
      );
    return tuples.length > 0
      ? joinOptimizerTuples(tuples)
      : call.targets.size > 0
        ? finiteOptimizerTuple([], {
            kind: "unknown",
            reasons: ["recursive-summary-bottom"],
          })
        : EMPTY_OPTIMIZER_TUPLE;
  }

  function recordTableEffect(
    expression: Parser.MemberExpression | Parser.IndexExpression,
    access: SummaryEffectAccess,
    environment: Environment,
    evaluation: Evaluation,
  ): void {
    const base = valueOf(expression.base, environment, evaluation);
    const staticKey =
      expression.type === "MemberExpression"
        ? luaByteStringKey(luaByteStringOfText(expression.identifier.name))
        : expression.index.type === "StringLiteral"
          ? (() => {
              const decoded = decodeLuaStringLiteral(expression.index);
              return decoded.ok ? luaByteStringKey(decoded.value) : undefined;
            })()
          : undefined;
    parameterIndexes(base).forEach((parameterIndex) =>
      evaluation.effects.push({
        parameterIndex,
        access,
        ...(staticKey === undefined ? {} : { staticKey }),
      }),
    );
    if (expression.type === "IndexExpression")
      valueOf(expression.index, environment, evaluation);
  }

  function recordCaptures(
    declaration: Parser.FunctionDeclaration,
    environment: Environment,
    evaluation: Evaluation,
  ): void {
    visitExpressions(declaration.body, (expression) => {
      if (expression.type !== "Identifier") return;
      const symbol = resolved.symbolOf(expression);
      const value = symbol ? environment.get(symbol) : undefined;
      parameterIndexes(value).forEach((parameterIndex) =>
        evaluation.escapes.push({ parameterIndex, reason: "capture" }),
      );
    });
  }
}

function instantiateTuple(
  tuple: FiniteOptimizerTuple,
  actuals: readonly FiniteOptimizerValue[],
  call: CallSite,
): FiniteOptimizerTuple {
  const instantiate = (value: FiniteOptimizerValue): FiniteOptimizerValue =>
    joinOptimizerValues([
      finiteOptimizerValue(
        value.atoms.flatMap((atom): OptimizerValueAtom[] => {
          if (atom.kind === "parameter")
            return [...(actuals[atom.index]?.atoms ?? [])];
          if (atom.kind === "allocation")
            return [{ ...atom, id: `call:${String(call.id)}/${atom.id}` }];
          return [atom];
        }),
        value.unknownReasons,
      ),
      ...value.atoms
        .filter(
          (atom): atom is Extract<OptimizerValueAtom, { kind: "parameter" }> =>
            atom.kind === "parameter",
        )
        .map(
          (atom) =>
            actuals[atom.index] ?? unknownOptimizerValue("missing-argument"),
        ),
    ]);
  return finiteOptimizerTuple(
    tuple.prefix.map(instantiate),
    tuple.tail.kind === "vararg"
      ? { kind: "vararg", value: instantiate(tuple.tail.value) }
      : tuple.tail,
  );
}

function safeSummaryReturns(
  summary: FunctionSummary | undefined,
): FiniteOptimizerTuple {
  return summary
    ? rejectEscapedAllocations(summary.returns, summary.escapedAllocations)
    : EMPTY_OPTIMIZER_TUPLE;
}

function rejectEscapedAllocations(
  tuple: FiniteOptimizerTuple,
  escapedAllocations: readonly string[],
): FiniteOptimizerTuple {
  if (escapedAllocations.length === 0) return tuple;
  const escaped = new Set(escapedAllocations);
  const reject = (value: FiniteOptimizerValue): FiniteOptimizerValue => {
    const retained = value.atoms.filter(
      (atom) => atom.kind !== "allocation" || !escaped.has(atom.id),
    );
    return finiteOptimizerValue(
      retained,
      retained.length === value.atoms.length
        ? value.unknownReasons
        : [...value.unknownReasons, "escaped-allocation"],
    );
  };
  return finiteOptimizerTuple(
    tuple.prefix.map(reject),
    tuple.tail.kind === "vararg"
      ? { kind: "vararg", value: reject(tuple.tail.value) }
      : tuple.tail,
  );
}

function parameterIndexes(value: FiniteOptimizerValue | undefined): number[] {
  return value
    ? value.atoms.flatMap((atom) =>
        atom.kind === "parameter" ? [atom.index] : [],
      )
    : [];
}

function recordStoreEscapes(
  value: FiniteOptimizerValue,
  evaluation: Evaluation,
  parameterReason: ParameterEscapeReason = "store",
): void {
  parameterIndexes(value).forEach((parameterIndex) =>
    evaluation.escapes.push({ parameterIndex, reason: parameterReason }),
  );
  allocationIds(value).forEach((id) => evaluation.escapedAllocations.push(id));
}

function allocationIds(value: FiniteOptimizerValue | undefined): string[] {
  return value
    ? value.atoms.flatMap((atom) =>
        atom.kind === "allocation" ? [atom.id] : [],
      )
    : [];
}

function projectOuterEnvironment(
  target: Environment,
  source: Environment,
): void {
  [...target.keys()].forEach((symbol) => {
    const value = source.get(symbol);
    if (value) target.set(symbol, value);
  });
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function joinEnvironments(
  target: Environment,
  branches: readonly Environment[],
): void {
  const symbols = new Set(branches.flatMap((branch) => [...branch.keys()]));
  symbols.forEach((symbol) =>
    target.set(
      symbol,
      joinOptimizerValues(
        branches.map(
          (branch) =>
            branch.get(symbol) ?? unknownOptimizerValue("branch-local"),
        ),
      ),
    ),
  );
}

function uniqueEffects(
  effects: readonly ParameterFieldEffect[],
): ParameterFieldEffect[] {
  const byKey = new Map<string, ParameterFieldEffect>();
  effects.forEach((effect) =>
    byKey.set(
      `${String(effect.parameterIndex)}:${effect.access}:${effect.staticKey ?? "*"}`,
      effect,
    ),
  );
  return [...byKey.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, effect]) => effect);
}

function uniqueInstantiatedEffects(
  effects: readonly InstantiatedCallEffect[],
): InstantiatedCallEffect[] {
  const byKey = new Map<string, InstantiatedCallEffect>();
  effects.forEach((effect) =>
    byKey.set(
      `${String(effect.argumentIndex)}:${effect.access}:${effect.staticKey ?? "*"}`,
      effect,
    ),
  );
  return [...byKey.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, effect]) => effect);
}

function uniqueEscapes(escapes: readonly ParameterEscape[]): ParameterEscape[] {
  const byKey = new Map<string, ParameterEscape>();
  escapes.forEach((escape) =>
    byKey.set(`${String(escape.parameterIndex)}:${escape.reason}`, escape),
  );
  return [...byKey.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, escape]) => escape);
}

function uniqueExternalEffects(
  effects: readonly ExternalSummaryEffect[],
): ExternalSummaryEffect[] {
  const byKey = new Map<string, ExternalSummaryEffect>();
  effects.forEach((effect) =>
    byKey.set(`${effect.access}:${effect.id}`, effect),
  );
  return [...byKey.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, effect]) => effect);
}

function joinAllocationShapes(
  shapes: readonly AllocationShape[],
): AllocationShape[] {
  const byTemplate = new Map<string, AllocationShape[]>();
  shapes.forEach((shape) => {
    const entries = byTemplate.get(shape.templateId) ?? [];
    entries.push(shape);
    byTemplate.set(shape.templateId, entries);
  });
  return [...byTemplate.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([templateId, alternatives]) => {
      const keys = new Set(
        alternatives.flatMap((shape) =>
          shape.fields.map((field) => field.staticKey),
        ),
      );
      const fields = [...keys].sort().flatMap((staticKey) => {
        const values = alternatives.flatMap((shape) => {
          const field = shape.fields.find(
            (candidate) => candidate.staticKey === staticKey,
          );
          return field ? [field.value] : [];
        });
        return values.length === alternatives.length
          ? [{ staticKey, value: joinOptimizerValues(values) }]
          : [];
      });
      return {
        templateId,
        fields,
        unknownKeyWrite: alternatives.some((shape) => shape.unknownKeyWrite),
      };
    });
}

function summaryKey(summary: MutableSummary): string {
  return JSON.stringify(summary);
}

function sourceRangeOf(node: Parser.Node): {
  readonly sourceRange?: readonly [number, number];
} {
  const range = (node as { range?: [number, number] }).range;
  return range ? { sourceRange: range } : {};
}

function visitExpressions(
  body: readonly Parser.Statement[],
  visit: (expression: Parser.Expression) => void,
): void {
  const expression = (value: Parser.Expression): void => {
    visit(value);
    switch (value.type) {
      case "FunctionDeclaration":
        visitExpressions(value.body, visit);
        return;
      case "CallExpression":
        expression(value.base);
        value.arguments.forEach(expression);
        return;
      case "TableCallExpression":
        expression(value.base);
        expression(value.arguments);
        return;
      case "StringCallExpression":
        expression(value.base);
        expression(value.argument);
        return;
      case "BinaryExpression":
      case "LogicalExpression":
        expression(value.left);
        expression(value.right);
        return;
      case "UnaryExpression":
        expression(value.argument);
        return;
      case "MemberExpression":
        expression(value.base);
        return;
      case "IndexExpression":
        expression(value.base);
        expression(value.index);
        return;
      case "TableConstructorExpression":
        value.fields.forEach((field) => {
          if (field.type === "TableKey") expression(field.key);
          expression(field.value);
        });
        return;
      default:
        return;
    }
  };
  body.forEach((statement) => {
    switch (statement.type) {
      case "LocalStatement":
      case "AssignmentStatement":
        statement.init.forEach(expression);
        return;
      case "CallStatement":
        expression(statement.expression);
        return;
      case "ReturnStatement":
        statement.arguments.forEach(expression);
        return;
      case "FunctionDeclaration":
        visit(statement);
        visitExpressions(statement.body, visit);
        return;
      case "DoStatement":
      case "WhileStatement":
      case "RepeatStatement":
        if ("condition" in statement) expression(statement.condition);
        visitExpressions(statement.body, visit);
        return;
      case "IfStatement":
        statement.clauses.forEach((clause) => {
          if (clause.type !== "ElseClause") expression(clause.condition);
          visitExpressions(clause.body, visit);
        });
        return;
      case "ForNumericStatement":
        expression(statement.start);
        expression(statement.end);
        if (statement.step) expression(statement.step);
        visitExpressions(statement.body, visit);
        return;
      case "ForGenericStatement":
        statement.iterators.forEach(expression);
        visitExpressions(statement.body, visit);
        return;
      default:
        return;
    }
  });
}
