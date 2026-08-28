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
