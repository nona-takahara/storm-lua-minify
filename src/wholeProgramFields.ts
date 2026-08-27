import Parser from "luaparse";
import { walkBlockDeep } from "./astWalk";
import {
  CallGraphAnalysis,
  CallSite,
  Callable,
  combineCallGraphs,
} from "./callGraph";
import { SourceMetadata } from "./sourceMetadata";
import { EmmyLuaDirective } from "./sourceMetadata";
import { Symbol } from "./resolver";
import { luaByteStringKey, luaByteStringOfText } from "./luaString";
import {
  ProgramObjectIdentity,
  ResolvedConstructorCall,
  WholeProgramObjectAnalysis,
} from "./wholeProgramObjects";

export type FieldFactValue =
  | { readonly kind: "nil" }
  | { readonly kind: "boolean"; readonly value: boolean }
  | { readonly kind: "number"; readonly raw: string }
  | { readonly kind: "string"; readonly raw: string }
  | { readonly kind: "function"; readonly callable: Callable }
  | {
      readonly kind: "empty-table";
      readonly origin: Parser.TableConstructorExpression;
    };

export interface FieldFactEvidence {
  readonly kind: "code" | "annotation";
  readonly moduleName: string;
  readonly sourceRange?: readonly [number, number];
  readonly assumption?: "annotations";
}

export type FieldInvalidationReason =
  | "field-reassignment"
  | "alias-escape"
  | "unknown-call"
  | "dynamic-key"
  | "metatable-mutation"
  | "contradictory-annotation"
  | "multiple-values";

export interface ProgramFieldFact {
  readonly object: ProgramObjectIdentity;
  readonly field: string;
  readonly value?: FieldFactValue;
  readonly evidence: readonly FieldFactEvidence[];
  readonly invalidationReasons: ReadonlySet<FieldInvalidationReason>;
  readonly initializer?: Parser.AssignmentStatement;
}

export interface WholeProgramFieldDiagnostic {
  readonly moduleName: string;
  readonly reason: "field-fact" | FieldInvalidationReason;
  readonly sourceRange?: readonly [number, number];
}

export interface WholeProgramFieldAnalysis {
  readonly generation: number;
  /** #83 method edges plus stable function-valued field callback edges. */
  readonly callGraph: CallGraphAnalysis;
  readonly resolvedCallbacks: readonly ResolvedFieldCallbackCall[];
  readonly facts: readonly ProgramFieldFact[];
  readonly diagnostics: readonly WholeProgramFieldDiagnostic[];
  readonly annotationFacts: readonly AnnotationFact[];
  factOf(
    object: ProgramObjectIdentity,
    field: string,
  ): ProgramFieldFact | undefined;
  factOfRead(read: Parser.MemberExpression): ProgramFieldFact | undefined;
}

export interface ResolvedFieldCallbackCall {
  readonly call: CallSite;
  readonly field: ProgramFieldFact;
  readonly target: Callable;
}

export interface AnnotationFact {
  readonly moduleName: string;
  readonly directive: EmmyLuaDirective;
  readonly symbol?: Symbol;
  readonly object?: ProgramObjectIdentity;
  readonly field?: string;
  readonly authorized: boolean;
}

export interface WholeProgramFieldRewriteResult {
  readonly changed: boolean;
  readonly replacedReads: number;
  readonly removedInitializers: number;
  readonly preservedEffects: number;
}

interface MutableFact {
  readonly object: ProgramObjectIdentity;
  readonly field: string;
  value?: FieldFactValue;
  readonly evidence: FieldFactEvidence[];
  readonly invalidationReasons: Set<FieldInvalidationReason>;
  initializer?: Parser.AssignmentStatement;
}

export interface WholeProgramFieldOptions {
  readonly trustAnnotations?: boolean;
  readonly metadataOf?: (moduleName: string) => SourceMetadata | undefined;
}

export function analyzeWholeProgramFields(
  objects: WholeProgramObjectAnalysis,
  options: WholeProgramFieldOptions = {},
): WholeProgramFieldAnalysis {
  const facts = new Map<string, MutableFact>();
  const annotationFacts: AnnotationFact[] = [];
  const constructorWrites = new WeakSet<Parser.AssignmentStatement>();
  const constructorsByTarget = new Map<Callable, ResolvedConstructorCall[]>();
  objects.resolvedConstructors.forEach((constructor) => {
    const calls = constructorsByTarget.get(constructor.target) ?? [];
    calls.push(constructor);
    constructorsByTarget.set(constructor.target, calls);
  });

  const factFor = (
    object: ProgramObjectIdentity,
    field: string,
  ): MutableFact => {
    const key = `${object.id}\0${field}`;
    const existing = facts.get(key);
    if (existing) return existing;
    const fact: MutableFact = {
      object,
      field,
      evidence: [],
      invalidationReasons: new Set(),
    };
    facts.set(key, fact);
    return fact;
  };

  objects.modules.forEach((module) => {
    const metadata = options.metadataOf?.(module.name);
    if (!metadata) return;
    walkBlockDeep(module.chunk.body, {
      onStatement: (statement) => {
        const directives = metadata.emmyLuaOf(statement);
        if (directives.length === 0) return;
        if (statement.type !== "LocalStatement") {
          directives.forEach((directive) =>
            annotationFacts.push({
              moduleName: module.name,
              directive,
              authorized: options.trustAnnotations === true,
            }),
          );
          return;
        }
        statement.variables.forEach((identifier, index) => {
          const symbol = module.resolved.symbolOf(identifier);
          const expression = statement.init.at(index);
          const object = expression ? objects.objectOf(expression) : undefined;
          directives.forEach((directive) => {
            const field =
              directive.kind === "field" ? directive.name : undefined;
            annotationFacts.push({
              moduleName: module.name,
              directive,
              ...(symbol ? { symbol } : {}),
              ...(object ? { object } : {}),
              ...(field ? { field } : {}),
              authorized: options.trustAnnotations === true,
            });
            if (
              object &&
              directive.kind === "field" &&
              options.trustAnnotations === true
            ) {
              const value = singletonAnnotationValue(directive.valueType);
              if (!value) return;
              const fact = factFor(object, directive.name);
              fact.value = value;
              fact.evidence.push({
                kind: "annotation",
                moduleName: module.name,
                ...rangeOf(directive.comment),
                assumption: "annotations",
              });
            }
          });
        });
      },
    });
  });

  constructorsByTarget.forEach((calls, target) => {
    const module = objects.modules.find((candidate) =>
      candidate.analysis.callGraph.functions.includes(target),
    );
    if (!module) return;
    const writes: {
      statement: Parser.AssignmentStatement;
      field: string;
      value: Parser.Expression;
    }[] = [];
    target.declaration.body.forEach((node) => {
      if (node.type !== "AssignmentStatement") return;
      node.variables.forEach((variable, index) => {
        const value = node.init.at(index);
        if (
          value &&
          variable.type === "MemberExpression" &&
          variable.base.type === "Identifier" &&
          module.resolved.symbolOf(variable.base) === calls[0].returnedSymbol
        ) {
          writes.push({
            statement: node,
            field: variable.identifier.name,
            value,
          });
          constructorWrites.add(node);
        }
      });
    });
    const countByField = new Map<string, number>();
    writes.forEach((write) =>
      countByField.set(write.field, (countByField.get(write.field) ?? 0) + 1),
    );
    calls.forEach((constructor) => {
      writes.forEach((write) => {
        const fact = factFor(constructor.object, write.field);
        fact.initializer = write.statement;
        if ((countByField.get(write.field) ?? 0) > 1) {
          fact.invalidationReasons.add("field-reassignment");
          return;
        }
        const value = valueAtCall(
          write.value,
          target,
          constructor,
          module,
          objects.modules.find(
            (candidate) => candidate.name === constructor.moduleName,
          ) ?? module,
          options,
        );
        if (!value) return;
        fact.value = value.value;
        fact.evidence.push(value.evidence);
        if (value.annotationEvidence)
          fact.evidence.push(value.annotationEvidence);
        if (value.contradiction)
          fact.invalidationReasons.add("contradictory-annotation");
      });
    });
  });

  // A derived factory allocation receives the base instance fields through the
  // same provenance edge #83 uses for inherited methods.
  let inherited = true;
  while (inherited) {
    inherited = false;
    objects.objects.forEach((object) => {
      object.sources.forEach((source) => {
        [...facts.values()]
          .filter((fact) => fact.object === source)
          .forEach((sourceFact) => {
            const key = `${object.id}\0${sourceFact.field}`;
            if (facts.has(key)) return;
            facts.set(key, {
              object,
              field: sourceFact.field,
              value: sourceFact.value,
              evidence: [...sourceFact.evidence],
              invalidationReasons: new Set(sourceFact.invalidationReasons),
              initializer: sourceFact.initializer,
            });
            inherited = true;
          });
      });
    });
  }

  // #83 already proves the object boundary. Project its reasons onto only the
  // affected allocation facts instead of inventing a second escape analysis.
  facts.forEach((fact) => {
    fact.object.invalidationReasons.forEach((reason) => {
      if (reason === "dynamic-key") fact.invalidationReasons.add("dynamic-key");
      else if (reason === "metatable-mutation")
        fact.invalidationReasons.add("metatable-mutation");
      else if (reason === "instance-escape" || reason === "prototype-escape")
        fact.invalidationReasons.add("alias-escape");
    });
  });

  objects.modules.forEach((module) => {
    module.analysis.callGraph.calls.forEach((call) => {
      if (call.call.type !== "CallExpression") return;
      const callExpression = call.call;
      const invalidateArgument = (
        argument: Parser.Expression | undefined,
        reason: FieldInvalidationReason,
      ) => {
        if (!argument) return;
        const object = objects.objectOf(argument);
        if (!object) return;
        facts.forEach((fact) => {
          if (fact.object === object) fact.invalidationReasons.add(reason);
        });
      };
      if (call.hasUnknownTarget) {
        callExpression.arguments.forEach((argument) => {
          invalidateArgument(argument, "unknown-call");
        });
        return;
      }
      call.targets.forEach((target) => {
        const targetModule = objects.modules.find((candidate) =>
          candidate.analysis.callGraph.functions.includes(target),
        );
        if (!targetModule) return;
        targetModule.analysis.interprocedural
          .summaryOf(target)
          .escapes.forEach((escape) => {
            const argumentIndex =
              callExpression.base.type === "MemberExpression" &&
              callExpression.base.indexer === ":"
                ? escape.parameterIndex - 1
                : escape.parameterIndex;
            invalidateArgument(
              callExpression.arguments[argumentIndex],
              "alias-escape",
            );
          });
      });
    });
    walkBlockDeep(module.chunk.body, {
      onStatement: (statement) => {
        if (statement.type === "AssignmentStatement") {
          statement.init.forEach((value, index) => {
            const object = objects.objectOf(value);
            const target = statement.variables[index];
            if (
              !object ||
              (target.type === "Identifier" &&
                !module.resolved.isGlobalReference(target))
            )
              return;
            facts.forEach((fact) => {
              if (fact.object === object)
                fact.invalidationReasons.add("alias-escape");
            });
          });
        }
      },
    });
  });

  objects.resolvedMethods.forEach((method) => {
    const summary = objects.summaryOfMethodCall(method.call);
    summary?.effects
      .filter(
        (effect) => effect.parameterIndex === 0 && effect.access === "write",
      )
      .forEach((effect) => {
        facts.forEach((fact) => {
          if (fact.object !== method.object) return;
          if (
            effect.staticKey === undefined ||
            effect.staticKey ===
              luaByteStringKey(luaByteStringOfText(fact.field))
          )
            fact.invalidationReasons.add("field-reassignment");
        });
      });
  });

  // Direct writes after construction invalidate the precise field only.
  objects.modules.forEach((module) => {
    walkBlockDeep(module.chunk.body, {
      onStatement: (node) => {
        if (node.type !== "AssignmentStatement" || constructorWrites.has(node))
          return;
        node.variables.forEach((variable) => {
          if (variable.type === "IndexExpression") {
            const object = objects.objectOf(variable.base);
            if (object)
              facts.forEach((fact) => {
                if (fact.object === object)
                  fact.invalidationReasons.add("dynamic-key");
              });
          } else if (variable.type === "MemberExpression") {
            const object = objects.objectOf(variable.base);
            const fact = object
              ? facts.get(`${object.id}\0${variable.identifier.name}`)
              : undefined;
            fact?.invalidationReasons.add("field-reassignment");
          }
        });
      },
    });
  });

  const methodObjects = new Map<Callable, Set<ProgramObjectIdentity>>();
  objects.resolvedMethods.forEach((method) => {
    const receivers = methodObjects.get(method.target) ?? new Set();
    receivers.add(method.object);
    methodObjects.set(method.target, receivers);
  });
  const readFacts = new WeakMap<Parser.MemberExpression, MutableFact>();
  objects.modules.forEach((module) => {
    walkBlockDeep(module.chunk.body, {
      onExpression: (expression) => {
        if (
          expression.type !== "MemberExpression" ||
          expression.indexer !== "."
        )
          return;
        const directObject = objects.objectOf(expression.base);
        if (directObject) {
          const fact = facts.get(
            `${directObject.id}\0${expression.identifier.name}`,
          );
          if (fact && usable(fact)) readFacts.set(expression, fact);
          return;
        }
        if (expression.base.type !== "Identifier") return;
        const symbol = module.resolved.symbolOf(expression.base);
        const callable = module.analysis.callGraph.functions.find(
          (candidate) => candidate.parameters[0] === symbol,
        );
        if (!callable) return;
        const receiverFacts = [...(methodObjects.get(callable) ?? [])]
          .map((object) =>
            facts.get(`${object.id}\0${expression.identifier.name}`),
          )
          .filter(
            (fact): fact is MutableFact => fact !== undefined && usable(fact),
          );
        if (receiverFacts.length === 0) return;
        const first = receiverFacts[0];
        if (
          receiverFacts.length === (methodObjects.get(callable)?.size ?? 0) &&
          receiverFacts.every((fact) => sameValue(fact.value, first.value))
        )
          readFacts.set(expression, first);
      },
    });
  });
  // A resolved method edge already supplies the exact receiver allocation.
  // Index its parameter-zero field reads directly so callback calls do not
  // depend on recovering the owning callable from a module-local scan.
  objects.resolvedMethods.forEach((method) => {
    const module = objects.modules.find((candidate) =>
      candidate.analysis.callGraph.functions.includes(method.target),
    );
    const receiver = method.target.parameters[0];
    if (!module) return;
    method.target.declaration.body.forEach((statement) => {
      walkBlockDeep([statement], {
        onExpression: (expression) => {
          if (
            expression.type !== "MemberExpression" ||
            expression.indexer !== "." ||
            expression.base.type !== "Identifier" ||
            module.resolved.symbolOf(expression.base) !== receiver
          )
            return;
          const fact = facts.get(
            `${method.object.id}\0${expression.identifier.name}`,
          );
          if (fact && usable(fact)) readFacts.set(expression, fact);
        },
      });
    });
  });

  const diagnostics: WholeProgramFieldDiagnostic[] = [];
  facts.forEach((fact) => {
    if (usable(fact))
      diagnostics.push({
        moduleName: fact.object.moduleName,
        reason: "field-fact",
        ...rangeOf(fact.initializer),
      });
    fact.invalidationReasons.forEach((reason) =>
      diagnostics.push({
        moduleName: fact.object.moduleName,
        reason,
        ...rangeOf(fact.initializer),
      }),
    );
  });
  const publicFacts: ProgramFieldFact[] = [...facts.values()];
  const resolvedCallbacks: ResolvedFieldCallbackCall[] = [];
  const callbackTargets = new Map<CallSite, Callable>();
  objects.callGraph.calls.forEach((call) => {
    if (
      call.call.type !== "CallExpression" ||
      call.call.base.type !== "MemberExpression" ||
      call.call.base.indexer !== "."
    )
      return;
    const field = readFacts.get(call.call.base);
    if (!field || field.value?.kind !== "function") return;
    callbackTargets.set(call, field.value.callable);
    resolvedCallbacks.push({
      call,
      field,
      target: field.value.callable,
    });
  });
  const callGraph = combineCallGraphs(
    [objects.callGraph],
    callbackTargets,
    objects.generation,
  );
  return {
    generation: objects.generation,
    callGraph,
    resolvedCallbacks,
    facts: publicFacts,
    diagnostics,
    annotationFacts,
    factOf: (object, field) => facts.get(`${object.id}\0${field}`),
    factOfRead: (read) => readFacts.get(read),
  };
}

export function applyWholeProgramFieldRewrites(
  objects: WholeProgramObjectAnalysis,
  analysis: WholeProgramFieldAnalysis,
  metadataOf: (moduleName: string) => SourceMetadata,
  options: {
    readonly replaceReads?: boolean;
    readonly removeInitializers?: boolean;
  } = {},
): WholeProgramFieldRewriteResult {
  const assignmentTargets = new WeakSet<Parser.MemberExpression>();
  if (options.replaceReads !== false)
    objects.modules.forEach((module) => {
      walkBlockDeep(module.chunk.body, {
        onStatement: (statement) => {
          if (statement.type !== "AssignmentStatement") return;
          statement.variables.forEach((variable) => {
            if (variable.type === "MemberExpression")
              assignmentTargets.add(variable);
          });
        },
      });
    });
  const readCount = new Map<Parser.AssignmentStatement, number>();
  let replacedReads = 0;
  if (options.removeInitializers !== false)
    objects.modules.forEach((module) => {
      walkBlockDeep(module.chunk.body, {
        onExpression: (expression) => {
          if (
            expression.type !== "MemberExpression" ||
            assignmentTargets.has(expression)
          )
            return;
          const fact = analysis.factOfRead(expression);
          if (!fact?.value) return;
          const replacement = literalFor(fact.value, expression);
          if (!replacement) {
            if (fact.initializer)
              readCount.set(
                fact.initializer,
                (readCount.get(fact.initializer) ?? 0) + 1,
              );
            return;
          }
          replaceExpression(expression, replacement);
          replacedReads++;
        },
      });
    });

  const factsByInitializer = new Map<
    Parser.AssignmentStatement,
    ProgramFieldFact[]
  >();
  analysis.facts.forEach((fact) => {
    if (!fact.initializer) return;
    const related = factsByInitializer.get(fact.initializer) ?? [];
    related.push(fact);
    factsByInitializer.set(fact.initializer, related);
  });
  let removedInitializers = 0;
  let preservedEffects = 0;
  objects.modules.forEach((module) => {
    const metadata = metadataOf(module.name);
    rewriteBlocks(module.chunk.body, (body, index, statement) => {
      if (statement.type !== "AssignmentStatement") return;
      const related = factsByInitializer.get(statement);
      if (
        !related ||
        related.length === 0 ||
        related.some(
          (fact) =>
            fact.invalidationReasons.size > 0 ||
            (fact.initializer && (readCount.get(fact.initializer) ?? 0) > 0),
        ) ||
        metadata.annotationsOf(statement).keep
      )
        return;
      if (statement.variables.length !== 1 || statement.init.length !== 1)
        return;
      const value = statement.init[0];
      const discardable =
        module.analysis.facts.discardabilityOf(value).discardable ||
        (value.type === "Identifier" &&
          module.resolved.symbolOf(value) !== undefined);
      if (discardable) {
        metadata.removeStatement(statement, body[index + 1]);
        body.splice(index, 1);
      } else if (
        value.type === "CallExpression" ||
        value.type === "TableCallExpression" ||
        value.type === "StringCallExpression"
      ) {
        const statementRange = (statement as { range?: [number, number] })
          .range;
        const replacement: Parser.CallStatement = {
          type: "CallStatement",
          expression: value,
          ...(statement.loc ? { loc: statement.loc } : {}),
          ...(statementRange ? { range: statementRange } : {}),
        };
        metadata.replaceStatement(statement, [replacement]);
        body[index] = replacement;
        preservedEffects++;
      } else return;
      removedInitializers++;
    });
  });
  return {
    changed: replacedReads > 0 || removedInitializers > 0,
    replacedReads,
    removedInitializers,
    preservedEffects,
  };
}

function valueAtCall(
  expression: Parser.Expression,
  target: Callable,
  constructor: ResolvedConstructorCall,
  module: WholeProgramObjectAnalysis["modules"][number],
  callerModule: WholeProgramObjectAnalysis["modules"][number],
  options: WholeProgramFieldOptions,
):
  | {
      value: FieldFactValue;
      evidence: FieldFactEvidence;
      annotationEvidence?: FieldFactEvidence;
      contradiction?: boolean;
    }
  | undefined {
  let source = expression;
  let valueModule = module;
  if (expression.type === "Identifier") {
    const symbol = module.resolved.symbolOf(expression);
    const index = symbol ? target.parameters.indexOf(symbol) : -1;
    const metadata = options.metadataOf?.(module.name);
    const annotation = metadata
      ?.emmyLuaOf(target.declaration)
      .find(
        (directive) =>
          directive.kind === "param" &&
          index >= 0 &&
          directive.name === target.parameters[index].name,
      );
    const annotationValue =
      options.trustAnnotations && annotation?.kind === "param"
        ? singletonAnnotationValue(annotation.valueType)
        : undefined;
    const annotationEvidence: FieldFactEvidence | undefined =
      annotationValue && annotation
        ? {
            kind: "annotation",
            moduleName: module.name,
            ...rangeOf(annotation.comment),
            assumption: "annotations",
          }
        : undefined;
    const argumentIndex =
      constructor.call.call.type === "CallExpression" &&
      constructor.call.call.base.type === "MemberExpression" &&
      constructor.call.call.base.indexer === ":"
        ? index - 1
        : index;
    if (argumentIndex >= 0 && constructor.arguments[argumentIndex]) {
      source = constructor.arguments[argumentIndex];
      valueModule = callerModule;
      const actualValue = syntaxValue(source, valueModule);
      if (
        actualValue &&
        annotationValue &&
        !sameValue(actualValue, annotationValue)
      )
        return {
          value: actualValue,
          evidence: {
            kind: "code",
            moduleName: constructor.moduleName,
            ...rangeOf(source),
          },
          annotationEvidence,
          contradiction: true,
        };
    } else if (index >= 0 && annotationValue && annotationEvidence) {
      return { value: annotationValue, evidence: annotationEvidence };
    }
  }
  const value = syntaxValue(source, valueModule);
  return value
    ? {
        value,
        evidence: {
          kind: "code",
          moduleName:
            source === expression ? module.name : constructor.moduleName,
          ...rangeOf(source),
        },
      }
    : undefined;
}

function syntaxValue(
  expression: Parser.Expression,
  module: WholeProgramObjectAnalysis["modules"][number],
): FieldFactValue | undefined {
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
      return expression.fields.length === 0
        ? { kind: "empty-table", origin: expression }
        : undefined;
    case "FunctionDeclaration": {
      const callable = module.analysis.callGraph.functionOf(expression);
      return callable ? { kind: "function", callable } : undefined;
    }
    case "Identifier": {
      const symbol = module.resolved.symbolOf(expression);
      const callable = symbol
        ? module.analysis.callGraph.functionOfSymbol(symbol)
        : undefined;
      if (callable) return { kind: "function", callable };
      const value = module.analysis.facts.expressionFact(expression)?.value;
      if (
        value?.kind === "allocation" &&
        value.allocationKind === "table" &&
        value.origin.type === "TableConstructorExpression" &&
        value.origin.fields.length === 0
      )
        return { kind: "empty-table", origin: value.origin };
      if (!symbol) return undefined;
      let initializer: Parser.Expression | undefined;
      walkBlockDeep(module.chunk.body, {
        onStatement: (statement) => {
          if (statement.type !== "LocalStatement") return;
          statement.variables.forEach((variable, index) => {
            if (variable === symbol.declaration)
              initializer = statement.init[index];
          });
        },
      });
      return initializer?.type === "TableConstructorExpression" &&
        initializer.fields.length === 0
        ? { kind: "empty-table", origin: initializer }
        : undefined;
    }
    default:
      return undefined;
  }
}

function singletonAnnotationValue(
  valueType: string,
): FieldFactValue | undefined {
  const value = valueType.trim();
  if (value === "true" || value === "false")
    return { kind: "boolean", value: value === "true" };
  if (/^-?(?:\d+\.?\d*|\.\d+)$/.test(value))
    return { kind: "number", raw: value };
  if (/^(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')$/.test(value))
    return { kind: "string", raw: value };
  return undefined;
}

function literalFor(
  value: FieldFactValue,
  origin: Parser.MemberExpression,
): Parser.Expression | undefined {
  const originRange = (origin as unknown as { range?: [number, number] }).range;
  const source = {
    ...(origin.loc ? { loc: origin.loc } : {}),
    ...(originRange ? { range: originRange } : {}),
  };
  switch (value.kind) {
    case "nil":
      return { type: "NilLiteral", value: null, raw: "nil", ...source };
    case "boolean":
      return {
        type: "BooleanLiteral",
        value: value.value,
        raw: value.value ? "true" : "false",
        ...source,
      };
    case "number":
      return {
        type: "NumericLiteral",
        value: Number(value.raw),
        raw: value.raw,
        ...source,
      };
    case "string":
      return {
        type: "StringLiteral",
        value: value.raw.slice(1, -1),
        raw: value.raw,
        ...source,
      };
    case "function":
    case "empty-table":
      return undefined;
  }
}

function replaceExpression(
  target: Parser.Expression,
  replacement: Parser.Expression,
): void {
  // Every AST consumer dispatches on `type`; source location and superseded
  // member fields are inert provenance once the discriminant is replaced.
  Object.assign(target, replacement);
}

function rewriteBlocks(
  body: Parser.Statement[],
  visit: (
    body: Parser.Statement[],
    index: number,
    statement: Parser.Statement,
  ) => void,
): void {
  for (let index = body.length - 1; index >= 0; index--) {
    const statement = body[index];
    switch (statement.type) {
      case "DoStatement":
      case "WhileStatement":
      case "RepeatStatement":
      case "FunctionDeclaration":
      case "ForNumericStatement":
      case "ForGenericStatement":
        rewriteBlocks(statement.body, visit);
        break;
      case "IfStatement":
        statement.clauses.forEach((clause) => {
          rewriteBlocks(clause.body, visit);
        });
        break;
    }
    visit(body, index, statement);
  }
}

function usable(fact: MutableFact): boolean {
  return fact.value !== undefined && fact.invalidationReasons.size === 0;
}

function sameValue(
  left: FieldFactValue | undefined,
  right: FieldFactValue | undefined,
): boolean {
  if (!left || !right || left.kind !== right.kind) return false;
  if (left.kind === "boolean" && right.kind === "boolean")
    return left.value === right.value;
  if (left.kind === "number" && right.kind === "number")
    return left.raw === right.raw;
  if (left.kind === "string" && right.kind === "string")
    return left.raw === right.raw;
  if (left.kind === "function" && right.kind === "function")
    return left.callable === right.callable;
  if (left.kind === "empty-table" && right.kind === "empty-table")
    return left.origin === right.origin;
  return left.kind === "nil" && right.kind === "nil";
}

function rangeOf(node: object | undefined): {
  readonly sourceRange?: readonly [number, number];
} {
  const range = node ? (node as { range?: [number, number] }).range : undefined;
  return range ? { sourceRange: range } : {};
}
