export type OptimizationDecision = "accepted" | "rejected";
export type OptimizationDiagnosticReason =
  | "profitable-group"
  | "insufficient-group"
  | "noncandidate-boundary"
  | "effect-or-binding-barrier"
  | "adjacent-local-owned-by-merge"
  | "binding-shadow-hazard"
  | "output-name-unknown"
  | "nonpositive-cost";

export interface OptimizationDiagnostic {
  readonly pass: string;
  readonly moduleName?: string;
  readonly decision: OptimizationDecision;
  readonly reason: OptimizationDiagnosticReason;
  readonly candidateSize?: number;
  readonly estimatedByteSavings?: number;
}

/**
 * 最適化の観測は変換結果へ影響してはならない。sinkは候補判定後に同期的に
 * 呼ばれ、plannerの入力やASTを受け取らないため、診断から変換を書き換えられない。
 */
export interface OptimizationDiagnosticSink {
  record(diagnostic: OptimizationDiagnostic): void;
}

export class OptimizationDiagnosticCollector implements OptimizationDiagnosticSink {
  private readonly diagnosticsValue: OptimizationDiagnostic[] = [];

  get diagnostics(): readonly OptimizationDiagnostic[] {
    return this.diagnosticsValue;
  }

  record(diagnostic: OptimizationDiagnostic): void {
    this.diagnosticsValue.push({ ...diagnostic });
  }
}

export interface OptimizationDiagnosticSummary {
  readonly acceptedCandidates: number;
  readonly rejectedCandidates: number;
  readonly estimatedByteSavings: number;
  readonly byReason: readonly {
    readonly key: string;
    readonly candidateCount: number;
  }[];
}

export function summarizeOptimizationDiagnostics(
  diagnostics: readonly OptimizationDiagnostic[],
): OptimizationDiagnosticSummary {
  const byReason = new Map<string, number>();
  let acceptedCandidates = 0;
  let rejectedCandidates = 0;
  let estimatedByteSavings = 0;
  diagnostics.forEach((diagnostic) => {
    const count = diagnostic.candidateSize ?? 1;
    if (diagnostic.decision === "accepted") {
      acceptedCandidates += count;
      estimatedByteSavings += diagnostic.estimatedByteSavings ?? 0;
    } else {
      rejectedCandidates += count;
    }
    const key = `${diagnostic.pass}:${diagnostic.reason}`;
    byReason.set(key, (byReason.get(key) ?? 0) + count);
  });
  return {
    acceptedCandidates,
    rejectedCandidates,
    estimatedByteSavings,
    byReason: [...byReason]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, candidateCount]) => ({ key, candidateCount })),
  };
}
