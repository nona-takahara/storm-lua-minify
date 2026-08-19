import Parser from "luaparse";
import { ResolveResult } from "./resolver";
import { SourceMetadata } from "./sourceMetadata";

function rangeOf(node: object): [number, number] | undefined {
  return (node as { range?: [number, number] }).range;
}

function nestedBodies(statement: Parser.Statement): Parser.Statement[][] {
  switch (statement.type) {
    case "DoStatement":
    case "WhileStatement":
    case "RepeatStatement":
    case "FunctionDeclaration":
    case "ForNumericStatement":
    case "ForGenericStatement":
      return [statement.body];
    case "IfStatement":
      return statement.clauses.map((clause) => clause.body);
    default:
      return [];
  }
}

function removableInitializer(statement: Parser.LocalStatement): boolean {
  if (statement.variables.length !== 1) return false;
  if (statement.init.length === 0) return true;
  if (statement.init.length !== 1) return false;
  switch (statement.init[0].type) {
    case "NilLiteral":
    case "BooleanLiteral":
    case "NumericLiteral":
    case "StringLiteral":
    case "FunctionDeclaration":
      return true;
    default:
      return false;
  }
}

function hasExternalReference(
  statement: Parser.FunctionDeclaration,
  references: readonly Parser.Identifier[],
): boolean {
  const range = rangeOf(statement);
  if (!range) return references.length > 0;
  return references.some((reference) => {
    const position = rangeOf(reference)?.[0];
    return (
      position === undefined || position < range[0] || position >= range[1]
    );
  });
}

function removeFromBlock(
  body: Parser.Statement[],
  resolved: ResolveResult,
  metadata: SourceMetadata,
): boolean {
  let changed = false;
  body.forEach((statement) => {
    nestedBodies(statement).forEach((nested) => {
      changed = removeFromBlock(nested, resolved, metadata) || changed;
    });
  });

  const removed = new Set<Parser.Statement>();
  const kept = body.filter((statement) => {
    if (metadata.annotationsOf(statement).keep) return true;
    if (
      statement.type === "FunctionDeclaration" &&
      statement.isLocal &&
      statement.identifier?.type === "Identifier"
    ) {
      const symbol = resolved.symbolOf(statement.identifier);
      if (symbol && !hasExternalReference(statement, symbol.references)) {
        changed = true;
        removed.add(statement);
        return false;
      }
    }
    if (
      statement.type === "LocalStatement" &&
      removableInitializer(statement)
    ) {
      const symbol = resolved.symbolOf(statement.variables[0]);
      if (symbol && symbol.references.length === 0) {
        changed = true;
        removed.add(statement);
        return false;
      }
    }
    return true;
  });
  if (kept.length !== body.length) {
    body.forEach((statement, index) => {
      if (!removed.has(statement)) return;
      const next = body
        .slice(index + 1)
        .find((candidate) => !removed.has(candidate));
      metadata.removeStatement(statement, next);
    });
    body.splice(0, body.length, ...kept);
  }
  return changed;
}

export function removeUnusedLocals(
  chunk: Parser.Chunk,
  resolved: ResolveResult,
  metadata: SourceMetadata,
): boolean {
  return removeFromBlock(chunk.body, resolved, metadata);
}
