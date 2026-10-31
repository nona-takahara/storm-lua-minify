import Parser from "luaparse";
import { walkBlockDeep, walkExpression, walkStatement } from "./astWalk";
import { Callable, CallSite } from "./callGraph";
import { staticStringArgument } from "./linker";
import { SourceMetadata } from "./sourceMetadata";
import {
  ProgramObjectIdentity,
  WholeProgramModule,
  WholeProgramObjectAnalysis,
} from "./wholeProgramObjects";

export type ExportRootReason =
  | "entry-contract"
  | "annotation-root"
  | "static-field-root"
  | "dynamic-key"
  | "shape-observation"
  | "export-escape"
  | "multiple-return-allocations"
  | "unresolved-re-export";

export type ExportDiagnosticReason =
  | "export-field-candidate"
  | "field-live"
  | "field-unreachable"
  | "field-removed"
  | "field-effect-preserved"
  | "effectful-initializer"
  | ExportRootReason;

export interface ExportFieldIdentity {
  readonly id: string;
  readonly moduleName: string;
  readonly object: ProgramObjectIdentity;
  readonly key: string;
  readonly definitions: readonly ExportFieldDefinition[];
  readonly live: boolean;
  readonly rootReasons: ReadonlySet<ExportRootReason>;
}

export type ExportFieldDefinition =
  | {
      readonly kind: "table-field";
      readonly module: WholeProgramModule;
      readonly body: Parser.Statement[];
      readonly statement: Parser.Statement;
      readonly table: Parser.TableConstructorExpression;
      readonly field: Parser.TableKey | Parser.TableKeyString;
      readonly value: Parser.Expression;
    }
  | {
      readonly kind: "member-function";
      readonly module: WholeProgramModule;
      readonly body: Parser.Statement[];
      readonly statement: Parser.FunctionDeclaration;
      readonly value: Parser.FunctionDeclaration;
    }
  | {
      readonly kind: "member-assignment";
      readonly module: WholeProgramModule;
      readonly body: Parser.Statement[];
      readonly statement: Parser.AssignmentStatement;
      readonly value: Parser.Expression;
    };

export interface WholeProgramExportDiagnostic {
  readonly moduleName: string;
  readonly field?: string;
  readonly reason: ExportDiagnosticReason;
  readonly sourceRange?: readonly [number, number];
}

export interface WholeProgramExportAnalysis {
  readonly generation: number;
  readonly fields: readonly ExportFieldIdentity[];
  readonly diagnostics: readonly WholeProgramExportDiagnostic[];
}

export interface WholeProgramExportRewriteResult {
  readonly changed: boolean;
  readonly removedFields: readonly ExportFieldIdentity[];
  readonly preservedEffectFields: readonly ExportFieldIdentity[];
  readonly refusedEffectfulInitializerFields: readonly ExportFieldIdentity[];
}

interface MutableField {
  readonly id: string;
  readonly moduleName: string;
  readonly object: ProgramObjectIdentity;
  readonly key: string;
  readonly definitions: ExportFieldDefinition[];
  readonly dependencies: Set<MutableField>;
  readonly callableDependencies: Set<Callable>;
  readonly shapeDependencies: Set<ProgramObjectIdentity>;
  readonly rootReasons: Set<ExportRootReason>;
  live: boolean;
}

type Owner = MutableField | Callable;

function sourceRangeOf(node: object): readonly [number, number] | undefined {
  return (node as { range?: readonly [number, number] }).range;
}

function fieldKey(
  field: Parser.TableKey | Parser.TableKeyString,
): string | undefined {
  if (field.type === "TableKeyString") return field.key.name;
  return staticStringArgument(field.key);
}

function isCallExpression(
  expression: Parser.Expression,
): expression is
  | Parser.CallExpression
  | Parser.TableCallExpression
  | Parser.StringCallExpression {
  return (
    expression.type === "CallExpression" ||
    expression.type === "TableCallExpression" ||
    expression.type === "StringCallExpression"
  );
}

function topLevelReturn(
  module: WholeProgramModule,
): Parser.ReturnStatement | undefined {
  const statement = module.chunk.body.at(-1);
  return statement?.type === "ReturnStatement" &&
    statement.arguments.length === 1
    ? statement
    : undefined;
}

function sameObject(
  analysis: WholeProgramObjectAnalysis,
  expression: Parser.Expression,
  object: ProgramObjectIdentity,
): boolean {
  return analysis.objectOf(expression)?.id === object.id;
}

function markExpressionOwner(
  expression: Parser.Expression,
  owner: Owner,
  owners: WeakMap<object, Owner>,
): void {
  walkExpression(expression, {
    onExpression: (nested) => owners.set(nested, owner),
    onBlock: (body) => {
      walkBlockDeep(body, {
        onStatement: (statement) => owners.set(statement, owner),
        onExpression: (nested) => owners.set(nested, owner),
      });
    },
  });
}

/**
 * Compute export reachability from resolved module-return allocation identity.
 * Static uses become graph edges; any operation that can observe the table shape
 * roots the affected allocation instead of attempting a string-based guess.
 */
export function analyzeWholeProgramExports(
  objects: WholeProgramObjectAnalysis,
  entryModule: string,
  metadataOf: (moduleName: string) => SourceMetadata,
): WholeProgramExportAnalysis {
  const exportObjects = objects.objects.filter(
    (object) => object.kind === "module-return",
  );
  const exportObjectIds = new Set(exportObjects.map((object) => object.id));
  const objectById = new Map(
    exportObjects.map((object) => [object.id, object]),
  );
  const fieldsByObject = new Map<string, Map<string, MutableField>>();
  const definitionMembers = new WeakSet();
  const ownerOfNode = new WeakMap<object, Owner>();
  const callableByDeclaration = new WeakMap<
    Parser.FunctionDeclaration,
    Callable
  >();
  const callSiteByExpression = new WeakMap<object, CallSite>();
  const bodyOfStatement = new WeakMap<Parser.Statement, Parser.Statement[]>();
  const statementOfExpression = new WeakMap<
    Parser.Expression,
    Parser.Statement
  >();
  const boundaryDiagnostics: WholeProgramExportDiagnostic[] = [];
  const objectBoundaryReasons = new Map<
    ProgramObjectIdentity,
    Set<ExportRootReason>
  >();
  const addObjectBoundary = (
    object: ProgramObjectIdentity,
    reason: ExportRootReason,
  ) => {
    const reasons = objectBoundaryReasons.get(object) ?? new Set();
    reasons.add(reason);
    objectBoundaryReasons.set(object, reasons);
  };

  objects.callGraph.calls.forEach((call) =>
    callSiteByExpression.set(call.call, call),
  );
  objects.modules.forEach((module) => {
    indexStatementOwners(
      module.chunk.body,
      bodyOfStatement,
      statementOfExpression,
    );
    module.analysis.callGraph.functions.forEach((callable) => {
      callableByDeclaration.set(callable.declaration, callable);
      callable.declaration.body.forEach((statement) => {
        walkBlockDeep([statement], {
          onStatement: (nested) => ownerOfNode.set(nested, callable),
          onExpression: (expression) => ownerOfNode.set(expression, callable),
        });
      });
    });
  });

  const mutableField = (
    object: ProgramObjectIdentity,
    key: string,
  ): MutableField => {
    let fields = fieldsByObject.get(object.id);
    if (!fields) {
      fields = new Map();
      fieldsByObject.set(object.id, fields);
    }
    let field = fields.get(key);
    if (!field) {
      field = {
        id: `${object.id}:field:${key}`,
        moduleName: object.moduleName,
        object,
        key,
        definitions: [],
        dependencies: new Set(),
        callableDependencies: new Set(),
        shapeDependencies: new Set(),
        rootReasons: new Set(),
        live: false,
      };
      fields.set(key, field);
    }
    return field;
  };

  const exportObjectOf = (
    expression: Parser.Expression,
  ): ProgramObjectIdentity | undefined => {
    const object = objects.objectOf(expression);
    return object && exportObjectIds.has(object.id)
      ? objectById.get(object.id)
      : undefined;
  };

  // Collect every statically named export definition before classifying uses.
  objects.modules.forEach((module) => {
    const metadata = metadataOf(module.name);
    walkBlockDeep(module.chunk.body, {
      onStatement: (statement) => {
        if (
          statement.type === "FunctionDeclaration" &&
          statement.identifier?.type === "MemberExpression"
        ) {
          const object = exportObjectOf(statement.identifier.base);
          if (!object) return;
          const field = mutableField(
            object,
            statement.identifier.identifier.name,
          );
          field.definitions.push({
            kind: "member-function",
            module,
            body: bodyOfStatement.get(statement) ?? module.chunk.body,
            statement,
            value: statement,
          });
          definitionMembers.add(statement.identifier);
          statement.body.forEach((bodyStatement) => {
            walkBlockDeep([bodyStatement], {
              onStatement: (nested) => ownerOfNode.set(nested, field),
              onExpression: (expression) => ownerOfNode.set(expression, field),
            });
          });
          if (
            metadata.annotationsOf(statement).keep ||
            metadata.annotationsOf(statement).exported
          )
            field.rootReasons.add("annotation-root");
          return;
        }
        if (statement.type === "AssignmentStatement") {
          statement.variables.forEach((variable, index) => {
            if (
              variable.type !== "MemberExpression" &&
              variable.type !== "IndexExpression"
            )
              return;
            const object = exportObjectOf(variable.base);
            const value = statement.init.at(index);
            if (!object || !value) return;
            const key =
              variable.type === "MemberExpression"
                ? variable.identifier.name
                : staticStringArgument(variable.index);
            if (key === undefined) {
              addObjectBoundary(object, "dynamic-key");
              return;
            }
            const field = mutableField(object, key);
            field.definitions.push({
              kind: "member-assignment",
              module,
              body: bodyOfStatement.get(statement) ?? module.chunk.body,
              statement,
              value,
            });
            definitionMembers.add(variable);
            markExpressionOwner(value, field, ownerOfNode);
            if (isDynamicRequire(value))
              boundaryDiagnostics.push({
                moduleName: module.name,
                field: key,
                reason: "unresolved-re-export",
                sourceRange: sourceRangeOf(statement),
              });
            if (
              metadata.annotationsOf(statement).keep ||
              metadata.annotationsOf(statement).exported
            )
              field.rootReasons.add("annotation-root");
          });
        }
        if (statement.type === "LocalStatement") {
          statement.init.forEach((initializer) => {
            const object = exportObjectOf(initializer);
            if (
              object &&
              (metadata.annotationsOf(statement).keep ||
                metadata.annotationsOf(statement).exported)
            ) {
              fieldsByObject
                .get(object.id)
                ?.forEach((field) => field.rootReasons.add("annotation-root"));
            }
          });
        }
      },
      onExpression: (expression) => {
        if (expression.type !== "TableConstructorExpression") return;
        const object = exportObjectOf(expression);
        if (!object) return;
        const statement = statementOfExpression.get(expression);
        if (!statement) return;
        expression.fields.forEach((tableField) => {
          if (tableField.type === "TableValue") {
            addObjectBoundary(object, "shape-observation");
            return;
          }
          const key = fieldKey(tableField);
          if (key === undefined) {
            addObjectBoundary(object, "dynamic-key");
            return;
          }
          const field = mutableField(object, key);
          field.definitions.push({
            kind: "table-field",
            module,
            body: bodyOfStatement.get(statement) ?? module.chunk.body,
            statement,
            table: expression,
            field: tableField,
            value: tableField.value,
          });
          markExpressionOwner(tableField.value, field, ownerOfNode);
          if (isDynamicRequire(tableField.value))
            boundaryDiagnostics.push({
              moduleName: module.name,
              field: key,
              reason: "unresolved-re-export",
              sourceRange: sourceRangeOf(tableField),
            });
          const annotations = metadata.annotationsOf(statement);
          if (annotations.keep || annotations.exported)
            field.rootReasons.add("annotation-root");
        });
      },
    });
  });

  const allFields = (): MutableField[] =>
    [...fieldsByObject.values()].flatMap((fields) => [...fields.values()]);
  const rootObject = (
    object: ProgramObjectIdentity,
    reason: ExportRootReason,
  ) => {
    fieldsByObject
      .get(object.id)
      ?.forEach((field) => field.rootReasons.add(reason));
  };
  objectBoundaryReasons.forEach((reasons, object) => {
    reasons.forEach((reason) => {
      rootObject(object, reason);
    });
  });
  const addFieldUse = (
    object: ProgramObjectIdentity,
    key: string,
    owner: Owner | undefined,
  ) => {
    const field = mutableField(object, key);
    if (!owner) field.rootReasons.add("static-field-root");
    else if (isMutableField(owner)) owner.dependencies.add(field);
    else callableFieldDependencies(owner).add(field);
  };

  const fieldsOfCallable = new Map<Callable, Set<MutableField>>();
  const callsOfCallable = new Map<Callable, Set<Callable>>();
  const shapeOfCallable = new Map<Callable, Set<ProgramObjectIdentity>>();
  const callableRoots = new Set<Callable>();
  const callableFieldDependencies = (callable: Callable): Set<MutableField> => {
    let fields = fieldsOfCallable.get(callable);
    if (!fields) {
      fields = new Set();
      fieldsOfCallable.set(callable, fields);
    }
    return fields;
  };
  const callableCallDependencies = (callable: Callable): Set<Callable> => {
    let calls = callsOfCallable.get(callable);
    if (!calls) {
      calls = new Set();
      callsOfCallable.set(callable, calls);
    }
    return calls;
  };
  const callableShapeDependencies = (
    callable: Callable,
  ): Set<ProgramObjectIdentity> => {
    let dependencies = shapeOfCallable.get(callable);
    if (!dependencies) {
      dependencies = new Set();
      shapeOfCallable.set(callable, dependencies);
    }
    return dependencies;
  };

  const addShapeUse = (
    object: ProgramObjectIdentity,
    owner: Owner | undefined,
    reason: ExportRootReason,
  ) => {
    if (!owner) rootObject(object, reason);
    else if (isMutableField(owner)) owner.shapeDependencies.add(object);
    else callableShapeDependencies(owner).add(object);
  };

  objects.modules.forEach((module) => {
    const returned = topLevelReturn(module);
    walkBlockDeep(module.chunk.body, {
      onStatement: (statement) => {
        const owner = ownerOfNode.get(statement);
        if (statement.type === "ReturnStatement") {
          statement.arguments.forEach((argument) => {
            const object = exportObjectOf(argument);
            if (!object) return;
            const isOwnTopLevelReturn =
              returned === statement && object.moduleName === module.name;
            if (!isOwnTopLevelReturn)
              addShapeUse(object, owner, "export-escape");
          });
        }
        if (
          statement.type === "LocalStatement" ||
          statement.type === "AssignmentStatement"
        ) {
          const values =
            statement.type === "LocalStatement"
              ? statement.init
              : statement.init;
          values.forEach((value) => {
            const object = exportObjectOf(value);
            if (!object) return;
            if (statement.type === "AssignmentStatement") {
              const stableAlias = statement.variables.some(
                (variable) =>
                  variable.type === "Identifier" &&
                  sameObject(objects, variable, object),
              );
              if (!stableAlias) addShapeUse(object, owner, "export-escape");
            }
          });
        }
      },
      onExpression: (expression) => {
        const owner = ownerOfNode.get(expression);
        if (expression.type === "MemberExpression") {
          if (definitionMembers.has(expression)) return;
          const object = exportObjectOf(expression.base);
          if (object) addFieldUse(object, expression.identifier.name, owner);
          return;
        }
        if (expression.type === "IndexExpression") {
          if (definitionMembers.has(expression)) return;
          const object = exportObjectOf(expression.base);
          if (!object) return;
          const key = staticStringArgument(expression.index);
          if (key === undefined) addShapeUse(object, owner, "dynamic-key");
          else addFieldUse(object, key, owner);
          return;
        }
        if (
          expression.type === "UnaryExpression" &&
          expression.operator === "#"
        ) {
          const object = exportObjectOf(expression.argument);
          if (object) addShapeUse(object, owner, "shape-observation");
          return;
        }
        if (!isCallExpression(expression)) return;
        const combinedCall = callSiteByExpression.get(expression);
        if (combinedCall) {
          if (!combinedCall.caller)
            combinedCall.targets.forEach((target) => callableRoots.add(target));
          else {
            const caller = combinedCall.caller;
            combinedCall.targets.forEach((target) => {
              callableCallDependencies(caller).add(target);
            });
          }
        }
        if (expression.type !== "CallExpression") return;
        const calleeName =
          expression.base.type === "Identifier"
            ? expression.base.name
            : undefined;
        const shapeObserver = calleeName === "pairs" || calleeName === "next";
        const metatableObserver =
          calleeName === "setmetatable" ||
          calleeName === "getmetatable" ||
          calleeName === "rawget" ||
          calleeName === "rawset";
        const localCall = module.analysis.callGraph.callSiteOf(expression);
        expression.arguments.forEach((argument, argumentIndex) => {
          const object = exportObjectOf(argument);
          if (!object) return;
          if (shapeObserver || metatableObserver)
            addShapeUse(object, owner, "shape-observation");
          else if (
            !localCall ||
            localCall.hasUnknownTarget ||
            localCall.targets.size === 0 ||
            module.analysis.interprocedural.escapesArgument(
              localCall,
              argumentIndex,
            )
          )
            addShapeUse(object, owner, "export-escape");
        });
      },
    });
  });

  // A module with more than one possible return allocation cannot be field-pruned.
  const objectsByModule = new Map<string, ProgramObjectIdentity[]>();
  exportObjects.forEach((object) => {
    const group = objectsByModule.get(object.moduleName) ?? [];
    group.push(object);
    objectsByModule.set(object.moduleName, group);
  });
  objectsByModule.forEach((moduleObjects, moduleName) => {
    if (moduleObjects.length > 1) {
      moduleObjects.forEach((object) => {
        rootObject(object, "multiple-return-allocations");
      });
    }
    if (moduleName === entryModule) {
      moduleObjects.forEach((object) => {
        rootObject(object, "entry-contract");
      });
    }
  });

  // Object invalidation from #83 is also an export-shape observation boundary.
  exportObjects.forEach((object) => {
    if (object.invalidationReasons.size > 0)
      rootObject(object, "export-escape");
  });

  // Function values and helper references participate in the same graph. A
  // reference owned by an export field is an edge, while an unowned reference
  // makes the callable externally reachable.
  objects.modules.forEach((module) => {
    module.analysis.callGraph.functions.forEach((callable) => {
      callable.symbol?.references.forEach((reference) => {
        const owner = ownerOfNode.get(reference);
        if (!owner) callableRoots.add(callable);
        else if (isMutableField(owner))
          owner.callableDependencies.add(callable);
        else callableCallDependencies(owner).add(callable);
      });
    });
  });
  allFields().forEach((field) => {
    field.definitions.forEach((definition) => {
      const expression = definition.value;
      if (expression.type !== "Identifier") return;
      const symbol = definition.module.resolved.symbolOf(expression);
      const callable = symbol
        ? definition.module.analysis.callGraph.functionOfSymbol(symbol)
        : undefined;
      if (callable) field.callableDependencies.add(callable);
    });
  });

  const liveCallables = new Set<Callable>();
  const callableQueue = [...callableRoots];
  const fieldQueue = allFields().filter((field) => field.rootReasons.size > 0);
  const enqueueObject = (object: ProgramObjectIdentity) => {
    fieldsByObject.get(object.id)?.forEach((field) => {
      if (!field.live) fieldQueue.push(field);
    });
  };
  while (fieldQueue.length > 0 || callableQueue.length > 0) {
    while (fieldQueue.length > 0) {
      const field = fieldQueue.shift();
      if (!field) break;
      if (field.live) continue;
      field.live = true;
      field.dependencies.forEach((dependency) => {
        if (!dependency.live) fieldQueue.push(dependency);
      });
      field.callableDependencies.forEach((callable) =>
        callableQueue.push(callable),
      );
      field.shapeDependencies.forEach(enqueueObject);
      field.definitions.forEach((definition) => {
        const callable =
          definition.value.type === "FunctionDeclaration"
            ? callableByDeclaration.get(definition.value)
            : undefined;
        if (callable) callableQueue.push(callable);
        const reExport = exportObjectOf(definition.value);
        if (reExport && reExport.id !== field.object.id)
          enqueueObject(reExport);
      });
    }
    while (callableQueue.length > 0) {
      const callable = callableQueue.shift();
      if (!callable) break;
      if (liveCallables.has(callable)) continue;
      liveCallables.add(callable);
      callableFieldDependencies(callable).forEach((field) => {
        if (!field.live) fieldQueue.push(field);
      });
      callableCallDependencies(callable).forEach((target) =>
        callableQueue.push(target),
      );
      callableShapeDependencies(callable).forEach(enqueueObject);
    }
  }

  const fields = allFields().sort((left, right) =>
    left.id.localeCompare(right.id),
  );
  const diagnostics: WholeProgramExportDiagnostic[] = [...boundaryDiagnostics];
  fields.forEach((field) => {
    diagnostics.push({
      moduleName: field.moduleName,
      field: field.key,
      reason: "export-field-candidate",
      sourceRange: sourceRangeOf(field.definitions[0]?.statement ?? {}),
    });
    [...field.rootReasons].sort().forEach((reason) =>
      diagnostics.push({
        moduleName: field.moduleName,
        field: field.key,
        reason,
        sourceRange: sourceRangeOf(field.definitions[0]?.statement ?? {}),
      }),
    );
    diagnostics.push({
      moduleName: field.moduleName,
      field: field.key,
      reason: field.live ? "field-live" : "field-unreachable",
      sourceRange: sourceRangeOf(field.definitions[0]?.statement ?? {}),
    });
  });

  return {
    generation: objects.generation,
    fields: fields.map((field) => ({
      id: field.id,
      moduleName: field.moduleName,
      object: field.object,
      key: field.key,
      definitions: field.definitions,
      live: field.live,
      rootReasons: field.rootReasons,
    })),
    diagnostics,
  };
}

function indexStatementOwners(
  body: Parser.Statement[],
  bodyOfStatement: WeakMap<Parser.Statement, Parser.Statement[]>,
  statementOfExpression: WeakMap<Parser.Expression, Parser.Statement>,
): void {
  body.forEach((statement) => {
    bodyOfStatement.set(statement, body);
    walkStatement(statement, {
      onExpression: (expression) => {
        statementOfExpression.set(expression, statement);
      },
      onBlock: (nested) => {
        indexStatementOwners(nested, bodyOfStatement, statementOfExpression);
      },
    });
  });
}

function isDynamicRequire(expression: Parser.Expression): boolean {
  return (
    expression.type === "CallExpression" &&
    expression.base.type === "Identifier" &&
    expression.base.name === "require" &&
    staticStringArgument(expression.arguments[0]) === undefined
  );
}

function isMutableField(owner: Owner): owner is MutableField {
  return "definitions" in owner && "dependencies" in owner;
}

function callStatement(
  expression:
    | Parser.CallExpression
    | Parser.TableCallExpression
    | Parser.StringCallExpression,
): Parser.CallStatement {
  return {
    type: "CallStatement",
    expression,
    loc: expression.loc,
    range: sourceRangeOf(expression),
  } as Parser.CallStatement;
}

/** Apply one already-proved reachability snapshot without rebuilding analysis. */
export function applyWholeProgramExportDce(
  analysis: WholeProgramExportAnalysis,
  metadataOf: (moduleName: string) => SourceMetadata,
  discardable: (moduleName: string, expression: Parser.Expression) => boolean,
): WholeProgramExportRewriteResult {
  const replacements = new Map<Parser.Statement, Parser.Statement[]>();
  const removedTableFields = new Map<
    Parser.TableConstructorExpression,
    Set<Parser.TableKey | Parser.TableKeyString>
  >();
  const removedFields: ExportFieldIdentity[] = [];
  const preservedEffectFields = new Set<ExportFieldIdentity>();
  const refusedEffectfulInitializerFields: ExportFieldIdentity[] = [];

  analysis.fields.forEach((field) => {
    if (field.live || field.definitions.length === 0) return;
    const canRemove = field.definitions.every((definition) => {
      if (definition.kind === "table-field")
        return discardable(definition.module.name, definition.value);
      if (definition.kind === "member-function") return true;
      return (
        definition.statement.variables.length === 1 &&
        definition.statement.init.length === 1 &&
        (discardable(definition.module.name, definition.value) ||
          isCallExpression(definition.value))
      );
    });
    if (!canRemove) {
      refusedEffectfulInitializerFields.push(field);
      return;
    }
    const planned: (() => void)[] = [];
    field.definitions.forEach((definition) => {
      if (definition.kind === "table-field") {
        planned.push(() => {
          const removed = removedTableFields.get(definition.table) ?? new Set();
          removed.add(definition.field);
          removedTableFields.set(definition.table, removed);
        });
        return;
      }
      if (definition.kind === "member-function") {
        planned.push(() => replacements.set(definition.statement, []));
        return;
      }
      if (
        definition.statement.variables.length !== 1 ||
        definition.statement.init.length !== 1
      ) {
        return;
      }
      if (discardable(definition.module.name, definition.value)) {
        planned.push(() => replacements.set(definition.statement, []));
      } else if (isCallExpression(definition.value)) {
        planned.push(() => {
          replacements.set(definition.statement, [
            callStatement(
              definition.value as
                | Parser.CallExpression
                | Parser.TableCallExpression
                | Parser.StringCallExpression,
            ),
          ]);
          preservedEffectFields.add(field);
        });
      } else {
        return;
      }
    });
    planned.forEach((apply) => {
      apply();
    });
    removedFields.push(field);
  });

  removedTableFields.forEach((removed, table) => {
    table.fields = table.fields.filter(
      (field) => field.type === "TableValue" || !removed.has(field),
    );
  });
  analysis.fields.forEach((field) => {
    field.definitions.forEach((definition) => {
      const replacement = replacements.get(definition.statement);
      if (replacement === undefined) return;
      const body = definition.body;
      const index = body.indexOf(definition.statement);
      if (index < 0) return;
      const metadata = metadataOf(definition.module.name);
      if (replacement.length > 0)
        metadata.replaceStatement(definition.statement, replacement);
      else metadata.removeStatement(definition.statement, body[index + 1]);
      body.splice(index, 1, ...replacement);
    });
  });
  return {
    changed: removedFields.length > 0,
    removedFields,
    preservedEffectFields: [...preservedEffectFields],
    refusedEffectfulInitializerFields,
  };
}
