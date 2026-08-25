import Parser from "luaparse";
import { describe, expect, test } from "vitest";
import { analyzeCallGraph } from "../src/callGraph";
import { pruneTrailingUnusedParameters } from "../src/functionRewrites";
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
  if (statement?.type !== "FunctionDeclaration")
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
});
