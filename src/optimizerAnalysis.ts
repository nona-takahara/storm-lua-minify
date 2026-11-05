import Parser from "luaparse";
import { analyzeControlFlow, ControlFlowAnalysis } from "./controlFlow";
import {
  analyzeSymbolLiveness,
  SymbolLivenessAnalysis,
} from "./symbolLiveness";
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
  /** End the read snapshot before publishing a changed AST. */
  invalidate(): void;
  assertCurrent(): void;
  readonly facts: OptimizerFacts;
  readonly callGraph: CallGraphAnalysis;
  readonly interprocedural: InterproceduralAnalysis;
  readonly controlFlow: ControlFlowAnalysis;
  readonly symbolLiveness: SymbolLivenessAnalysis;
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
 *
 * Read lifetime: transforms must obtain every required sub-analysis before their
 * first AST write. They may use those materialized results during the transform,
 * but must not first request another lazy analysis after writing. The owner must
 * invalidate the snapshot as soon as the transform returns (also on exceptions).
 * Standalone callers own this obligation via invalidate().
 */
export function analyzeOptimizer(
  chunk: Parser.Chunk,
  resolved: ResolveResult,
  options: OptimizerAnalysisOptions = {},
  sharedFacts?: OptimizerFacts,
): OptimizerAnalysis {
  const generation = options.generation ?? 0;
  const facts =
    sharedFacts ??
    analyzeOptimizerFacts(chunk, resolved, {
      ...options,
      generation,
    });
  if (facts.generation !== generation) throw new Error("Stale optimizer facts");
  const callGraph = analyzeCallGraph(chunk, resolved, facts);
  const interprocedural = analyzeInterprocedural(
    chunk,
    resolved,
    callGraph,
    options.interprocedural,
  );
  let valid = true;
  const assertCurrent = () => {
    if (!valid)
      throw new Error("Cannot read a stale optimizer analysis snapshot");
  };
  const lazy = <T>(build: () => T): (() => T) => {
    let value: T;
    let built = false;
    return () => {
      assertCurrent();
      if (!built) {
        value = build();
        built = true;
      }
      return value;
    };
  };
  const controlFlow = lazy(() =>
    analyzeControlFlow(chunk, resolved, generation),
  );
  const symbolLiveness = lazy(() =>
    analyzeSymbolLiveness(controlFlow(), facts),
  );
  const valueFlow = lazy(() =>
    analyzeValueFlow(
      chunk,
      resolved,
      facts,
      generation,
      interprocedural,
      controlFlow(),
    ),
  );
  const tableEffects = lazy(() =>
    analyzeTableEffects(chunk, resolved, valueFlow(), facts, interprocedural),
  );
  const statementDataflow = lazy(() =>
    analyzeStatementDataflow(chunk, facts, valueFlow(), symbolLiveness()),
  );
  return {
    generation,
    assertCurrent,
    invalidate() {
      valid = false;
    },
    facts,
    callGraph,
    interprocedural,
    get controlFlow() {
      return controlFlow();
    },
    get symbolLiveness() {
      return symbolLiveness();
    },
    get valueFlow() {
      return valueFlow();
    },
    get tableEffects() {
      return tableEffects();
    },
    get statementDataflow() {
      return statementDataflow();
    },
  };
}

export function analyzeOptimizerAtGeneration(
  chunk: Parser.Chunk,
  resolved: ResolveResult,
  generation: number,
): OptimizerAnalysis {
  return analyzeOptimizer(chunk, resolved, { generation });
}
