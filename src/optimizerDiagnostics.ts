export type OptimizationDecision = "accepted" | "rejected";
export type OptimizationDiagnosticReason =
  | "profitable-group"
  | "insufficient-group"
  | "unsupported-shape"
  | "require-splice"
  | "control-flow-barrier"
  | "metadata-preserved"
  | "dynamic-key"
  | "unsupported-string-key"
  | "allocation-unknown"
  | "unstable-reaching-definition"
  | "dirty-static-key"
  | "dirty-table"
  | "alias-escape"
  | "call-escape"
  | "return-escape"
  | "store-escape"
  | "capture-escape"
  | "value-use-escape"
  | "adjacent-local-owned-by-merge"
  | "binding-shadow-hazard"
  | "output-name-unknown"
  | "nonpositive-cost"
  | "resource-budget"
  | "final-output-shorter"
  | "final-output-not-shorter"
  | "trial-failed"
  | "unknown-control-flow"
  | "dependency-read-after-write"
  | "dependency-write-after-read"
  | "dependency-write-after-write"
  | "dependency-call-order"
  | "dependency-error-order"
  | "dependency-metamethod-order"
  | "dependency-allocation-order"
  | "dependency-control-order"
  | "dependency-scope-order";

export interface OptimizationDiagnostic {
  readonly pass: string;
  readonly moduleName?: string;
  readonly runtimeProfile?: "lua53" | "stormworks";
  readonly decision: OptimizationDecision;
  readonly reason: OptimizationDiagnosticReason;
  readonly candidateSize?: number;
  readonly estimatedByteSavings?: number;
  readonly estimatedOpportunityBytes?: number;
  readonly sourceRange?: readonly [number, number];
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
  readonly estimatedOpportunityBytes: number;
  readonly buckets: readonly {
    readonly runtimeProfile: string;
    readonly moduleName: string;
    readonly pass: string;
    readonly decision: OptimizationDecision;
    readonly reason: OptimizationDiagnosticReason;
    readonly candidateCount: number;
    readonly estimatedByteSavings: number;
    readonly estimatedOpportunityBytes: number;
  }[];
}

export function summarizeOptimizationDiagnostics(
  diagnostics: readonly OptimizationDiagnostic[],
): OptimizationDiagnosticSummary {
  const buckets = new Map<
    string,
    {
      runtimeProfile: string;
      moduleName: string;
      pass: string;
      decision: OptimizationDecision;
      reason: OptimizationDiagnosticReason;
      candidateCount: number;
      estimatedByteSavings: number;
      estimatedOpportunityBytes: number;
    }
  >();
  let acceptedCandidates = 0;
  let rejectedCandidates = 0;
  let estimatedByteSavings = 0;
  let estimatedOpportunityBytes = 0;
  diagnostics.forEach((diagnostic) => {
    const count = diagnostic.candidateSize ?? 1;
    if (diagnostic.decision === "accepted") {
      acceptedCandidates += count;
      estimatedByteSavings += diagnostic.estimatedByteSavings ?? 0;
    } else {
      rejectedCandidates += count;
      estimatedOpportunityBytes += diagnostic.estimatedOpportunityBytes ?? 0;
    }
    const runtimeProfile = diagnostic.runtimeProfile ?? "unknown";
    const moduleName = diagnostic.moduleName ?? "unknown";
    const key = [
      runtimeProfile,
      moduleName,
      diagnostic.pass,
      diagnostic.decision,
      diagnostic.reason,
    ].join("\u0000");
    const current = buckets.get(key) ?? {
      runtimeProfile,
      moduleName,
      pass: diagnostic.pass,
      decision: diagnostic.decision,
      reason: diagnostic.reason,
      candidateCount: 0,
      estimatedByteSavings: 0,
      estimatedOpportunityBytes: 0,
    };
    current.candidateCount += count;
    current.estimatedByteSavings += diagnostic.estimatedByteSavings ?? 0;
    current.estimatedOpportunityBytes +=
      diagnostic.estimatedOpportunityBytes ?? 0;
    buckets.set(key, current);
  });
  return {
    acceptedCandidates,
    rejectedCandidates,
    estimatedByteSavings,
    estimatedOpportunityBytes,
    buckets: [...buckets]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([, bucket]) => ({ ...bucket })),
  };
}
