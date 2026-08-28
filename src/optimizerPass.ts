import Parser from "luaparse";
import { resolveScopes, ResolveResult } from "./resolver";

export interface TransformResult {
  readonly changed: boolean;
  readonly invalidatesResolve: boolean;
}

export interface PassRecord extends TransformResult {
  readonly name: string;
  readonly astGenerationBefore: number;
  readonly astGenerationAfter: number;
  readonly resolveGenerationBefore: number;
  readonly resolveGenerationAfter: number;
}

export interface GenerationBoundAnalysis {
  readonly generation: number;
}

/**
 * AST変換と解析世代を結び付ける最小のpass orchestrator。
 *
 * 構造変更後の古いResolveResultやoptimizer factを後続passへ渡さないことが
 * 第一の不変条件である。AST世代はあらゆる変更で進み、Resolve世代は束縛を
 * 変える変更だけで進む。この区別により、安価な解析を不必要に再Resolveせず、
 * ASTを参照するcacheだけは確実に失効させる。
 */
export class PassOrchestrator {
  private resolvedValue: ResolveResult;
  private astGenerationValue = 0;
  private resolveGenerationValue = 0;
  private readonly recordsValue: PassRecord[] = [];
  private readonly analysisCache = new Map<
    object,
    { readonly generation: number; readonly value: GenerationBoundAnalysis }
  >();

  constructor(
    private readonly chunk: Parser.Chunk,
    initialResolve: ResolveResult,
  ) {
    this.resolvedValue = initialResolve;
  }

  get resolved(): ResolveResult {
    return this.resolvedValue;
  }

  get resolveGeneration(): number {
    return this.resolveGenerationValue;
  }

  get astGeneration(): number {
    return this.astGenerationValue;
  }

  get records(): readonly PassRecord[] {
    return this.recordsValue;
  }

  /**
   * 現在のAST世代に束縛された解析を遅延生成する。
   *
   * cache keyは解析種別とpolicyの組を表す安定したobjectにする。ASTを変更したpassが
   * 一つでも走れば、Resolveの再計算要否にかかわらずcacheは破棄される。
   */
  analysis<T extends GenerationBoundAnalysis>(
    key: object,
    analyze: (
      chunk: Parser.Chunk,
      resolved: ResolveResult,
      generation: number,
    ) => T,
  ): T {
    const cached = this.analysisCache.get(key);
    if (cached?.generation === this.astGenerationValue) {
      return cached.value as T;
    }
    const value = analyze(
      this.chunk,
      this.resolvedValue,
      this.astGenerationValue,
    );
    if (value.generation !== this.astGenerationValue) {
      throw new Error("Analysis was built for a stale AST generation");
    }
    this.analysisCache.set(key, {
      generation: this.astGenerationValue,
      value,
    });
    return value;
  }

  run(
    name: string,
    transform: (resolved: ResolveResult) => TransformResult,
  ): TransformResult {
    const astBefore = this.astGenerationValue;
    const resolveBefore = this.resolveGenerationValue;
    const result = transform(this.resolvedValue);
    if (!result.changed && result.invalidatesResolve) {
      throw new Error(
        `Pass ${name} cannot invalidate Resolve without changing the AST`,
      );
    }
    if (result.changed) {
      this.astGenerationValue++;
      this.analysisCache.clear();
    }
    if (result.invalidatesResolve) {
      this.resolvedValue = resolveScopes(this.chunk);
      this.resolveGenerationValue++;
    }
    this.recordsValue.push({
      name,
      ...result,
      astGenerationBefore: astBefore,
      astGenerationAfter: this.astGenerationValue,
      resolveGenerationBefore: resolveBefore,
      resolveGenerationAfter: this.resolveGenerationValue,
    });
    return result;
  }

  runUntilStable(
    name: string,
    transform: (resolved: ResolveResult, iteration: number) => TransformResult,
  ): readonly TransformResult[] {
    const results: TransformResult[] = [];
    for (let iteration = 0; ; iteration++) {
      const result = this.run(`${name}:${String(iteration)}`, (resolved) =>
        transform(resolved, iteration),
      );
      results.push(result);
      if (!result.changed) return results;
    }
  }
}

export const UNCHANGED: TransformResult = {
  changed: false,
  invalidatesResolve: false,
};
