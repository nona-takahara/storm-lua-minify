import Parser from "luaparse";
import { walkBlockDeep } from "./astWalk";
import {
  CallGraphAnalysis,
  CallSite,
  Callable,
  combineCallGraphs,
} from "./callGraph";
import { FunctionSummary } from "./interproceduralAnalysis";
import { staticStringArgument } from "./linker";
import { OptimizerAnalysis } from "./optimizerAnalysis";
import { ResolveResult, Symbol } from "./resolver";

export interface WholeProgramModule {
  readonly name: string;
  readonly chunk: Parser.Chunk;
  readonly resolved: ResolveResult;
  readonly analysis: OptimizerAnalysis;
}

export type ObjectRefusalReason =
  | "allocation-unknown"
  | "instance-escape"
  | "prototype-escape"
  | "method-field-mutation"
  | "dynamic-key"
  | "metatable-mutation"
  | "multiple-targets"
  | "dynamic-module-boundary"
  | "external-module-boundary";

export interface ProgramObjectIdentity {
  readonly id: string;
  readonly moduleName: string;
  readonly kind: "module-return" | "prototype" | "allocation";
  readonly methods: ReadonlyMap<string, Callable>;
  readonly invalidationReasons: ReadonlySet<ObjectRefusalReason>;
}

export interface ResolvedMethodCall {
  readonly call: CallSite;
  readonly receiver: Parser.Expression;
  readonly target: Callable;
  readonly object: ProgramObjectIdentity;
}

export interface WholeProgramObjectDiagnostic {
  readonly moduleName: string;
  readonly reason: "resolved-method-target" | ObjectRefusalReason;
  readonly sourceRange?: readonly [number, number];
}

export interface WholeProgramObjectAnalysis {
  readonly generation: number;
  readonly modules: readonly WholeProgramModule[];
  readonly objects: readonly ProgramObjectIdentity[];
  readonly callGraph: CallGraphAnalysis;
  readonly resolvedMethods: readonly ResolvedMethodCall[];
  readonly diagnostics: readonly WholeProgramObjectDiagnostic[];
  objectOf(expression: Parser.Expression): ProgramObjectIdentity | undefined;
  methodCallOf(call: CallSite): ResolvedMethodCall | undefined;
  summaryOfMethodCall(call: CallSite): FunctionSummary | undefined;
  effectsOfMethodCall(call: CallSite): FunctionSummary["effects"];
}

interface MutableObject {
  readonly id: string;
  readonly moduleName: string;
  kind: ProgramObjectIdentity["kind"];
  readonly methods: Map<string, Callable>;
  readonly invalidationReasons: Set<ObjectRefusalReason>;
}

interface ConstructorTemplate {
  readonly prototype: Parser.Expression;
  readonly base: Parser.Expression;
  readonly module: WholeProgramModule;
}

interface FactoryTemplate {
  readonly targetParameter: Symbol;
  readonly prototypeParameter: Symbol;
  readonly copyAssignments: readonly Parser.AssignmentStatement[];
}

/**
 * Build the object/module identity layer once for a linked AST generation.
 *
 * This analysis intentionally publishes resolved methods as ordinary CallSite -> Callable
 * relations. Consumers do not need to know whether a callable came from a lexical alias or
 * from a factory allocation. Unknown Lua table behaviour invalidates the affected identity;
 * it never creates a guessed edge.
 */
export function analyzeWholeProgramObjects(
  modules: readonly WholeProgramModule[],
  generation: number,
): WholeProgramObjectAnalysis {
  const moduleByName = new Map(modules.map((module) => [module.name, module]));
  const moduleOfNode = new WeakMap<object, WholeProgramModule>();
  const callableModule = new Map<Callable, WholeProgramModule>();
  const callableOfDeclaration = new WeakMap<
    Parser.FunctionDeclaration,
    Callable
  >();
  const callSiteOfExpression = new WeakMap<Parser.Expression, CallSite>();
  modules.forEach((module) => {
    walkStatements(module.chunk.body, (node) => moduleOfNode.set(node, module));
    module.analysis.callGraph.functions.forEach((callable) => {
      callableModule.set(callable, module);
      callableOfDeclaration.set(callable.declaration, callable);
    });
    module.analysis.callGraph.calls.forEach((call) =>
      callSiteOfExpression.set(call.call, call),
    );
  });

  const mutableObjects: MutableObject[] = [];
  const objectOfTable = new WeakMap<
    Parser.TableConstructorExpression,
    MutableObject
  >();
  const valuesOfSymbol = new Map<Symbol, Set<MutableObject>>();
  const valuesOfExpression = new WeakMap<
    Parser.Expression,
    Set<MutableObject>
  >();
  const moduleReturns = new Map<string, Set<MutableObject>>();
  const functionsOfSymbol = new Map<Symbol, Set<Callable>>();
  const moduleFunctionReturns = new Map<string, Set<Callable>>();
  const methodDefinitions = new WeakSet();
  const factoryTemplates = new Map<Callable, FactoryTemplate>();
  const factoryCopyAssignments = new WeakSet<Parser.AssignmentStatement>();
  const constructorTemplates = new Map<Callable, ConstructorTemplate>();
  const sourcesOfObject = new Map<MutableObject, Set<MutableObject>>();
  let nextObject = 0;

  const objectForTable = (
    table: Parser.TableConstructorExpression,
    module: WholeProgramModule,
  ): MutableObject => {
    const existing = objectOfTable.get(table);
    if (existing) return existing;
    const object: MutableObject = {
      id: `${module.name}:table:${String(nextObject++)}`,
      moduleName: module.name,
      kind: "allocation",
      methods: new Map(),
      invalidationReasons: new Set(),
    };
    objectOfTable.set(table, object);
    mutableObjects.push(object);
    return object;
  };

  modules.forEach((module) => {
    visitExpressions(module.chunk.body, (expression) => {
      if (expression.type === "TableConstructorExpression")
        objectForTable(expression, module);
    });
  });

  modules.forEach((module) => {
    const returned = topLevelReturn(module.chunk);
    if (!returned) return;
    let callable: Callable | undefined;
    if (returned.type === "FunctionDeclaration")
      callable = module.analysis.callGraph.functionOf(returned);
    else if (returned.type === "Identifier") {
      const symbol = module.resolved.symbolOf(returned);
      if (symbol) callable = module.analysis.callGraph.functionOfSymbol(symbol);
    }
    if (callable) moduleFunctionReturns.set(module.name, new Set([callable]));
  });

  const directValues = (
    expression: Parser.Expression,
    module: WholeProgramModule,
  ): Set<MutableObject> => {
    const cached = valuesOfExpression.get(expression);
    if (cached) return cached;
    let result = new Set<MutableObject>();
    if (expression.type === "TableConstructorExpression") {
      result.add(objectForTable(expression, module));
    } else if (expression.type === "Identifier") {
      const symbol = module.resolved.symbolOf(expression);
      if (symbol) result = new Set(valuesOfSymbol.get(symbol) ?? []);
    } else if (expression.type === "CallExpression") {
      const required = staticRequiredModule(expression);
      if (required) result = new Set(moduleReturns.get(required) ?? []);
    }
    valuesOfExpression.set(expression, result);
    return result;
  };

  // Stable table and require aliases form the seed identity relation.
  let changed = true;
  while (changed) {
    changed = false;
    modules.forEach((module) => {
      visitBindings(module.chunk.body, (target, value) => {
        const symbol = module.resolved.symbolOf(target);
        if (!symbol || !stableSymbol(symbol, module.analysis)) return;
        const incoming = directValues(value, module);
        if (unionInto(valuesOfSymbol, symbol, incoming)) changed = true;
        if (value.type === "CallExpression") {
          const required = staticRequiredModule(value);
          if (
            required &&
            unionCallableInto(
              functionsOfSymbol,
              symbol,
              moduleFunctionReturns.get(required) ?? new Set(),
            )
          )
            changed = true;
        }
      });
      const returned = topLevelReturn(module.chunk);
      if (returned) {
        const incoming = directValues(returned, module);
        const current = moduleReturns.get(module.name) ?? new Set();
        const before = current.size;
        incoming.forEach((object) => {
          object.kind = "module-return";
          current.add(object);
        });
        moduleReturns.set(module.name, current);
        if (current.size !== before) changed = true;
      }
    });
    valuesOfExpressionCleanup(valuesOfExpression, modules);
  }

  // Member function declarations establish prototype fields by object identity.
  modules.forEach((module) => {
    walkStatements(module.chunk.body, (node) => {
      if (node.type !== "FunctionDeclaration") return;
      const declaration = node;
      if (declaration.identifier?.type !== "MemberExpression") return;
      const callable = callableOfDeclaration.get(declaration);
      if (!callable) return;
      const key = declaration.identifier.identifier.name;
      const bases = directValues(declaration.identifier.base, module);
      bases.forEach((object) => {
        object.kind =
          object.kind === "module-return" ? object.kind : "prototype";
        const prior = object.methods.get(key);
        if (prior && prior !== callable)
          object.invalidationReasons.add("method-field-mutation");
        object.methods.set(key, callable);
      });
      if (declaration.identifier.indexer === ":") {
        const self = callable.parameters[0];
        if (self.name === "self")
          bases.forEach((object) => {
            unionInto(valuesOfSymbol, self, new Set([object]));
          });
      }
      methodDefinitions.add(declaration.identifier);
    });
  });

  modules.forEach((module) => {
    module.analysis.callGraph.functions.forEach((callable) => {
      const factory = recognizeMixinFactory(callable, module.resolved);
      if (factory) {
        factoryTemplates.set(callable, factory);
        factory.copyAssignments.forEach((assignment) =>
          factoryCopyAssignments.add(assignment),
        );
      }
    });
  });
  const directCallTargets = (
    call: CallSite,
    module: WholeProgramModule,
  ): Set<Callable> => {
    const targets = new Set(call.targets);
    const expression = call.call;
    if (expression.type !== "CallExpression") return targets;
    if (expression.base.type === "Identifier") {
      const symbol = module.resolved.symbolOf(expression.base);
      if (symbol)
        functionsOfSymbol.get(symbol)?.forEach((target) => targets.add(target));
    } else if (expression.base.type === "MemberExpression") {
      const member = expression.base;
      directValues(member.base, module).forEach((object) => {
        const target = object.methods.get(member.identifier.name);
        if (target) targets.add(target);
      });
    }
    return targets;
  };
  modules.forEach((module) => {
    module.analysis.callGraph.functions.forEach((callable) => {
      const constructor = recognizeConstructor(
        callable,
        module,
        factoryTemplates,
        (call) => {
          const site = callSiteOfExpression.get(call);
          if (!site) return new Set();
          const targets = directCallTargets(site, module);
          const member =
            call.base.type === "MemberExpression" ? call.base : undefined;
          if (member)
            directValues(member.base, module).forEach((object) => {
              const target = object.methods.get(member.identifier.name);
              if (target) targets.add(target);
            });
          return targets;
        },
      );
      if (constructor) constructorTemplates.set(callable, constructor);
    });
  });

  // Constructor calls allocate a distinct identity at each call site. The copied prototype
  // and a factory-returned base contribute methods to that one identity.
  const instanceOfCall = new WeakMap<Parser.Expression, MutableObject>();
  changed = true;
  while (changed) {
    changed = false;
    modules.forEach((module) => {
      module.analysis.callGraph.calls.forEach((call) => {
        if (call.call.type !== "CallExpression") return;
        const targets = directCallTargets(call, module);
        const member =
          call.call.base.type === "MemberExpression"
            ? call.call.base
            : undefined;
        if (member)
          directValues(member.base, module).forEach((object) => {
            const target = object.methods.get(member.identifier.name);
            if (target) targets.add(target);
          });
        const constructor = [...targets]
          .map((target) => constructorTemplates.get(target))
          .filter((value): value is ConstructorTemplate => value !== undefined);
        const mixin = [...targets]
          .map((target) => factoryTemplates.get(target))
          .filter((value): value is FactoryTemplate => value !== undefined);
        if (constructor.length + mixin.length !== 1) return;
        let instance = instanceOfCall.get(call.call);
        if (!instance) {
          instance = {
            id: `${module.name}:call:${String(call.id)}`,
            moduleName: module.name,
            kind: "allocation",
            methods: new Map(),
            invalidationReasons: new Set(),
          };
          instanceOfCall.set(call.call, instance);
          mutableObjects.push(instance);
          changed = true;
        }
        const sources = new Set<MutableObject>();
        if (constructor.length === 1) {
          directValues(constructor[0].prototype, constructor[0].module).forEach(
            (object) => sources.add(object),
          );
          directValues(constructor[0].base, constructor[0].module).forEach(
            (object) => sources.add(object),
          );
        } else {
          const args = call.call.arguments;
          const base = args.at(0);
          const prototype = args.at(1);
          if (!base || !prototype) return;
          directValues(base, module).forEach((object) => sources.add(object));
          directValues(prototype, module).forEach((object) =>
            sources.add(object),
          );
        }
        sources.forEach((source) => {
          const recordedSources = sourcesOfObject.get(instance) ?? new Set();
          recordedSources.add(source);
          sourcesOfObject.set(instance, recordedSources);
          source.methods.forEach((target, key) =>
            instance.methods.set(key, target),
          );
          source.invalidationReasons.forEach((reason) =>
            instance.invalidationReasons.add(reason),
          );
        });
        valuesOfExpression.set(call.call, new Set([instance]));
      });
      visitBindings(module.chunk.body, (target, value) => {
        const symbol = module.resolved.symbolOf(target);
        if (!symbol || !stableSymbol(symbol, module.analysis)) return;
        if (unionInto(valuesOfSymbol, symbol, directValues(value, module)))
          changed = true;
      });
      module.analysis.callGraph.calls.forEach((call) => {
        const expression = call.call;
        if (expression.type !== "CallExpression") return;
        const targets = directCallTargets(call, module);
        if (targets.size !== 1) return;
        const target = [...targets][0];
        target.parameters.forEach((parameter, index) => {
          const actual = expression.arguments.at(index);
          if (
            actual &&
            unionInto(valuesOfSymbol, parameter, directValues(actual, module))
          )
            changed = true;
        });
      });
    });
    valuesOfExpressionCleanup(valuesOfExpression, modules, true);
  }

  // Invalidate only identities that cross an unproved observation/mutation boundary.
  modules.forEach((module) => {
    walkStatements(module.chunk.body, (node) => {
      if (node.type === "AssignmentStatement") {
        const statement = node;
        if (factoryCopyAssignments.has(statement)) return;
        statement.variables.forEach((target) => {
          if (target.type === "IndexExpression") {
            directValues(target.base, module).forEach((object) =>
              object.invalidationReasons.add("dynamic-key"),
            );
          } else if (target.type === "MemberExpression") {
            if (methodDefinitions.has(target)) return;
            directValues(target.base, module).forEach((object) => {
              if (object.methods.has(target.identifier.name))
                object.invalidationReasons.add("method-field-mutation");
            });
          }
        });
      }
    });
    module.analysis.callGraph.calls.forEach((call) => {
      if (call.call.type !== "CallExpression") return;
      if (
        call.call.base.type === "Identifier" &&
        call.call.base.name === "setmetatable"
      ) {
        directValues(call.call.arguments[0], module).forEach((object) =>
          object.invalidationReasons.add("metatable-mutation"),
        );
        return;
      }
      if (
        directCallTargets(call, module).size > 0 ||
        staticRequiredModule(call.call)
      )
        return;
      if (
        call.caller &&
        factoryTemplates.has(call.caller) &&
        call.call.base.type === "Identifier" &&
        (call.call.base.name === "pairs" || call.call.base.name === "type")
      )
        return;
      if (call.call.base.type === "MemberExpression") {
        const member = call.call.base;
        const knownFactory = [
          ...directValues(call.call.base.base, module),
        ].some((object) => {
          const target = object.methods.get(member.identifier.name);
          return target ? factoryTemplates.has(target) : false;
        });
        if (knownFactory) return;
      }
      call.call.arguments.forEach((argument) => {
        directValues(argument, module).forEach((object) =>
          object.invalidationReasons.add(
            object.kind === "prototype" || object.kind === "module-return"
              ? "prototype-escape"
              : "instance-escape",
          ),
        );
      });
    });
  });

  changed = true;
  while (changed) {
    changed = false;
    sourcesOfObject.forEach((sources, object) => {
      const before = object.invalidationReasons.size;
      sources.forEach((source) => {
        source.invalidationReasons.forEach((reason) =>
          object.invalidationReasons.add(reason),
        );
      });
      if (object.invalidationReasons.size !== before) changed = true;
    });
  }

  const resolvedMethods: (Omit<ResolvedMethodCall, "object"> & {
    readonly object: MutableObject;
  })[] = [];
  const diagnostics: WholeProgramObjectDiagnostic[] = [];
  modules.forEach((module) => {
    module.analysis.callGraph.calls.forEach((call) => {
      if (
        call.call.type === "CallExpression" &&
        call.call.base.type === "Identifier" &&
        call.call.base.name === "require"
      ) {
        const required = staticRequiredModule(call.call);
        if (!required)
          diagnostics.push({
            moduleName: module.name,
            reason: "dynamic-module-boundary",
            ...sourceRangeOf(call.call),
          });
        else if (!moduleByName.has(required))
          diagnostics.push({
            moduleName: module.name,
            reason: "external-module-boundary",
            ...sourceRangeOf(call.call),
          });
      }
      if (
        call.call.type !== "CallExpression" ||
        call.call.base.type !== "MemberExpression" ||
        call.call.base.indexer !== ":"
      )
        return;
      const receiver = call.call.base.base;
      const candidates = [...directValues(receiver, module)];
      const callerAllocations = candidates.filter(
        (candidate) =>
          candidate.kind === "allocation" &&
          candidate.moduleName === module.name,
      );
      // A constructor template contains its own factory call, but each outer call owns the
      // observable allocation identity. Keep the template allocation as provenance only.
      const dispatchCandidates =
        callerAllocations.length > 0 ? callerAllocations : candidates;
      if (dispatchCandidates.length !== 1) {
        diagnostics.push({
          moduleName: module.name,
          reason:
            dispatchCandidates.length === 0
              ? "allocation-unknown"
              : "multiple-targets",
          ...sourceRangeOf(call.call),
        });
        return;
      }
      const object = dispatchCandidates[0];
      if (object.invalidationReasons.size > 0) {
        object.invalidationReasons.forEach((reason) =>
          diagnostics.push({
            moduleName: module.name,
            reason,
            ...sourceRangeOf(call.call),
          }),
        );
        return;
      }
      const target = object.methods.get(call.call.base.identifier.name);
      if (!target) return;
      const resolved = { call, receiver, target, object };
      resolvedMethods.push(resolved);
      diagnostics.push({
        moduleName: module.name,
        reason: "resolved-method-target",
        ...sourceRangeOf(call.call),
      });
    });
  });

  const publicObjects: ProgramObjectIdentity[] = mutableObjects.map(
    (object) => ({
      id: object.id,
      moduleName: object.moduleName,
      kind: object.kind,
      methods: object.methods,
      invalidationReasons: object.invalidationReasons,
    }),
  );
  const publicOfMutable = new Map(
    mutableObjects.map((object, index) => [object, publicObjects[index]]),
  );
  const resolvedPublic = resolvedMethods.map((resolved) => ({
    ...resolved,
    object: publicOfMutable.get(resolved.object) as ProgramObjectIdentity,
  }));
  const methodByCall = new Map(
    resolvedPublic.map((method) => [method.call, method]),
  );
  const methodByExpression = new WeakMap(
    resolvedPublic.map((method) => [method.call.call, method] as const),
  );
  const resolvedTargetByCall = new Map(
    resolvedPublic.map((method) => [method.call, method.target]),
  );
  modules.forEach((module) => {
    module.analysis.callGraph.calls.forEach((call) => {
      if (resolvedTargetByCall.has(call)) return;
      const targets = directCallTargets(call, module);
      if (targets.size === 1) resolvedTargetByCall.set(call, [...targets][0]);
    });
  });
  const callGraph = combineCallGraphs(
    modules.map((module) => module.analysis.callGraph),
    resolvedTargetByCall,
    generation,
  );
  const summaryOfTarget = (target: Callable): FunctionSummary | undefined => {
    const module = callableModule.get(target);
    return module?.analysis.interprocedural.summaryOf(target);
  };
  return {
    generation,
    modules,
    objects: publicObjects,
    callGraph,
    resolvedMethods: resolvedPublic,
    diagnostics,
    objectOf: (expression) => {
      const values = valuesOfExpression.get(expression);
      if (values?.size !== 1) return undefined;
      return publicOfMutable.get([...values][0]);
    },
    methodCallOf: (call) =>
      methodByCall.get(call) ?? methodByExpression.get(call.call),
    summaryOfMethodCall: (call) => {
      const method =
        methodByCall.get(call) ?? methodByExpression.get(call.call);
      return method ? summaryOfTarget(method.target) : undefined;
    },
    effectsOfMethodCall: (call) => {
      const method =
        methodByCall.get(call) ?? methodByExpression.get(call.call);
      if (!method) return [];
      return summaryOfTarget(method.target)?.effects ?? [];
    },
  };
}

function stableSymbol(symbol: Symbol, analysis: OptimizerAnalysis): boolean {
  return (
    analysis.facts
      .operationsOfSymbol(symbol)
      .filter((operation) => operation.kind === "write").length === 0
  );
}

function unionInto(
  target: Map<Symbol, Set<MutableObject>>,
  symbol: Symbol,
  incoming: ReadonlySet<MutableObject>,
): boolean {
  const values = target.get(symbol) ?? new Set();
  const before = values.size;
  incoming.forEach((value) => values.add(value));
  target.set(symbol, values);
  return values.size !== before;
}

function unionCallableInto(
  target: Map<Symbol, Set<Callable>>,
  symbol: Symbol,
  incoming: ReadonlySet<Callable>,
): boolean {
  const values = target.get(symbol) ?? new Set();
  const before = values.size;
  incoming.forEach((value) => values.add(value));
  target.set(symbol, values);
  return values.size !== before;
}

function staticRequiredModule(call: Parser.CallExpression): string | undefined {
  return call.base.type === "Identifier" && call.base.name === "require"
    ? staticStringArgument(call.arguments[0])
    : undefined;
}

function topLevelReturn(chunk: Parser.Chunk): Parser.Expression | undefined {
  const statement = chunk.body.at(-1);
  return statement?.type === "ReturnStatement" &&
    statement.arguments.length === 1
    ? statement.arguments[0]
    : undefined;
}

function recognizeMixinFactory(
  callable: Callable,
  resolved: ResolveResult,
): FactoryTemplate | undefined {
  if (callable.parameters.length < 2) return undefined;
  const targetParameter = callable.parameters[0];
  const prototypeParameter = callable.parameters[1];
  const returned = callable.declaration.body.at(-1);
  if (
    returned?.type !== "ReturnStatement" ||
    returned.arguments.length !== 1 ||
    returned.arguments[0].type !== "Identifier" ||
    resolved.symbolOf(returned.arguments[0]) !== targetParameter
  )
    return undefined;
  const copyAssignments: Parser.AssignmentStatement[] = [];
  callable.declaration.body.forEach((statement) => {
    if (statement.type !== "ForGenericStatement") return;
    const iterator = statement.iterators[0];
    if (
      iterator.type !== "CallExpression" ||
      iterator.base.type !== "Identifier" ||
      iterator.base.name !== "pairs" ||
      iterator.arguments.length === 0 ||
      iterator.arguments[0].type !== "Identifier" ||
      resolved.symbolOf(iterator.arguments[0]) !== prototypeParameter
    )
      return;
    const keyVariable = statement.variables.at(0);
    const valueVariable = statement.variables.at(1);
    if (!keyVariable || !valueVariable) return;
    const keySymbol = resolved.symbolOf(keyVariable);
    const valueSymbol = resolved.symbolOf(valueVariable);
    if (!keySymbol || !valueSymbol) return;
    walkStatements(statement.body, (node) => {
      if (node.type !== "AssignmentStatement") return;
      const assignment = node;
      assignment.variables.forEach((target, index) => {
        const value = assignment.init.at(index);
        if (!value) return;
        if (
          target.type === "IndexExpression" &&
          target.base.type === "Identifier" &&
          resolved.symbolOf(target.base) === targetParameter &&
          target.index.type === "Identifier" &&
          resolved.symbolOf(target.index) === keySymbol &&
          value.type === "Identifier" &&
          resolved.symbolOf(value) === valueSymbol
        )
          copyAssignments.push(assignment);
      });
    });
  });
  return copyAssignments.length > 0
    ? { targetParameter, prototypeParameter, copyAssignments }
    : undefined;
}

function recognizeConstructor(
  callable: Callable,
  module: WholeProgramModule,
  factories: ReadonlyMap<Callable, FactoryTemplate>,
  targetsOf: (call: Parser.CallExpression) => ReadonlySet<Callable>,
): ConstructorTemplate | undefined {
  const returned = callable.declaration.body.at(-1);
  if (
    returned?.type !== "ReturnStatement" ||
    returned.arguments.length !== 1 ||
    returned.arguments[0].type !== "Identifier"
  )
    return undefined;
  const returnedSymbol = module.resolved.symbolOf(returned.arguments[0]);
  if (!returnedSymbol) return undefined;
  let template: ConstructorTemplate | undefined;
  callable.declaration.body.forEach((statement) => {
    if (statement.type !== "LocalStatement") return;
    statement.variables.forEach((variable, index) => {
      if (module.resolved.symbolOf(variable) !== returnedSymbol) return;
      const value = statement.init.at(index);
      if (!value) return;
      if (value.type !== "CallExpression") return;
      if (![...targetsOf(value)].some((target) => factories.has(target)))
        return;
      if (value.arguments.length < 2) return;
      template = {
        base: value.arguments[0],
        prototype: value.arguments[1],
        module,
      };
    });
  });
  return template;
}

function sourceRangeOf(node: object): {
  readonly sourceRange?: readonly [number, number];
} {
  const range = (node as { range?: [number, number] }).range;
  return range ? { sourceRange: range } : {};
}

function valuesOfExpressionCleanup(
  cache: WeakMap<Parser.Expression, Set<MutableObject>>,
  modules: readonly WholeProgramModule[],
  retainCalls = false,
): void {
  modules.forEach((module) => {
    visitExpressions(module.chunk.body, (expression) => {
      if (retainCalls && expression.type === "CallExpression") return;
      if (expression.type !== "TableConstructorExpression")
        cache.delete(expression);
    });
  });
}

function visitBindings(
  body: readonly Parser.Statement[],
  visit: (target: Parser.Identifier, value: Parser.Expression) => void,
): void {
  walkStatements(body, (node) => {
    if (node.type === "LocalStatement") {
      const statement = node;
      statement.variables.forEach((target, index) => {
        const value = statement.init.at(index);
        if (!value) return;
        visit(target, value);
      });
    } else if (node.type === "AssignmentStatement") {
      const statement = node;
      statement.variables.forEach((target, index) => {
        const value = statement.init.at(index);
        if (!value) return;
        if (target.type === "Identifier") visit(target, value);
      });
    }
  });
}

function walkStatements(
  body: readonly Parser.Statement[],
  visit: (node: Parser.Statement | Parser.Expression) => void,
): void {
  walkBlockDeep(body, { onStatement: visit, onExpression: visit });
}

function visitExpressions(
  body: readonly Parser.Statement[],
  visit: (expression: Parser.Expression) => void,
): void {
  walkBlockDeep(body, { onExpression: visit });
}
