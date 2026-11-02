import Parser from "luaparse";

function rangeOf(node: object): [number, number] | undefined {
  return (node as { range?: [number, number] }).range;
}

/** 合成・複製したAST nodeへSource Map上の由来位置を引き継ぐ。 */
export function copyNodeOrigin(node: Parser.Node, origin: Parser.Node): void {
  node.loc = origin.loc;
  const range = rangeOf(origin);
  if (range) {
    (node as { range?: [number, number] }).range = range;
  }
}

export function identifierWithOrigin(
  origin: Parser.Identifier,
): Parser.Identifier {
  const identifier: Parser.Identifier = {
    type: "Identifier",
    name: origin.name,
  };
  copyNodeOrigin(identifier, origin);
  return identifier;
}

// Identity, unlike loc/range, distinguishes generated variants sharing an origin
// position. Weak keys keep this compilation metadata out of the printable AST.
const functionOrigins = new WeakMap<
  Parser.FunctionDeclaration,
  Parser.FunctionDeclaration
>();

export function functionOriginOf(
  declaration: Parser.FunctionDeclaration,
): Parser.FunctionDeclaration {
  return functionOrigins.get(declaration) ?? declaration;
}

/** Preserve callable lineage when inline copies nested declarations. */
export function cloneWithFunctionOrigins<T>(source: T): T {
  const copy = structuredClone(source);
  const visit = (original: unknown, copied: unknown): void => {
    if (
      !original ||
      !copied ||
      typeof original !== "object" ||
      typeof copied !== "object"
    )
      return;
    if ((original as Parser.Node).type === "FunctionDeclaration") {
      functionOrigins.set(
        copied as Parser.FunctionDeclaration,
        functionOriginOf(original as Parser.FunctionDeclaration),
      );
    }
    Object.keys(original).forEach((key) => {
      visit(
        (original as Record<string, unknown>)[key],
        (copied as Record<string, unknown>)[key],
      );
    });
  };
  visit(source, copy);
  return copy;
}
