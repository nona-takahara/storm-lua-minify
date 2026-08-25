import Parser from "luaparse";
import { describe, expect, test } from "vitest";
import { analyzeCallGraph } from "../src/callGraph";
import {
  inlineBoundStatementFunctions,
  inlineClosedStatementFunctions,
  inlineClosedSingleUseFunctions,
  inlineLiteralArgumentFunctions,
  inlineTailCallFunctions,
  pruneTrailingUnusedParameters,
} from "../src/functionRewrites";
import { analyzeInterprocedural } from "../src/interproceduralAnalysis";
import { analyzeOptimizerFacts } from "../src/optimizerFacts";
import { resolveScopes } from "../src/resolver";
import { SourceMetadata } from "../src/sourceMetadata";

function rewrite(source: string) {
  const chunk = Parser.parse(source, {
    luaVersion: "5.3",
    comments: true,
    locations: true,
    ranges: true,
  });
  const resolved = resolveScopes(chunk);
  const facts = analyzeOptimizerFacts(chunk, resolved);
  const callGraph = analyzeCallGraph(chunk, resolved, facts);
  return {
    chunk,
    result: pruneTrailingUnusedParameters(
      callGraph,
      new SourceMetadata(chunk, source),
    ),
  };
}

function firstFunction(chunk: Parser.Chunk): Parser.FunctionDeclaration {
  const statement = chunk.body[0];
  if (statement.type !== "FunctionDeclaration")
    throw new Error("expected a function declaration");
  return statement;
}

describe("function rewrites", () => {
  test("prunes only the contiguous unused parameter tail", () => {
    const { chunk, result } = rewrite(
      "local function pick(first,unused,last) return last end return pick(1,side(),3)",
    );
    expect(result).toEqual({ changed: false, prunedParameters: 0 });
    expect(firstFunction(chunk).parameters).toHaveLength(3);

    const pruned = rewrite(
      "local function pick(first,unused,last) return first end return pick(1,side(),3)",
    );
    expect(pruned.result).toEqual({ changed: true, prunedParameters: 2 });
    expect(firstFunction(pruned.chunk).parameters).toHaveLength(1);
  });

  test("does not cross a vararg tail", () => {
    const { chunk, result } = rewrite(
      "local function collect(unused,...) return ... end return collect(side(),1)",
    );
    expect(result).toEqual({ changed: false, prunedParameters: 0 });
    expect(firstFunction(chunk).parameters).toHaveLength(2);
  });

  test("honors keep annotations on the function declaration", () => {
    const { chunk, result } = rewrite(
      "--@storm keep\nlocal function kept(unused) return 1 end return kept(side())",
    );
    expect(result).toEqual({ changed: false, prunedParameters: 0 });
    expect(firstFunction(chunk).parameters).toHaveLength(1);
  });

  test("inlines a single-use closed return expression with body provenance", () => {
    const source =
      "local function value() return external()+1 end return value()";
    const chunk = Parser.parse(source, {
      luaVersion: "5.3",
      comments: true,
      locations: true,
      ranges: true,
    });
    const resolved = resolveScopes(chunk);
    const facts = analyzeOptimizerFacts(chunk, resolved);
    const callGraph = analyzeCallGraph(chunk, resolved, facts);
    const originalExpression = (
      firstFunction(chunk).body[0] as Parser.ReturnStatement
    ).arguments[0];
    const result = inlineClosedSingleUseFunctions(
      analyzeInterprocedural(chunk, resolved, callGraph),
      resolved,
      new SourceMetadata(chunk, source),
    );
    const finalReturn = chunk.body[1] as Parser.ReturnStatement;

    expect(result).toEqual({ changed: true, inlinedFunctions: 1 });
    expect(finalReturn.arguments[0].type).toBe("BinaryExpression");
    expect(finalReturn.arguments[0]).not.toBe(originalExpression);
    expect(finalReturn.arguments[0].loc).toEqual(originalExpression.loc);
  });

  test("rejects local/upvalue capture until alpha conversion is available", () => {
    const source =
      "local captured=1 local function value() return captured end do local captured=2 return value() end";
    const chunk = Parser.parse(source, {
      luaVersion: "5.3",
      comments: true,
      locations: true,
      ranges: true,
    });
    const resolved = resolveScopes(chunk);
    const facts = analyzeOptimizerFacts(chunk, resolved);
    const callGraph = analyzeCallGraph(chunk, resolved, facts);
    const result = inlineClosedSingleUseFunctions(
      analyzeInterprocedural(chunk, resolved, callGraph),
      resolved,
      new SourceMetadata(chunk, source),
    );

    expect(result).toEqual({ changed: false, inlinedFunctions: 0 });
  });

  test("splices a closed straight-line body at its only statement call", () => {
    const source =
      "local function run() first() globalValue=second() return end run()";
    const chunk = Parser.parse(source, {
      luaVersion: "5.3",
      comments: true,
      locations: true,
      ranges: true,
    });
    const resolved = resolveScopes(chunk);
    const facts = analyzeOptimizerFacts(chunk, resolved);
    const callGraph = analyzeCallGraph(chunk, resolved, facts);
    const result = inlineClosedStatementFunctions(
      chunk,
      analyzeInterprocedural(chunk, resolved, callGraph),
      resolved,
      new SourceMetadata(chunk, source),
    );

    expect(result).toEqual({ changed: true, inlinedFunctions: 1 });
    expect(chunk.body.map((statement) => statement.type)).toEqual([
      "FunctionDeclaration",
      "CallStatement",
      "AssignmentStatement",
    ]);
  });

  test("specializes primitive literal arguments with call-site provenance", () => {
    const source =
      'local function format(value,suffix)return prefix..value..suffix end return format("x","!")';
    const chunk = Parser.parse(source, {
      luaVersion: "5.3",
      comments: true,
      locations: true,
      ranges: true,
    });
    const resolved = resolveScopes(chunk);
    const facts = analyzeOptimizerFacts(chunk, resolved);
    const callGraph = analyzeCallGraph(chunk, resolved, facts);
    const call = callGraph.calls.at(-1)?.call;
    if (call?.type !== "CallExpression") throw new Error("expected call");
    const firstActualLoc = call.arguments[0].loc;
    const result = inlineLiteralArgumentFunctions(
      analyzeInterprocedural(chunk, resolved, callGraph),
      resolved,
      new SourceMetadata(chunk, source),
    );
    const finalReturn = chunk.body[1] as Parser.ReturnStatement;

    expect(result).toEqual({ changed: true, inlinedFunctions: 1 });
    expect(finalReturn.arguments[0].type).toBe("BinaryExpression");
    const strings: Parser.StringLiteral[] = [];
    const collectStrings = (value: unknown): void => {
      if (!value || typeof value !== "object") return;
      if ((value as Parser.Node).type === "StringLiteral") {
        strings.push(value as Parser.StringLiteral);
        return;
      }
      Object.values(value).forEach(collectStrings);
    };
    collectStrings(finalReturn.arguments[0]);
    expect(strings[0].raw).toBe('"x"');
    expect(strings[0].loc).toEqual(firstActualLoc);
  });

  test("binds arbitrary actuals before splicing a statement body", () => {
    const source =
      "local function run(first,second) local sum=first+second publish(sum) end run(makeFirst(),makeSecond())";
    const chunk = Parser.parse(source, {
      luaVersion: "5.3",
      comments: true,
      locations: true,
      ranges: true,
    });
    const resolved = resolveScopes(chunk);
    const facts = analyzeOptimizerFacts(chunk, resolved);
    const callGraph = analyzeCallGraph(chunk, resolved, facts);
    const result = inlineBoundStatementFunctions(
      chunk,
      analyzeInterprocedural(chunk, resolved, callGraph),
      resolved,
      new SourceMetadata(chunk, source),
      { maxIntroducedLocalsAt: () => 10 },
    );

    expect(result).toEqual({ changed: true, inlinedFunctions: 1 });
    const replacement = chunk.body[1];
    expect(replacement.type).toBe("DoStatement");
    if (replacement.type !== "DoStatement") throw new Error("expected do");
    expect(replacement.body[0]).toMatchObject({
      type: "LocalStatement",
      variables: [{ name: "first" }, { name: "second" }],
      init: [
        { type: "CallExpression", base: { name: "makeFirst" } },
        { type: "CallExpression", base: { name: "makeSecond" } },
      ],
    });
  });

  test("rejects an upvalue whose spelling could be captured at the call site", () => {
    const source =
      "local captured=1 local function run(value) publish(captured,value) end do local captured=2 run(make()) end";
    const chunk = Parser.parse(source, {
      luaVersion: "5.3",
      comments: true,
      locations: true,
      ranges: true,
    });
    const resolved = resolveScopes(chunk);
    const facts = analyzeOptimizerFacts(chunk, resolved);
    const callGraph = analyzeCallGraph(chunk, resolved, facts);
    const result = inlineBoundStatementFunctions(
      chunk,
      analyzeInterprocedural(chunk, resolved, callGraph),
      resolved,
      new SourceMetadata(chunk, source),
      { maxIntroducedLocalsAt: () => 10 },
    );

    expect(result).toEqual({ changed: false, inlinedFunctions: 0 });
  });

  test("inlines multi-statement and tuple returns into a caller tail", () => {
    const source =
      "local function pair(value) local next=value+1 if flag then return value,next end return next,value end return pair(make())";
    const chunk = Parser.parse(source, {
      luaVersion: "5.3",
      comments: true,
      locations: true,
      ranges: true,
    });
    const resolved = resolveScopes(chunk);
    const facts = analyzeOptimizerFacts(chunk, resolved);
    const callGraph = analyzeCallGraph(chunk, resolved, facts);
    const result = inlineTailCallFunctions(
      chunk,
      analyzeInterprocedural(chunk, resolved, callGraph),
      resolved,
      new SourceMetadata(chunk, source),
      { maxIntroducedLocalsAt: () => 10 },
    );

    expect(result).toEqual({ changed: true, inlinedFunctions: 1 });
    const replacement = chunk.body[1];
    expect(replacement.type).toBe("DoStatement");
    if (replacement.type !== "DoStatement") throw new Error("expected do");
    expect(replacement.body[0]).toMatchObject({
      type: "LocalStatement",
      init: [{ type: "CallExpression", base: { name: "make" } }],
    });
    expect(
      replacement.body.filter(
        (statement) => statement.type === "ReturnStatement",
      ),
    ).toHaveLength(1);
  });
});
