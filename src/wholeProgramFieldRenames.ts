import Parser from "luaparse";
import { walkBlockDeep } from "./astWalk";
import { generateCandidate, isAvailable } from "./renamer";
import { SourceMetadata } from "./sourceMetadata";
import { WholeProgramExportAnalysis } from "./wholeProgramExports";
import { WholeProgramFieldAnalysis } from "./wholeProgramFields";
import {
  ProgramObjectIdentity,
  WholeProgramObjectAnalysis,
} from "./wholeProgramObjects";

export type FieldRenameReason =
  | "field-candidate"
  | "equivalence-class"
  | "key-transfer"
  | "key-reused"
  | "field-renamed"
  | "reserved-key"
  | "keep-name"
  | "external-contract"
  | "dynamic-key"
  | "unknown-call"
  | "object-escape"
  | "metatable-observation"
  | "key-data-observation"
  | "iteration-order-observation"
  | "name-collision"
  | "nonpositive-cost";

export interface WholeProgramFieldRenameDiagnostic {
  readonly moduleName: string;
  readonly field?: string;
  readonly reason: FieldRenameReason;
  readonly accepted: boolean;
  readonly sourceRange?: readonly [number, number];
}

export interface WholeProgramFieldRenamePlan {
  readonly generation: number;
  readonly candidateFields: number;
  readonly equivalenceClasses: number;
  readonly keyTransfers: number;
  readonly shortenedFields: number;
  readonly reusedKeys: number;
  readonly diagnostics: readonly WholeProgramFieldRenameDiagnostic[];
  nameOf(node: Parser.Identifier | Parser.StringLiteral): string | undefined;
  originalNameOf(
    node: Parser.Identifier | Parser.StringLiteral,
  ): string | undefined;
}

interface FieldSite {
  readonly node: Parser.Identifier | Parser.StringLiteral;
  readonly moduleName: string;
  readonly object: ProgramObjectIdentity;
  readonly field: string;
  readonly form: "identifier" | "string";
  readonly statement?: Parser.Statement;
}

interface MutableField {
  readonly id: string;
  readonly object: ProgramObjectIdentity;
  readonly field: string;
  readonly sites: FieldSite[];
  readonly reasons: Set<FieldRenameReason>;
}

const RUNTIME_RESERVED_KEYS = new Set([
  "__add",
  "__band",
  "__bnot",
  "__bor",
  "__bxor",
  "__call",
  "__concat",
  "__div",
  "__eq",
  "__gc",
  "__idiv",
  "__index",
  "__le",
  "__len",
  "__lt",
  "__metatable",
  "__mod",
  "__mode",
  "__mul",
  "__name",
  "__newindex",
  "__pairs",
  "__pow",
  "__shl",
  "__shr",
  "__sub",
  "__tostring",
  "__unm",
]);

function sourceRangeOf(node: object): readonly [number, number] | undefined {
  return (node as { range?: readonly [number, number] }).range;
}

function staticFieldName(expression: Parser.Expression): string | undefined {
  if (expression.type !== "StringLiteral") return undefined;
  const raw = expression.raw;
  const quote = raw.at(0);
  if (
    (quote !== '"' && quote !== "'") ||
    raw.at(-1) !== quote ||
    raw.slice(1, -1).includes("\\")
  )
    return undefined;
  return raw.slice(1, -1);
}

class DisjointSet {
  private readonly parent = new Map<string, string>();

  add(value: string): void {
    if (!this.parent.has(value)) this.parent.set(value, value);
  }

  find(value: string): string {
    this.add(value);
    const parent = this.parent.get(value) as string;
    if (parent === value) return value;
    const root = this.find(parent);
    this.parent.set(value, root);
    return root;
  }

  union(left: string, right: string): boolean {
    const leftRoot = this.find(left);
    const rightRoot = this.find(right);
    if (leftRoot === rightRoot) return false;
    const [root, child] = [leftRoot, rightRoot].sort();
    this.parent.set(child, root);
    return true;
  }
}

/**
 * Build one immutable runtime-key plan for the final linked AST generation.
 * The planner never guesses an object or a dynamic key: an unclassified use
 * fixes the complete affected shape instead.
 */
export function planWholeProgramFieldRenames(
  objects: WholeProgramObjectAnalysis,
  fields: WholeProgramFieldAnalysis,
  exports: WholeProgramExportAnalysis,
  entryModule: string,
  metadataOf: (moduleName: string) => SourceMetadata,
): WholeProgramFieldRenamePlan {
  if (
    objects.generation !== fields.generation ||
    objects.generation !== exports.generation
  )
    throw new Error("Field rename planning requires one AST generation");

  const mutable = new Map<string, MutableField>();
  const union = new DisjointSet();
  const statementOfNode = new WeakMap<object, Parser.Statement>();
  const diagnostics: WholeProgramFieldRenameDiagnostic[] = [];
  const objectReasons = new Map<string, Set<FieldRenameReason>>();
  const unresolvedStaticFields = new Set<string>();
  const safeDynamicIndices = new WeakSet<Parser.IndexExpression>();
  const transferByStatement = new WeakMap<
    Parser.ForGenericStatement,
    ReturnType<typeof keyTransferOf>
  >();
  const fieldId = (object: ProgramObjectIdentity, field: string) =>
    `${object.id}\0${field}`;
  const candidateObjectsOf = (
    expression: Parser.Expression,
  ): readonly ProgramObjectIdentity[] => {
    const candidates = objects.objectsOf(expression);
    if (candidates.length > 0) return candidates;
    const single = objects.objectOf(expression);
    return single ? [single] : [];
  };
  const getField = (
    object: ProgramObjectIdentity,
    field: string,
  ): MutableField => {
    const id = fieldId(object, field);
    let value = mutable.get(id);
    if (!value) {
      value = { id, object, field, sites: [], reasons: new Set() };
      mutable.set(id, value);
      union.add(id);
    }
    return value;
  };
  const keepObject = (
    object: ProgramObjectIdentity,
    reason: FieldRenameReason,
  ) => {
    const reasons = objectReasons.get(object.id) ?? new Set();
    reasons.add(reason);
    objectReasons.set(object.id, reasons);
    mutable.forEach((field) => {
      if (field.object.id === object.id) field.reasons.add(reason);
    });
  };

  objects.modules.forEach((module) => {
    walkBlockDeep(module.chunk.body, {
      onStatement: (statement) => {
        if (statement.type !== "ForGenericStatement") return;
        const transfer = keyTransferOf(statement, module.resolved, objects);
        transferByStatement.set(statement, transfer);
        if (transfer?.closed) {
          transfer.indices.forEach((index) => safeDynamicIndices.add(index));
          return;
        }
        statement.iterators.forEach((iterator) => {
          if (iterator.type !== "CallExpression") return;
          iterator.arguments.forEach((argument) => {
            candidateObjectsOf(argument).forEach((object) => {
              keepObject(object, "iteration-order-observation");
            });
          });
        });
      },
    });
  });

  objects.modules.forEach((module) => {
    const indexBlock = (body: readonly Parser.Statement[]) => {
      body.forEach((statement) => {
        statementOfNode.set(statement, statement);
        walkExpressionOwners(statement, statement, statementOfNode);
      });
    };
    indexBlock(module.chunk.body);
    walkBlockDeep(module.chunk.body, {
      onBlock: indexBlock,
      onExpression: (expression) => {
        if (expression.type === "MemberExpression") {
          const candidateObjects = candidateObjectsOf(expression.base);
          if (candidateObjects.length === 0) {
            unresolvedStaticFields.add(expression.identifier.name);
            diagnostics.push({
              moduleName: module.name,
              field: expression.identifier.name,
              reason: "unknown-call",
              accepted: false,
              sourceRange: sourceRangeOf(expression),
            });
            return;
          }
          const related = candidateObjects.map((object) =>
            getField(object, expression.identifier.name),
          );
          for (let index = 1; index < related.length; index++)
            union.union(related[0].id, related[index].id);
          related.forEach((field) => {
            field.sites.push({
              node: expression.identifier,
              moduleName: module.name,
              object: field.object,
              field: expression.identifier.name,
              form: "identifier",
              statement: statementOfNode.get(expression),
            });
          });
          return;
        }
        if (expression.type === "IndexExpression") {
          const candidateObjects = candidateObjectsOf(expression.base);
          if (candidateObjects.length === 0) {
            const key = staticFieldName(expression.index);
            if (key !== undefined) {
              unresolvedStaticFields.add(key);
              diagnostics.push({
                moduleName: module.name,
                field: key,
                reason: "unknown-call",
                accepted: false,
                sourceRange: sourceRangeOf(expression),
              });
            }
            return;
          }
          const key = staticFieldName(expression.index);
          if (key === undefined) {
            if (!safeDynamicIndices.has(expression))
              candidateObjects.forEach((object) => {
                keepObject(object, "dynamic-key");
              });
            return;
          }
          if (expression.index.type !== "StringLiteral") return;
          const node = expression.index;
          const related = candidateObjects.map((object) =>
            getField(object, key),
          );
          for (let index = 1; index < related.length; index++)
            union.union(related[0].id, related[index].id);
          related.forEach((field) => {
            field.sites.push({
              node,
              moduleName: module.name,
              object: field.object,
              field: key,
              form: "string",
              statement: statementOfNode.get(expression),
            });
          });
          return;
        }
        if (expression.type !== "TableConstructorExpression") return;
        const object = objects.objectOf(expression);
        if (!object) return;
        expression.fields.forEach((tableField) => {
          if (tableField.type === "TableValue") {
            keepObject(object, "key-data-observation");
            return;
          }
          const key =
            tableField.type === "TableKeyString"
              ? tableField.key.name
              : staticFieldName(tableField.key);
          if (key === undefined) {
            keepObject(object, "dynamic-key");
            return;
          }
          const node =
            tableField.type === "TableKeyString"
              ? tableField.key
              : tableField.key.type === "StringLiteral"
                ? tableField.key
                : undefined;
          if (!node) return;
          getField(object, key).sites.push({
            node,
            moduleName: module.name,
            object,
            field: key,
            form:
              tableField.type === "TableKeyString" ? "identifier" : "string",
            statement: statementOfNode.get(expression),
          });
        });
      },
    });
  });

  // Shared facts contribute fields even when a remaining syntax site exists
  // only on a related prototype or allocation.
  fields.facts.forEach((fact) => getField(fact.object, fact.field));
  exports.fields.forEach((field) => getField(field.object, field.key));
  objects.objects.forEach((object) => {
    object.methods.forEach((_callable, name) => getField(object, name));
  });

  // A derived allocation receives every source key. Equal keys are one runtime
  // relation; different keys still coexist on the derived shape and collide.
  let changed = true;
  while (changed) {
    changed = false;
    objects.objects.forEach((object) => {
      object.sources.forEach((source) => {
        [...mutable.values()]
          .filter((field) => field.object.id === source.id)
          .forEach((sourceField) => {
            const target = getField(object, sourceField.field);
            if (union.union(sourceField.id, target.id)) changed = true;
          });
      });
    });
  }

  let keyTransfers = objects.objects.reduce(
    (count, object) => count + object.sources.length,
    0,
  );
  objects.modules.forEach((module) => {
    walkBlockDeep(module.chunk.body, {
      onStatement: (statement) => {
        if (statement.type !== "ForGenericStatement") return;
        const transfer = transferByStatement.get(statement);
        if (!transfer) return;
        if (!transfer.closed) {
          transfer.objects.forEach((object) => {
            keepObject(object, transfer.reason);
          });
          return;
        }
        keyTransfers++;
        const names = new Set(
          [...mutable.values()]
            .filter((field) =>
              transfer.objects.some((object) => object.id === field.object.id),
            )
            .map((field) => field.field),
        );
        names.forEach((name) => {
          const related = transfer.objects.map((object) =>
            getField(object, name),
          );
          for (let index = 1; index < related.length; index++) {
            union.union(related[0].id, related[index].id);
          }
        });
        transfer.comparisons.forEach(({ literal, field }) => {
          const comparisonFields =
            transfer.objects.length > 0
              ? transfer.objects.map((object) => getField(object, field))
              : [...mutable.values()].filter(
                  (candidate) => candidate.field === field,
                );
          for (let index = 1; index < comparisonFields.length; index++)
            union.union(comparisonFields[0].id, comparisonFields[index].id);
          comparisonFields.slice(0, 1).forEach((comparisonField) => {
            comparisonField.sites.push({
              node: literal,
              moduleName: module.name,
              object: comparisonField.object,
              field,
              form: "string",
              statement,
            });
          });
        });
      },
    });
  });

  mutable.forEach((field) => {
    objectReasons
      .get(field.object.id)
      ?.forEach((reason) => field.reasons.add(reason));
    if (RUNTIME_RESERVED_KEYS.has(field.field) || field.field.startsWith("__"))
      field.reasons.add("reserved-key");
    if (unresolvedStaticFields.has(field.field))
      field.reasons.add("unknown-call");
    field.object.invalidationReasons.forEach((reason) => {
      field.reasons.add(
        reason === "metatable-mutation"
          ? "metatable-observation"
          : reason === "instance-escape" || reason === "prototype-escape"
            ? "object-escape"
            : reason === "dynamic-key"
              ? "dynamic-key"
              : "unknown-call",
      );
    });
    field.sites.forEach((site) => {
      if (
        site.statement &&
        metadataOf(site.moduleName).annotationsOf(site.statement).keepName
      )
        field.reasons.add("keep-name");
    });
  });

  exports.fields.forEach((field) => {
    if (
      field.object.moduleName === entryModule ||
      [...field.rootReasons].some((reason) =>
        ["entry-contract", "annotation-root", "export-escape"].includes(reason),
      )
    )
      getField(field.object, field.key).reasons.add("external-contract");
  });

  const membersByRoot = new Map<string, MutableField[]>();
  mutable.forEach((field) => {
    const root = union.find(field.id);
    const members = membersByRoot.get(root) ?? [];
    members.push(field);
    membersByRoot.set(root, members);
  });
  const classes = [...membersByRoot.values()].sort((left, right) =>
    left[0].id.localeCompare(right[0].id),
  );
  const classOfField = new Map<string, number>();
  classes.forEach((members, index) => {
    members.forEach((member) => {
      classOfField.set(member.id, index);
    });
  });
  const collision = classes.map(() => new Set<number>());
  const classesByObject = new Map<string, Set<number>>();
  mutable.forEach((field) => {
    const index = classOfField.get(field.id) as number;
    const group = classesByObject.get(field.object.id) ?? new Set();
    group.add(index);
    classesByObject.set(field.object.id, group);
  });
  classesByObject.forEach((indices) => {
    indices.forEach((left) => {
      indices.forEach((right) => {
        if (left !== right) collision[left].add(right);
      });
    });
  });

  const names = new Map<number, string>();
  const fixedNames = classes.map(
    (members) =>
      new Set(
        members.filter((field) => field.reasons.size > 0).map((f) => f.field),
      ),
  );
  const weight = (members: readonly MutableField[]) =>
    members.reduce(
      (sum, field) =>
        sum +
        field.sites.reduce((siteSum, site) => siteSum + site.field.length, 0),
      0,
    );
  const order = classes
    .map((members, index) => ({ members, index, weight: weight(members) }))
    .sort(
      (left, right) => right.weight - left.weight || left.index - right.index,
    );
  order.forEach(({ members, index }) => {
    if (
      fixedNames[index].size > 0 ||
      members.every((field) => field.sites.length === 0)
    )
      return;
    const unavailable = new Set<string>();
    collision[index].forEach((other) => {
      const chosen = names.get(other);
      if (chosen) unavailable.add(chosen);
      fixedNames[other].forEach((name) => unavailable.add(name));
      classes[other].forEach((field) => unavailable.add(field.field));
    });
    let counter = 0;
    let candidate = generateCandidate(counter++);
    while (!isAvailable(candidate, unavailable))
      candidate = generateCandidate(counter++);
    const originalBytes = members.reduce(
      (sum, field) => sum + field.sites.length * field.field.length,
      0,
    );
    const candidateBytes = members.reduce(
      (sum, field) => sum + field.sites.length * candidate.length,
      0,
    );
    if (candidateBytes >= originalBytes) {
      members.forEach((field) => field.reasons.add("nonpositive-cost"));
      return;
    }
    names.set(index, candidate);
  });

  const renameByNode = new WeakMap<
    Parser.Identifier | Parser.StringLiteral,
    string
  >();
  const originalByNode = new WeakMap<
    Parser.Identifier | Parser.StringLiteral,
    string
  >();
  classes.forEach((members, index) => {
    const name = names.get(index);
    members.forEach((field) => {
      diagnostics.push({
        moduleName: field.object.moduleName,
        field: field.field,
        reason: "field-candidate",
        accepted: true,
        sourceRange: sourceRangeOf(field.sites[0]?.node ?? {}),
      });
      [...field.reasons].sort().forEach((reason) =>
        diagnostics.push({
          moduleName: field.object.moduleName,
          field: field.field,
          reason,
          accepted: false,
          sourceRange: sourceRangeOf(field.sites[0]?.node ?? {}),
        }),
      );
      if (!name) return;
      field.sites.forEach((site) => {
        renameByNode.set(site.node, name);
        originalByNode.set(site.node, site.field);
      });
      diagnostics.push({
        moduleName: field.object.moduleName,
        field: field.field,
        reason: "field-renamed",
        accepted: true,
        sourceRange: sourceRangeOf(field.sites[0]?.node ?? {}),
      });
    });
    if (members.length > 1)
      diagnostics.push({
        moduleName: members[0].object.moduleName,
        field: members[0].field,
        reason: "equivalence-class",
        accepted: true,
        sourceRange: sourceRangeOf(members[0].sites[0]?.node ?? {}),
      });
  });
  const usedNames = [...names.values()];
  const reusedKeys = usedNames.length - new Set(usedNames).size;
  if (keyTransfers > 0)
    diagnostics.push({
      moduleName: entryModule,
      reason: "key-transfer",
      accepted: true,
    });
  if (reusedKeys > 0)
    diagnostics.push({
      moduleName: entryModule,
      reason: "key-reused",
      accepted: true,
    });
  return {
    generation: objects.generation,
    candidateFields: mutable.size,
    equivalenceClasses: classes.length,
    keyTransfers,
    shortenedFields: names.size,
    reusedKeys,
    diagnostics: diagnostics.sort(
      (left, right) =>
        left.moduleName.localeCompare(right.moduleName) ||
        (left.field ?? "").localeCompare(right.field ?? "") ||
        left.reason.localeCompare(right.reason),
    ),
    nameOf: (node) => renameByNode.get(node),
    originalNameOf: (node) => originalByNode.get(node),
  };
}

function walkExpressionOwners(
  statement: Parser.Statement,
  owner: Parser.Statement,
  target: WeakMap<object, Parser.Statement>,
): void {
  walkBlockDeep([statement], {
    onStatement: (nested) => target.set(nested, nested),
    onExpression: (expression) => target.set(expression, owner),
  });
}

function keyTransferOf(
  statement: Parser.ForGenericStatement,
  resolved: WholeProgramObjectAnalysis["modules"][number]["resolved"],
  objects: WholeProgramObjectAnalysis,
):
  | {
      readonly closed: true;
      readonly objects: readonly ProgramObjectIdentity[];
      readonly comparisons: readonly {
        literal: Parser.StringLiteral;
        field: string;
      }[];
      readonly indices: readonly Parser.IndexExpression[];
    }
  | {
      readonly closed: false;
      readonly objects: readonly ProgramObjectIdentity[];
      readonly reason: "key-data-observation" | "iteration-order-observation";
    }
  | undefined {
  const keyVariable = statement.variables.at(0);
  if (!keyVariable) return undefined;
  const keySymbol = resolved.symbolOf(keyVariable);
  if (!keySymbol) return undefined;
  let sources: readonly ProgramObjectIdentity[] = [];
  let recognizedIterator = false;
  const first = statement.iterators.at(0);
  if (
    first?.type === "CallExpression" &&
    first.base.type === "Identifier" &&
    first.base.name === "pairs"
  ) {
    recognizedIterator = true;
    sources = first.arguments[0] ? objects.objectsOf(first.arguments[0]) : [];
  } else if (
    first?.type === "Identifier" &&
    first.name === "next" &&
    statement.iterators[1]
  ) {
    recognizedIterator = true;
    sources = objects.objectsOf(statement.iterators[1]);
  }
  if (!recognizedIterator) return undefined;

  const related = new Map<string, ProgramObjectIdentity>();
  sources.forEach((source) => related.set(source.id, source));
  const allowedReferences = new WeakSet<Parser.Identifier>();
  const comparisons: { literal: Parser.StringLiteral; field: string }[] = [];
  const indices: Parser.IndexExpression[] = [];
  const observableOrder = { value: false };
  walkBlockDeep(statement.body, {
    onStatement: (nested) => {
      if (
        nested.type === "CallStatement" ||
        nested.type === "ReturnStatement" ||
        nested.type === "BreakStatement"
      )
        observableOrder.value = true;
    },
    onExpression: (expression) => {
      if (
        expression.type === "CallExpression" &&
        !(
          expression.base.type === "Identifier" &&
          expression.base.name === "type"
        )
      )
        observableOrder.value = true;
      if (expression.type === "IndexExpression") {
        if (
          expression.index.type === "Identifier" &&
          resolved.symbolOf(expression.index) === keySymbol
        ) {
          const candidateObjects = objects.objectsOf(expression.base);
          allowedReferences.add(expression.index);
          indices.push(expression);
          candidateObjects.forEach((object) => related.set(object.id, object));
        }
        return;
      }
      if (
        expression.type === "BinaryExpression" &&
        (expression.operator === "==" || expression.operator === "~=")
      ) {
        const pair = [expression.left, expression.right] as const;
        const identifier = pair.find(
          (item): item is Parser.Identifier =>
            item.type === "Identifier" && resolved.symbolOf(item) === keySymbol,
        );
        const literal = pair.find(
          (item): item is Parser.StringLiteral => item.type === "StringLiteral",
        );
        if (identifier && literal) {
          const field = staticFieldName(literal);
          if (field !== undefined) {
            allowedReferences.add(identifier);
            comparisons.push({ literal, field });
          }
        }
      }
    },
  });
  const unclassified = keySymbol.references.some(
    (reference) =>
      (sourceRangeOf(reference)?.[0] ?? -1) >=
        (sourceRangeOf(statement)?.[0] ?? 0) &&
      (sourceRangeOf(reference)?.[1] ?? Infinity) <=
        (sourceRangeOf(statement)?.[1] ?? 0) &&
      !allowedReferences.has(reference),
  );
  if (observableOrder.value)
    return {
      closed: false,
      objects: [...related.values()],
      reason: "iteration-order-observation",
    };
  if (unclassified)
    return {
      closed: false,
      objects: [...related.values()],
      reason: "key-data-observation",
    };
  return {
    closed: true,
    objects: [...related.values()],
    comparisons,
    indices,
  };
}
