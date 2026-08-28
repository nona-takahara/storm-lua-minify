import Parser from "luaparse";

/**
 * リンク後に合成するASTで、対象モジュールの本体をこの位置へ挿入することを表す。
 * 生成済み文字列を保持しないため、将来はコード生成より前に通常ASTへ実体化できる。
 */
export interface ModuleSplice {
  type: "ModuleSplice";
  moduleName: string;
}

export type GeneratedStatement = Parser.Statement | ModuleSplice;

const identifier = (name: string): Parser.Identifier => ({
  type: "Identifier",
  name,
});

const member = (
  base: Parser.Expression,
  name: string,
): Parser.MemberExpression => ({
  type: "MemberExpression",
  indexer: ".",
  identifier: identifier(name),
  base,
});

const index = (
  base: Parser.Expression,
  key: Parser.Expression,
): Parser.IndexExpression => ({ type: "IndexExpression", base, index: key });

const loaded = (): Parser.MemberExpression =>
  member(identifier("package"), "loaded");

const loadedAtM = (): Parser.IndexExpression =>
  index(loaded(), identifier("m"));

const assignment = (
  variable:
    Parser.Identifier | Parser.MemberExpression | Parser.IndexExpression,
  value: Parser.Expression,
): Parser.AssignmentStatement => ({
  type: "AssignmentStatement",
  variables: [variable],
  init: [value],
});

const logical = (
  operator: "and" | "or",
  left: Parser.Expression,
  right: Parser.Expression,
): Parser.LogicalExpression => ({
  type: "LogicalExpression",
  operator,
  left,
  right,
});

const truth: Parser.BooleanLiteral = {
  type: "BooleanLiteral",
  value: true,
  raw: "true",
};

function moduleClause(moduleName: string): Parser.IfStatement {
  const moduleString: Parser.StringLiteral = {
    type: "StringLiteral",
    value: moduleName,
    raw: JSON.stringify(moduleName),
  };
  const moduleBody: ModuleSplice = { type: "ModuleSplice", moduleName };
  const loader: Parser.FunctionDeclaration = {
    type: "FunctionDeclaration",
    identifier: null,
    isLocal: false,
    parameters: [],
    // luaparseの公開型は拡張ノードを含まない。コード生成前だけ存在する内部ASTとして
    // FunctionDeclarationのbodyへ保持し、printer側でModuleSpliceを明示的に処理する。
    body: [moduleBody as unknown as Parser.Statement],
  };
  const callLoader: Parser.CallExpression = {
    type: "CallExpression",
    base: loader,
    arguments: [],
  };
  return {
    type: "IfStatement",
    clauses: [
      {
        type: "IfClause",
        condition: {
          type: "BinaryExpression",
          operator: "==",
          left: identifier("m"),
          right: moduleString,
        },
        body: [assignment(identifier("r"), callLoader)],
      },
    ],
  };
}

/** require互換関数を、入力ソースに由来しない合成ASTとして構築する。 */
export function buildRequireWrapperAst(
  moduleNames: readonly string[],
): Parser.FunctionDeclaration {
  const emptyLoadedTable: Parser.TableConstructorExpression = {
    type: "TableConstructorExpression",
    fields: [],
  };
  const packageFallback: Parser.TableConstructorExpression = {
    type: "TableConstructorExpression",
    fields: [
      {
        type: "TableKeyString",
        key: identifier("loaded"),
        value: emptyLoadedTable,
      },
    ],
  };

  return {
    type: "FunctionDeclaration",
    identifier: identifier("require"),
    isLocal: false,
    parameters: [identifier("m"), identifier("r")],
    body: [
      assignment(
        identifier("package"),
        logical("or", identifier("package"), packageFallback),
      ),
      {
        type: "IfStatement",
        clauses: [
          {
            type: "IfClause",
            condition: loadedAtM(),
            body: [{ type: "ReturnStatement", arguments: [loadedAtM()] }],
          },
        ],
      },
      ...moduleNames.map(moduleClause),
      assignment(
        loadedAtM(),
        logical("or", logical("or", loadedAtM(), identifier("r")), truth),
      ),
      { type: "ReturnStatement", arguments: [loadedAtM()] },
    ],
  };
}
