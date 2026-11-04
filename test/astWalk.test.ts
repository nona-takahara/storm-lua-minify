import Parser from "luaparse";
import { describe, expect, test } from "vitest";
import { walkBlockDeep, walkExpression, walkStatement } from "../src/astWalk";

const settings = { luaVersion: "5.3" as const };

function parse(source: string): Parser.Chunk {
  return Parser.parse(source, settings);
}

describe("AST walker", () => {
  test.each([
    {
      kind: "numeric",
      source: "for i=first,last,step do use(i) end",
      expected: ["first", "last", "step"],
    },
    {
      kind: "generic",
      source: "for key,value in iterator,state,seed do use(key,value) end",
      expected: ["iterator", "state", "seed"],
    },
  ])(
    "walks $kind loop headers without treating declarations as references",
    ({ source, expected }) => {
      const references: string[] = [];
      const blocks: Parser.Statement[][] = [];
      walkStatement(parse(source).body[0], {
        onIdentifierReference: (id) => references.push(id.name),
        onBlock: (body) => blocks.push(body),
      });
      expect(references).toEqual(expected);
      expect(blocks).toHaveLength(1);
    },
  );

  test("deep traversal enters nested function and loop bodies exactly once", () => {
    const chunk = parse(
      "local function f(p) if condition then repeat local x=p until x end end",
    );
    const references: string[] = [];
    const statements: string[] = [];
    const functions: Parser.FunctionDeclaration[] = [];
    const blocks: Parser.Statement[][] = [];
    walkBlockDeep(chunk.body, {
      onIdentifierReference: (id) => references.push(id.name),
      onStatement: (statement) => statements.push(statement.type),
      onFunction: (fn) => functions.push(fn),
      onBlock: (body) => blocks.push(body),
    });
    expect(references).toEqual(["condition", "p", "x"]);
    expect(statements).toEqual([
      "FunctionDeclaration",
      "IfStatement",
      "RepeatStatement",
      "LocalStatement",
    ]);
    expect(functions).toEqual([chunk.body[0]]);
    expect(blocks).toHaveLength(3);
    expect(new Set(blocks).size).toBe(3);
  });

  test("distinguishes variable references from declarations and field names", () => {
    const chunk = parse("local x=t.x+t[k]");
    const statement = chunk.body[0];
    const references: string[] = [];

    walkStatement(statement, {
      onIdentifierReference: (identifier) => references.push(identifier.name),
    });

    expect(references).toEqual(["t", "t", "k"]);
  });

  test("lets the caller choose whether to enter nested blocks", () => {
    const chunk = parse("if flag then print(value) end");
    const shallow: string[] = [];
    const recursive: string[] = [];

    walkStatement(chunk.body[0], {
      onIdentifierReference: (identifier) => shallow.push(identifier.name),
    });

    const visitor = {
      onIdentifierReference: (identifier: Parser.Identifier) =>
        recursive.push(identifier.name),
      onBlock: (body: Parser.Statement[]) => {
        body.forEach((statement) => {
          walkStatement(statement, visitor);
        });
      },
    };
    walkStatement(chunk.body[0], visitor);

    expect(shallow).toEqual(["flag"]);
    expect(recursive).toEqual(["flag", "print", "value"]);
  });

  test("walks computed table keys but not named constructor keys", () => {
    const chunk = parse("return {named=value,[key]=other}");
    const returnStatement = chunk.body[0] as Parser.ReturnStatement;
    const references: string[] = [];

    walkExpression(returnStatement.arguments[0], {
      onIdentifierReference: (identifier) => references.push(identifier.name),
    });

    expect(references).toEqual(["value", "key", "other"]);
  });

  test("reports assignment targets as references without entering closures", () => {
    const chunk = parse("target=function() return captured end");
    const references: string[] = [];
    const blocks: Parser.Statement[][] = [];

    walkStatement(chunk.body[0], {
      onIdentifierReference: (identifier) => references.push(identifier.name),
      onBlock: (body) => blocks.push(body),
    });

    expect(references).toEqual(["target"]);
    expect(blocks).toHaveLength(1);
  });
});
