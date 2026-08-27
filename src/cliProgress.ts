import path from "path";
import { CompilationProgress } from "./progress";

const SPINNER_FRAMES = ["|", "/", "-", "\\"] as const;
/** Minimum elapsed time between spinner frames; change and rebuild to tune it. */
export const CLI_PROGRESS_INTERVAL_MS = 200;

export interface ProgressOutput {
  readonly isTTY?: boolean;
  write(text: string): unknown;
}

export interface CliProgressOptions {
  readonly fileName: string;
  readonly fileIndex: number;
  readonly fileCount: number;
  readonly output: ProgressOutput;
  readonly now?: () => number;
}

export class CliProgress implements CompilationProgress {
  private readonly displayName: string;
  private readonly filePosition: string;
  private readonly output: ProgressOutput;
  private readonly now: () => number;
  private readonly tty: boolean;
  private currentStep = 0;
  private totalSteps = 0;
  private label = "Starting";
  private spinnerIndex = 0;
  private lastRenderAt?: number;
  private activeLine = false;

  constructor(options: CliProgressOptions) {
    this.displayName = path.basename(options.fileName);
    this.filePosition =
      String(options.fileIndex) + "/" + String(options.fileCount) + " files";
    this.output = options.output;
    this.now = options.now ?? (() => performance.now());
    this.tty = options.output.isTTY === true;
  }

  addSteps(count: number): void {
    if (!Number.isInteger(count) || count < 0)
      throw new Error("Progress step count must be a non-negative integer");
    this.totalSteps += count;
  }

  startStep(label: string): void {
    this.currentStep++;
    this.label = label;
    if (this.currentStep > this.totalSteps) this.totalSteps = this.currentStep;
    if (this.tty) this.render(this.now());
    else this.output.write(this.line() + "\n");
  }

  tick(): void {
    if (!this.tty || this.lastRenderAt === undefined) return;
    const now = this.now();
    if (now - this.lastRenderAt < CLI_PROGRESS_INTERVAL_MS) return;
    this.spinnerIndex = (this.spinnerIndex + 1) % SPINNER_FRAMES.length;
    this.render(now);
  }

  finish(outputFiles: readonly string[], elapsedMs: number): void {
    const destinations = outputFiles.join(", ");
    const line = `[done] [${this.filePosition}] ${this.displayName} (${formatDuration(elapsedMs)}) -> ${destinations}`;
    this.writeFinalLine(line);
  }

  fail(): void {
    this.writeFinalLine(
      `[failed] [${this.filePosition}] ${this.displayName} — ${this.label}`,
    );
  }

  private line(): string {
    return `${SPINNER_FRAMES[this.spinnerIndex]} [${this.filePosition}] ${this.displayName} — Step ${String(this.currentStep)}/${String(this.totalSteps)}: ${this.label}`;
  }

  private render(now: number): void {
    this.output.write(`\r\x1b[2K${this.line()}`);
    this.lastRenderAt = now;
    this.activeLine = true;
  }

  private writeFinalLine(line: string): void {
    if (this.tty && this.activeLine) this.output.write("\r\x1b[2K");
    this.output.write(line + "\n");
    this.activeLine = false;
  }
}

function formatDuration(elapsedMs: number): string {
  if (elapsedMs < 1000) return `${String(Math.round(elapsedMs))} ms`;
  return `${(elapsedMs / 1000).toFixed(1)} s`;
}

export function progressEnabled(
  explicit: boolean | undefined,
  output: ProgressOutput,
): boolean {
  return explicit ?? output.isTTY === true;
}
