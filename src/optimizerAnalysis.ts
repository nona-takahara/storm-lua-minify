import Parser from "luaparse";
import {
  analyzeOptimizerFacts,
  OptimizerFacts,
  OptimizerFactOptions,
} from "./optimizerFacts";
import { ResolveResult } from "./resolver";
import { analyzeValueFlow, ValueFlowAnalysis } from "./valueFlow";
import { analyzeTableEffects, TableEffectAnalysis } from "./tableEffects";
import {
  analyzeStatementDataflow,
  StatementDataflowAnalysis,
} from "./statementDataflow";
import { analyzeCallGraph, CallGraphAnalysis } from "./callGraph";
import {
  analyzeInterprocedural,
  InterproceduralAnalysis,
  InterproceduralOptions,
} from "./interproceduralAnalysis";

export interface OptimizerAnalysisOptions extends OptimizerFactOptions {
  readonly interprocedural?: InterproceduralOptions;
}

export interface OptimizerAnalysis {
  readonly generation: number;
  readonly facts: OptimizerFacts;
  readonly callGraph: CallGraphAnalysis;
  readonly interprocedural: InterproceduralAnalysis;
  readonly valueFlow: ValueFlowAnalysis;
  readonly tableEffects: TableEffectAnalysis;
  readonly statementDataflow: StatementDataflowAnalysis;
}

export const OPTIMIZER_ANALYSIS_CACHE_KEY = {};

/**
 * 一つのAST世代に属するoptimizer解析をまとめて構築する。
 *
 * sub-analysisをpass側で個別に生成させないことが重要である。これによりtable解析と
 * value flowが同じallocation identity・CFG世代を共有し、AST変更時には
 * PassOrchestratorがsnapshot全体を一度に破棄できる。
 */
export function analyzeOptimizer(
  chunk: Parser.Chunk,
  resolved: ResolveResult,
  options: OptimizerAnalysisOptions = {},
): OptimizerAnalysis {
  const generation = options.generation ?? 0;
  const facts = analyzeOptimizerFacts(chunk, resolved, {
    ...options,
    generation,
  });
  const callGraph = analyzeCallGraph(chunk, resolved, facts);
  const interprocedural = analyzeInterprocedural(
    chunk,
    resolved,
    callGraph,
    options.interprocedural,
  );
  const valueFlow = analyzeValueFlow(
    chunk,
    resolved,
    facts,
    generation,
    interprocedural,
  );
  const tableEffects = analyzeTableEffects(
    chunk,
    resolved,
    valueFlow,
    facts,
    interprocedural,
  );
  const statementDataflow = analyzeStatementDataflow(chunk, facts, valueFlow);
  return {
    generation,
    facts,
    callGraph,
    interprocedural,
    valueFlow,
    tableEffects,
    statementDataflow,
  };
}

export function analyzeOptimizerAtGeneration(
  chunk: Parser.Chunk,
  resolved: ResolveResult,
  generation: number,
): OptimizerAnalysis {
  return analyzeOptimizer(chunk, resolved, { generation });
}
