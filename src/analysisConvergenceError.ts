/** An analysis exhausted its convergence bound without producing a result. */
export class AnalysisConvergenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AnalysisConvergenceError";
  }
}
