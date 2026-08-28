/** Receives coarse-grained evidence that a synchronous minification is advancing. */
export interface CompilationProgress {
  addSteps(count: number): void;
  startStep(label: string): void;
  tick(): void;
}
