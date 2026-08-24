import Parser from "luaparse";
import { describe, expect, test } from "vitest";
import { walkExpression, walkStatement } from "../src/astWalk";

const settings = { luaVersion: "5.3" as const };

function parse(source: string): Parser.Chunk {
  return Parser.parse(source, settings);
}

describe("AST walker", () => {
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
