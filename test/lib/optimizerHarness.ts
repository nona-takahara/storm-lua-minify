import Parser from "luaparse";
import { analyzeOptimizer } from "../../src/optimizerAnalysis";
import { resolveScopes } from "../../src/resolver";

export function parseLua(source: string): Parser.Chunk {
  return Parser.parse(source, {
    luaVersion: "5.3",
    locations: true,
    ranges: true,
  });
}

export function analyzeLua(source: string) {
  const chunk = parseLua(source);
  const resolved = resolveScopes(chunk);
  const analysis = analyzeOptimizer(chunk, resolved);
  return { chunk, resolved, analysis };
}
