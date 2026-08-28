import Parser from "luaparse";
import { describe, expect, test } from "vitest";
import { analyzeCallGraph } from "../src/callGraph";
import { analyzeOptimizerFacts } from "../src/optimizerFacts";
import { resolveScopes } from "../src/resolver";

function graphOf(source: string) {
  const chunk = Parser.parse(source, { luaVersion: "5.3" });
  const resolved = resolveScopes(chunk);
  const facts = analyzeOptimizerFacts(chunk, resolved);
  return analyzeCallGraph(chunk, resolved, facts);
}

describe("module-local call graph", () => {
  test("resolves local functions and stable local aliases by symbol identity", () => {
    const graph = graphOf(
      "local function factory() return {} end local alias=factory local value=alias()",
    );
    expect(graph.functions).toHaveLength(1);
    const call = graph.calls.at(-1);
    expect(call?.hasUnknownTarget).toBe(false);
    expect([...(call?.targets ?? [])]).toEqual([graph.functions[0]]);
  });

  test("keeps external calls explicitly unknown", () => {
    const graph = graphOf("local value=externalFactory() use(value)");
    expect(graph.calls).toHaveLength(2);
    expect(graph.calls.every((call) => call.hasUnknownTarget)).toBe(true);
  });

  test("does not retain a stale function target after reassignment", () => {
    const graph = graphOf(
      "local target=function() return 1 end target=external target()",
    );
    expect(graph.calls.at(-1)?.hasUnknownTarget).toBe(true);
    expect(graph.calls.at(-1)?.targets.size).toBe(0);
  });

  test("finds recursive SCCs without initializing unknown edges as targets", () => {
    const graph = graphOf(`
local even,odd
even=function(n) if n==0 then return true end return odd(n-1) end
odd=function(n) if n==0 then return false end return even(n-1) end
return even(4)
`);
    const recursive = graph.sccs.find((scc) => scc.recursive);
    expect(recursive?.functions).toHaveLength(2);
    expect(graph.calls.filter((call) => !call.hasUnknownTarget)).toHaveLength(
      3,
    );
  });
});
