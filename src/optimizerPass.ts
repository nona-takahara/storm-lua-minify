import Parser from "luaparse";
import { resolveScopes, ResolveResult } from "./resolver";

export interface TransformResult {
  readonly changed: boolean;
  readonly invalidatesResolve: boolean;
}

export interface PassRecord extends TransformResult {
  readonly name: string;
  readonly resolveGenerationBefore: number;
  readonly resolveGenerationAfter: number;
}

/**
 * AST変換と解析世代を結び付ける最小のpass orchestrator。
 *
 * 構造変更後の古いResolveResultを後続passへ渡さないことが第一の不変条件である。
 * CFG/effect/cost等の解析cacheは、この世代番号とpass履歴を共通の失効根拠として
 * 後から追加できる。現在はResolveだけを所有し、未使用の抽象化は持ち込まない。
 */
export class PassOrchestrator {
  private resolvedValue: ResolveResult;
  private generationValue = 0;
  private readonly recordsValue: PassRecord[] = [];

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
    return this.generationValue;
  }

  get records(): readonly PassRecord[] {
    return this.recordsValue;
  }

  run(
    name: string,
    transform: (resolved: ResolveResult) => TransformResult,
  ): TransformResult {
    const before = this.generationValue;
    const result = transform(this.resolvedValue);
    if (!result.changed && result.invalidatesResolve) {
      throw new Error(
        `Pass ${name} cannot invalidate Resolve without changing the AST`,
      );
    }
    if (result.invalidatesResolve) {
      this.resolvedValue = resolveScopes(this.chunk);
      this.generationValue++;
    }
    this.recordsValue.push({
      name,
      ...result,
      resolveGenerationBefore: before,
      resolveGenerationAfter: this.generationValue,
    });
    return result;
  }
}

export const UNCHANGED: TransformResult = {
  changed: false,
  invalidatesResolve: false,
};
