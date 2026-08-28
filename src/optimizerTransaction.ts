import { Options } from "luaparse";
import { Minifier, MinifierMode } from "./minifier";

export interface MinifiedArtifact {
  readonly code: string;
  readonly sourceMap: string;
  readonly byteLength: number;
}

export type TransactionalVariantResult =
  | {
      readonly accepted: true;
      readonly selected: MinifiedArtifact;
      readonly baseline: MinifiedArtifact;
      readonly trial: MinifiedArtifact;
      readonly byteSavings: number;
    }
  | {
      readonly accepted: false;
      readonly reason: "not-shorter" | "trial-failed";
      readonly selected: MinifiedArtifact;
      readonly baseline: MinifiedArtifact;
      readonly trial?: MinifiedArtifact;
      readonly trialError?: unknown;
      readonly byteSavings: 0;
    };

export interface TransactionalMinifierRequest {
  readonly entryFilePath: string;
  readonly luaParseSettings: Partial<Options>;
  readonly baselineMode: MinifierMode;
  readonly trialMode: MinifierMode;
  readonly outputFile?: string;
}

function renderVariant(
  request: TransactionalMinifierRequest,
  mode: MinifierMode,
): MinifiedArtifact {
  // Minifier instanceを共有しないことがrollbackの不変条件。ASTだけでなく
  // Resolve、SourceMetadata、annotation、rename cache、module予約名も分離する。
  const output = new Minifier(
    request.entryFilePath,
    request.luaParseSettings,
    mode,
  )
    .parse()
    .toStringWithSourceMap({
      file: request.outputFile ?? "main.min.lua",
    });
  return {
    code: output.code,
    sourceMap: output.map.toString(),
    byteLength: new TextEncoder().encode(output.code).length,
  };
}

/**
 * baselineとtrialを最終Rename/Printまで同条件で評価し、厳密に短いtrialだけを選ぶ。
 * trialは隔離されたMinifier上で動くため、失敗・同長・増加時に復元操作は不要。
 */
export function selectTransactionalMinifierVariant(
  request: TransactionalMinifierRequest,
): TransactionalVariantResult {
  const baseline = renderVariant(request, request.baselineMode);
  let trial: MinifiedArtifact;
  try {
    trial = renderVariant(request, request.trialMode);
  } catch (trialError) {
    return {
      accepted: false,
      reason: "trial-failed",
      selected: baseline,
      baseline,
      trialError,
      byteSavings: 0,
    };
  }
  if (trial.byteLength >= baseline.byteLength) {
    return {
      accepted: false,
      reason: "not-shorter",
      selected: baseline,
      baseline,
      trial,
      byteSavings: 0,
    };
  }
  return {
    accepted: true,
    selected: trial,
    baseline,
    trial,
    byteSavings: baseline.byteLength - trial.byteLength,
  };
}
