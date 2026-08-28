import Parser, { Options } from "luaparse";
import path from "path";
import fs from "fs";
import { SourceNode } from "source-map";
import { Chunk, MinifyFile } from "./ast2lua";
import { findModuleReferences } from "./linker";
import { resolveScopes, ResolveResult } from "./resolver";
import { assignRenames, RenameResult } from "./renamer";
import { classifyAndRenameGlobals } from "./globalRename";
import { insertGlobalAliases } from "./transform";
import { SourceMetadata } from "./sourceMetadata";
import { removeUnusedLocals } from "./removeUnused";
import { foldConstants } from "./constantFold";
import { buildRequireWrapperAst, GeneratedStatement } from "./generatedAst";
import {
  applyStatementSchedule,
  planStatementSchedule,
} from "./statementScheduler";
import { PassOrchestrator } from "./optimizerPass";
import {
  analyzeLocalResourceUsage,
  checkParallelEvaluation,
  runtimeEnvironmentOf,
} from "./runtimeEnvironment";
import {
  OptimizationDiagnostic,
  OptimizationDiagnosticCollector,
} from "./optimizerDiagnostics";
import {
  analyzeOptimizerFactsAtGeneration,
  OPTIMIZER_FACTS_CACHE_KEY,
} from "./optimizerFacts";
import {
  analyzeOptimizer,
  analyzeOptimizerAtGeneration,
  OPTIMIZER_ANALYSIS_CACHE_KEY,
} from "./optimizerAnalysis";
import { propagateInterproceduralConstants } from "./interproceduralConstants";
import {
  inlineBoundStatementFunctions,
  inlineClosedStatementFunctions,
  inlineClosedSingleUseFunctions,
  inlineLiteralArgumentFunctions,
  inlineTailCallFunctions,
  pruneTrailingUnusedParameters,
} from "./functionRewrites";
import {
  analyzeWholeProgramObjects,
  WholeProgramObjectAnalysis,
  WholeProgramModule,
} from "./wholeProgramObjects";
import {
  analyzeWholeProgramFields,
  applyWholeProgramFieldRewrites,
  WholeProgramFieldAnalysis,
} from "./wholeProgramFields";
import { applyAggregateSpecialization } from "./aggregateSpecialization";
import {
  analyzeWholeProgramExports,
  applyWholeProgramExportDce,
  WholeProgramExportAnalysis,
} from "./wholeProgramExports";
import {
  planWholeProgramFieldRenames,
  WholeProgramFieldRenamePlan,
} from "./wholeProgramFieldRenames";
import {
  MinifierMode,
  ResolvedMinifierMode,
  resolveMinifierMode,
} from "./options";
import { CompilationProgress } from "./progress";

export type { RuntimeProfile } from "./runtimeEnvironment";
export type { MinifierMode } from "./options";
export type { CompilationProgress } from "./progress";

const NO_RENAME: RenameResult = {
  nameOf: () => undefined,
  usedNames: new Set(),
};

function sourceRangeOf(node: object): [number, number] | undefined {
  return (node as { range?: [number, number] }).range;
}

function copyMap<K, V>(source: ReadonlyMap<K, V>, target: Map<K, V>): void {
  target.clear();
  source.forEach((value, key) => target.set(key, value));
}

export class Minifier {
  readonly entryFilePath: string;
  readonly identifiersInUse: Set<string>;
  readonly moduleSourceText: Map<string, string>;
  readonly moduleAST: Map<string, Chunk>;
  readonly moduleNameAndFileName: Map<string, string>;
  readonly dir: string;
  readonly entryModule: string;
  readonly mode: ResolvedMinifierMode;
  readonly luaParseSettings: Partial<Options>;

  // Linkパスで解決されたモジュール名を、依存されている側が先に来る順序で並べたもの
  private readonly linkOrder: string[] = [];
  // モジュールごとのResolveパスの結果（Linkパスで一度だけ計算し使い回す）
  private readonly moduleResolve = new Map<string, ResolveResult>();
  // モジュールごとのRenameパスの結果（初回アクセス時に計算しキャッシュする）
  private readonly renameCache = new Map<string, RenameResult>();
  // #8a: プログラム全体を横断して決定された「内部グローバル名 -> 短縮名」の対応
  private globalRenames = new Map<string, string>();
  private readonly moduleMetadata = new Map<string, SourceMetadata>();
  private readonly diagnosticCollector?: OptimizationDiagnosticCollector;
  private readonly schedulerVariant?: "baseline" | "trial";
  private readonly functionRewriteVariant?: "baseline" | "trial";
  private readonly fieldFactVariant?: "baseline" | "trial";
  private readonly aggregateSpecializationVariant?: "baseline" | "trial";
  private readonly exportDceVariant?: "baseline" | "trial";
  private readonly fieldRenameVariant?: "baseline" | "trial";
  private readonly progress?: CompilationProgress;
  private linkedAstGeneration = 0;
  private wholeProgramObjectsValue?: WholeProgramObjectAnalysis;
  private wholeProgramFieldsValue?: WholeProgramFieldAnalysis;
  private wholeProgramExportsValue?: WholeProgramExportAnalysis;
  private wholeProgramFieldRenamesValue?: WholeProgramFieldRenamePlan;
  private exportDceChanged = false;

  constructor(
    entryFilePath: string,
    luaParseSettings: Partial<Options>,
    mode: MinifierMode,
    schedulerVariantOrProgress?: "baseline" | "trial" | CompilationProgress,
    functionRewriteVariant?: "baseline" | "trial",
    fieldFactVariant?: "baseline" | "trial",
    aggregateSpecializationVariant?: "baseline" | "trial",
    exportDceVariant?: "baseline" | "trial",
    fieldRenameVariant?: "baseline" | "trial",
    progress?: CompilationProgress,
  ) {
    this.schedulerVariant =
      typeof schedulerVariantOrProgress === "string"
        ? schedulerVariantOrProgress
        : undefined;
    this.functionRewriteVariant = functionRewriteVariant;
    this.fieldFactVariant = fieldFactVariant;
    this.aggregateSpecializationVariant = aggregateSpecializationVariant;
    this.exportDceVariant = exportDceVariant;
    this.fieldRenameVariant = fieldRenameVariant;
    this.progress =
      typeof schedulerVariantOrProgress === "object"
        ? schedulerVariantOrProgress
        : progress;
    this.entryFilePath = entryFilePath;
    this.identifiersInUse = new Set<string>();
    this.moduleSourceText = new Map<string, string>();
    this.moduleAST = new Map<string, Chunk>();
    this.moduleNameAndFileName = new Map<string, string>();
    // コメントの所有関係と自己再帰参照の判定は位置情報を不変条件とする。
    // 呼び出し側が省略・無効化しても、内部パスに必要な情報は常に収集する。
    this.luaParseSettings = {
      ...luaParseSettings,
      comments: true,
      locations: true,
      ranges: true,
    };
    this.mode = resolveMinifierMode(mode);
    if (mode.collectOptimizationDiagnostics) {
      this.diagnosticCollector = new OptimizationDiagnosticCollector();
    }
    const pn = path.parse(entryFilePath);
    this.dir = pn.dir;
    this.entryModule = pn.name;
  }

  get optimizationDiagnostics(): readonly OptimizationDiagnostic[] {
    return this.diagnosticCollector?.diagnostics ?? [];
  }

  get wholeProgramObjects(): WholeProgramObjectAnalysis | undefined {
    return this.wholeProgramObjectsValue;
  }

  get wholeProgramFields(): WholeProgramFieldAnalysis | undefined {
    return this.wholeProgramFieldsValue;
  }

  get wholeProgramExports(): WholeProgramExportAnalysis | undefined {
    return this.wholeProgramExportsValue;
  }

  get wholeProgramFieldRenames(): WholeProgramFieldRenamePlan | undefined {
    return this.wholeProgramFieldRenamesValue;
  }

  parse(): SourceNode {
    if (this.fieldRenameVariant === undefined && this.fieldRenamesEnabled()) {
      return this.parseWithFieldRenameSelection();
    }
    if (this.exportDceVariant === undefined && this.exportDceEnabled()) {
      return this.parseWithExportDceSelection();
    }
    if (this.fieldFactVariant === undefined && this.fieldFactsEnabled()) {
      return this.parseWithFieldFactSelection();
    }
    if (
      this.aggregateSpecializationVariant === undefined &&
      this.functionSpecializationEnabled()
    ) {
      return this.parseWithAggregateSpecializationSelection();
    }
    if (
      this.functionRewriteVariant === undefined &&
      this.functionRewritesEnabled()
    ) {
      return this.parseWithFunctionRewriteSelection();
    }
    if (
      this.schedulerVariant === undefined &&
      this.requiresSchedulerSelection()
    ) {
      return this.parseWithSchedulerSelection();
    }
    return this.parseOnce();
  }

  private parseWithFieldRenameSelection(): SourceNode {
    this.progress?.addSteps(2);
    this.progress?.startStep("Evaluate field renaming baseline");
    const baselineMinifier = new Minifier(
      this.entryFilePath,
      this.luaParseSettings,
      this.mode,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      "baseline",
      this.progress,
    );
    const baseline = baselineMinifier.parse();
    const baselineBytes = new TextEncoder().encode(baseline.toString()).length;
    let trialMinifier: Minifier;
    let trial: SourceNode;
    try {
      this.progress?.startStep("Evaluate field renaming trial");
      trialMinifier = new Minifier(
        this.entryFilePath,
        this.luaParseSettings,
        this.mode,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        "trial",
        this.progress,
      );
      trial = trialMinifier.parse();
    } catch {
      this.copyDiagnosticsFrom(baselineMinifier);
      this.recordFinalFieldRenameDecision("rejected", "trial-failed");
      return this.adoptVariant(baselineMinifier, baseline);
    }
    const trialBytes = new TextEncoder().encode(trial.toString()).length;
    if (trialBytes >= baselineBytes) {
      this.copyDiagnosticsFrom(trialMinifier);
      this.recordFinalFieldRenameDecision(
        "rejected",
        "final-output-not-shorter",
      );
      return this.adoptVariant(baselineMinifier, baseline);
    }
    this.copyDiagnosticsFrom(trialMinifier);
    this.recordFinalFieldRenameDecision(
      "accepted",
      "final-output-shorter",
      baselineBytes - trialBytes,
    );
    return this.adoptVariant(trialMinifier, trial);
  }

  private parseWithExportDceSelection(): SourceNode {
    this.progress?.addSteps(1);
    let trialMinifier: Minifier;
    let trial: SourceNode;
    try {
      this.progress?.startStep("Evaluate unused export removal trial");
      trialMinifier = new Minifier(
        this.entryFilePath,
        this.luaParseSettings,
        this.mode,
        undefined,
        undefined,
        undefined,
        undefined,
        "trial",
        this.fieldRenameVariant,
        this.progress,
      );
      trial = trialMinifier.parse();
    } catch {
      this.progress?.addSteps(1);
      this.progress?.startStep("Evaluate unused export removal baseline");
      const baselineMinifier = new Minifier(
        this.entryFilePath,
        this.luaParseSettings,
        this.mode,
        undefined,
        undefined,
        undefined,
        undefined,
        "baseline",
        this.fieldRenameVariant,
        this.progress,
      );
      const baseline = baselineMinifier.parse();
      this.copyDiagnosticsFrom(baselineMinifier);
      this.recordFinalExportDceDecision("rejected", "trial-failed");
      return this.adoptVariant(baselineMinifier, baseline);
    }
    if (!trialMinifier.exportDceChanged) {
      this.copyDiagnosticsFrom(trialMinifier);
      this.recordFinalExportDceDecision("rejected", "final-output-not-shorter");
      return this.adoptVariant(trialMinifier, trial);
    }
    this.progress?.addSteps(1);
    this.progress?.startStep("Evaluate unused export removal baseline");
    const baselineMinifier = new Minifier(
      this.entryFilePath,
      this.luaParseSettings,
      this.mode,
      undefined,
      undefined,
      undefined,
      undefined,
      "baseline",
      this.fieldRenameVariant,
      this.progress,
    );
    const baseline = baselineMinifier.parse();
    const baselineBytes = new TextEncoder().encode(baseline.toString()).length;
    const trialBytes = new TextEncoder().encode(trial.toString()).length;
    if (trialBytes >= baselineBytes) {
      this.copyDiagnosticsFrom(trialMinifier);
      this.recordFinalExportDceDecision("rejected", "final-output-not-shorter");
      return this.adoptVariant(baselineMinifier, baseline);
    }
    this.copyDiagnosticsFrom(trialMinifier);
    this.recordFinalExportDceDecision(
      "accepted",
      "final-output-shorter",
      baselineBytes - trialBytes,
    );
    return this.adoptVariant(trialMinifier, trial);
  }

  private parseWithFieldFactSelection(): SourceNode {
    this.progress?.addSteps(2);
    this.progress?.startStep("Evaluate field optimization baseline");
    const baselineMinifier = new Minifier(
      this.entryFilePath,
      this.luaParseSettings,
      this.mode,
      undefined,
      undefined,
      "baseline",
      this.aggregateSpecializationVariant,
      this.exportDceVariant,
      this.fieldRenameVariant,
      this.progress,
    );
    const baseline = baselineMinifier.parse();
    const baselineBytes = new TextEncoder().encode(baseline.toString()).length;
    let trialMinifier: Minifier;
    let trial: SourceNode;
    try {
      this.progress?.startStep("Evaluate field optimization trial");
      trialMinifier = new Minifier(
        this.entryFilePath,
        this.luaParseSettings,
        this.mode,
        undefined,
        undefined,
        "trial",
        this.aggregateSpecializationVariant,
        this.exportDceVariant,
        this.fieldRenameVariant,
        this.progress,
      );
      trial = trialMinifier.parse();
    } catch {
      this.copyDiagnosticsFrom(baselineMinifier);
      this.recordFinalFieldFactDecision("rejected", "trial-failed");
      return this.adoptVariant(baselineMinifier, baseline);
    }
    const trialBytes = new TextEncoder().encode(trial.toString()).length;
    if (trialBytes >= baselineBytes) {
      this.copyDiagnosticsFrom(trialMinifier);
      this.recordFinalFieldFactDecision("rejected", "final-output-not-shorter");
      return this.adoptVariant(baselineMinifier, baseline);
    }
    this.copyDiagnosticsFrom(trialMinifier);
    this.recordFinalFieldFactDecision(
      "accepted",
      "final-output-shorter",
      baselineBytes - trialBytes,
    );
    return this.adoptVariant(trialMinifier, trial);
  }

  private parseWithAggregateSpecializationSelection(): SourceNode {
    this.progress?.addSteps(2);
    this.progress?.startStep("Evaluate function specialization baseline");
    const baselineMinifier = new Minifier(
      this.entryFilePath,
      this.luaParseSettings,
      this.mode,
      undefined,
      undefined,
      this.fieldFactVariant,
      "baseline",
      this.exportDceVariant,
      this.fieldRenameVariant,
      this.progress,
    );
    const baseline = baselineMinifier.parse();
    const baselineBytes = new TextEncoder().encode(baseline.toString()).length;
    let trialMinifier: Minifier;
    let trial: SourceNode;
    try {
      this.progress?.startStep("Evaluate function specialization trial");
      trialMinifier = new Minifier(
        this.entryFilePath,
        this.luaParseSettings,
        this.mode,
        undefined,
        undefined,
        this.fieldFactVariant,
        "trial",
        this.exportDceVariant,
        this.fieldRenameVariant,
        this.progress,
      );
      trial = trialMinifier.parse();
    } catch {
      this.copyDiagnosticsFrom(baselineMinifier);
      this.recordFinalAggregateSpecializationDecision(
        "rejected",
        "trial-failed",
      );
      return this.adoptVariant(baselineMinifier, baseline);
    }
    const trialBytes = new TextEncoder().encode(trial.toString()).length;
    if (trialBytes >= baselineBytes) {
      this.copyDiagnosticsFrom(trialMinifier);
      this.recordFinalAggregateSpecializationDecision(
        "rejected",
        "final-output-not-shorter",
      );
      return this.adoptVariant(baselineMinifier, baseline);
    }
    this.copyDiagnosticsFrom(trialMinifier);
    this.recordFinalAggregateSpecializationDecision(
      "accepted",
      "final-output-shorter",
      baselineBytes - trialBytes,
    );
    return this.adoptVariant(trialMinifier, trial);
  }

  private parseWithFunctionRewriteSelection(): SourceNode {
    this.progress?.addSteps(2);
    this.progress?.startStep("Evaluate function rewrites baseline");
    const baselineMinifier = new Minifier(
      this.entryFilePath,
      this.luaParseSettings,
      this.mode,
      undefined,
      "baseline",
      this.fieldFactVariant,
      this.aggregateSpecializationVariant,
      this.exportDceVariant,
      this.fieldRenameVariant,
      this.progress,
    );
    const baseline = baselineMinifier.parse();
    const baselineBytes = new TextEncoder().encode(baseline.toString()).length;
    let trialMinifier: Minifier;
    let trial: SourceNode;
    try {
      this.progress?.startStep("Evaluate function rewrites trial");
      trialMinifier = new Minifier(
        this.entryFilePath,
        this.luaParseSettings,
        this.mode,
        undefined,
        "trial",
        this.fieldFactVariant,
        this.aggregateSpecializationVariant,
        this.exportDceVariant,
        this.fieldRenameVariant,
        this.progress,
      );
      trial = trialMinifier.parse();
    } catch {
      this.copyDiagnosticsFrom(baselineMinifier);
      this.recordFinalFunctionRewriteDecision("rejected", "trial-failed");
      return this.adoptVariant(baselineMinifier, baseline);
    }
    const trialBytes = new TextEncoder().encode(trial.toString()).length;
    if (trialBytes >= baselineBytes) {
      this.copyDiagnosticsFrom(trialMinifier);
      this.recordFinalFunctionRewriteDecision(
        "rejected",
        "final-output-not-shorter",
      );
      return this.adoptVariant(baselineMinifier, baseline);
    }
    this.copyDiagnosticsFrom(trialMinifier);
    this.recordFinalFunctionRewriteDecision(
      "accepted",
      "final-output-shorter",
      baselineBytes - trialBytes,
    );
    return this.adoptVariant(trialMinifier, trial);
  }

  private parseWithSchedulerSelection(): SourceNode {
    this.progress?.addSteps(2);
    this.progress?.startStep("Evaluate statement scheduling baseline");
    const baselineMinifier = new Minifier(
      this.entryFilePath,
      this.luaParseSettings,
      this.mode,
      "baseline",
      this.functionRewriteVariant,
      this.fieldFactVariant,
      this.aggregateSpecializationVariant,
      this.exportDceVariant,
      this.fieldRenameVariant,
      this.progress,
    );
    const baseline = baselineMinifier.parseOnce();
    const baselineBytes = new TextEncoder().encode(baseline.toString()).length;
    let trialMinifier: Minifier;
    let trial: SourceNode;
    try {
      this.progress?.startStep("Evaluate statement scheduling trial");
      trialMinifier = new Minifier(
        this.entryFilePath,
        this.luaParseSettings,
        this.mode,
        "trial",
        this.functionRewriteVariant,
        this.fieldFactVariant,
        this.aggregateSpecializationVariant,
        this.exportDceVariant,
        this.fieldRenameVariant,
        this.progress,
      );
      trial = trialMinifier.parseOnce();
    } catch {
      this.copyDiagnosticsFrom(baselineMinifier);
      this.recordFinalSchedulerDecision("rejected", "trial-failed");
      return this.adoptVariant(baselineMinifier, baseline);
    }
    const trialBytes = new TextEncoder().encode(trial.toString()).length;
    if (trialBytes >= baselineBytes) {
      this.copyDiagnosticsFrom(trialMinifier);
      this.recordFinalSchedulerDecision("rejected", "final-output-not-shorter");
      return this.adoptVariant(baselineMinifier, baseline);
    }
    this.copyDiagnosticsFrom(trialMinifier);
    this.recordFinalSchedulerDecision(
      "accepted",
      "final-output-shorter",
      baselineBytes - trialBytes,
    );
    return this.adoptVariant(trialMinifier, trial);
  }

  private parseOnce(): SourceNode {
    this.progress?.addSteps(11);
    this.progress?.startStep("Load and parse modules");
    this.link();
    this.progress?.tick();
    // #85 consumes #84 function-valued field facts before field DCE can remove
    // callback storage. The field pass then sees specialized calls and includes
    // storage/wrapper cleanup in the same final-output trial.
    this.progress?.startStep("Rewrite functions");
    this.rewriteFunctionsAll();
    this.progress?.tick();
    this.progress?.startStep("Analyze and rewrite fields");
    this.rewriteWholeProgramFieldsAll();
    this.progress?.tick();
    this.progress?.startStep("Fold constants");
    this.foldConstantsAll();
    this.progress?.tick();
    this.progress?.startStep("Remove unused exports");
    this.rewriteWholeProgramExportsAll();
    this.progress?.tick();
    this.progress?.startStep("Remove unused code");
    this.removeUnusedAll();
    this.progress?.tick();
    this.progress?.startStep("Plan global names");
    this.rebuildIdentifiersInUse();
    this.computeGlobalRenames();
    this.progress?.tick();
    this.progress?.startStep("Transform statements");
    this.transformAll();
    this.progress?.tick();
    this.progress?.startStep("Finalize whole-program analyses");
    if (
      this.functionRewritesEnabled() ||
      this.fieldFactsEnabled() ||
      this.fieldRenamesEnabled()
    ) {
      // fold/remove/schedule may have changed any module after method rewrites. Publish only a
      // snapshot rebuilt from the complete linked AST generation consumed by final Rename/Print.
      this.linkedAstGeneration++;
      this.wholeProgramObjectsValue = this.analyzeWholeProgramObjects();
      this.wholeProgramFieldsValue = analyzeWholeProgramFields(
        this.wholeProgramObjectsValue,
        {
          trustAnnotations: this.mode.assumeAnnotations === true,
          metadataOf: (moduleName) => this.getSourceMetadata(moduleName),
        },
      );
      this.wholeProgramExportsValue = analyzeWholeProgramExports(
        this.wholeProgramObjectsValue,
        this.entryModule,
        (moduleName) => this.getSourceMetadata(moduleName),
      );
      if (this.fieldRenameVariant === "trial") {
        this.wholeProgramFieldRenamesValue = planWholeProgramFieldRenames(
          this.wholeProgramObjectsValue,
          this.wholeProgramFieldsValue,
          this.wholeProgramExportsValue,
          this.entryModule,
          (moduleName) => this.getSourceMetadata(moduleName),
        );
        this.recordWholeProgramFieldRenameDiagnostics(
          this.wholeProgramFieldRenamesValue,
        );
      }
    }
    this.progress?.tick();
    this.progress?.startStep("Rename identifiers");
    this.renameAll();
    this.progress?.tick();

    this.progress?.startStep("Generate Lua and source map");
    const result = this.mode.requireWrapper
      ? this.printModuleWithRequireWrapper()
      : this.printModule(this.entryModule);

    this.moduleSourceText.forEach((v, k) => {
      const fileName = this.moduleNameAndFileName.get(k);
      if (fileName) {
        result.setSourceContent(fileName, v);
      }
      this.progress?.tick();
    });

    return result;
  }

  private rewriteWholeProgramExportsAll(): void {
    if (this.exportDceVariant !== "trial" || !this.exportDceEnabled()) return;
    const objectAnalysis = this.analyzeWholeProgramObjects();
    const exportAnalysis = analyzeWholeProgramExports(
      objectAnalysis,
      this.entryModule,
      (moduleName) => this.getSourceMetadata(moduleName),
    );
    this.wholeProgramObjectsValue = objectAnalysis;
    this.wholeProgramExportsValue = exportAnalysis;
    exportAnalysis.diagnostics.forEach((diagnostic) =>
      this.diagnosticCollector?.record({
        pass: "whole-program-export-reachability",
        moduleName: diagnostic.moduleName,
        fieldName: diagnostic.field,
        runtimeProfile: this.mode.runtimeProfile,
        decision:
          diagnostic.reason === "export-field-candidate" ||
          diagnostic.reason === "field-live" ||
          diagnostic.reason === "field-unreachable"
            ? "accepted"
            : "rejected",
        reason: diagnostic.reason,
        candidateSize: 1,
        sourceRange: diagnostic.sourceRange,
      }),
    );
    const analysisByModule = new Map(
      objectAnalysis.modules.map((module) => [module.name, module.analysis]),
    );
    const result = applyWholeProgramExportDce(
      exportAnalysis,
      (moduleName) => this.getSourceMetadata(moduleName),
      (moduleName, expression) =>
        analysisByModule.get(moduleName)?.facts.discardabilityOf(expression)
          .discardable === true,
    );
    result.refusedEffectfulInitializerFields.forEach((field) =>
      this.diagnosticCollector?.record({
        pass: "whole-program-export-dce",
        moduleName: field.moduleName,
        fieldName: field.key,
        runtimeProfile: this.mode.runtimeProfile,
        decision: "rejected",
        reason: "effectful-initializer",
        candidateSize: 1,
      }),
    );
    if (!result.changed) return;
    this.exportDceChanged = true;
    this.linkOrder.forEach((moduleName) => {
      const ast = this.moduleAST.get(moduleName);
      if (!ast) throw new Error(moduleName + " is not found");
      this.moduleResolve.set(moduleName, resolveScopes(ast));
    });
    this.linkedAstGeneration++;
    this.wholeProgramObjectsValue = undefined;
    this.wholeProgramFieldsValue = undefined;
    this.wholeProgramExportsValue = undefined;
    result.removedFields.forEach((field) =>
      this.diagnosticCollector?.record({
        pass: "whole-program-export-dce",
        moduleName: field.moduleName,
        fieldName: field.key,
        runtimeProfile: this.mode.runtimeProfile,
        decision: "accepted",
        reason: "field-removed",
        candidateSize: 1,
      }),
    );
    result.preservedEffectFields.forEach((field) =>
      this.diagnosticCollector?.record({
        pass: "whole-program-export-dce",
        moduleName: field.moduleName,
        fieldName: field.key,
        runtimeProfile: this.mode.runtimeProfile,
        decision: "accepted",
        reason: "field-effect-preserved",
        candidateSize: 1,
      }),
    );
  }

  private rewriteWholeProgramFieldsAll(): void {
    if (this.fieldFactVariant === "baseline" || !this.fieldFactsEnabled())
      return;
    const objectAnalysis = this.analyzeWholeProgramObjects();
    const fieldAnalysis = analyzeWholeProgramFields(objectAnalysis, {
      trustAnnotations: this.mode.assumeAnnotations === true,
      metadataOf: (moduleName) => this.getSourceMetadata(moduleName),
    });
    this.wholeProgramObjectsValue = objectAnalysis;
    this.wholeProgramFieldsValue = fieldAnalysis;
    fieldAnalysis.diagnostics.forEach((diagnostic) =>
      this.diagnosticCollector?.record({
        pass: "whole-program-constructor-fields",
        moduleName: diagnostic.moduleName,
        runtimeProfile: this.mode.runtimeProfile,
        decision: diagnostic.reason === "field-fact" ? "accepted" : "rejected",
        reason: diagnostic.reason,
        candidateSize: 1,
        sourceRange: diagnostic.sourceRange,
      }),
    );
    const result = applyWholeProgramFieldRewrites(
      objectAnalysis,
      fieldAnalysis,
      (moduleName) => this.getSourceMetadata(moduleName),
      {
        replaceReads: this.mode.fieldValuePropagation,
        removeInitializers: this.mode.unusedFieldInitializerRemoval,
      },
    );
    if (!result.changed) return;
    this.linkOrder.forEach((moduleName) => {
      const ast = this.moduleAST.get(moduleName);
      if (!ast) throw new Error(moduleName + " is not found");
      const passes = new PassOrchestrator(ast, resolveScopes(ast));
      passes.runUntilStable("fold-constructor-field-constants", (resolved) => {
        const facts = passes.analysis(
          OPTIMIZER_FACTS_CACHE_KEY,
          analyzeOptimizerFactsAtGeneration,
        );
        const changed = foldConstants(
          ast,
          resolved,
          this.getSourceMetadata(moduleName),
          facts,
          {
            evaluateExpressions: this.mode.constantExpressionEvaluation,
            propagateLocals: this.mode.localConstantPropagation,
          },
        );
        return { changed, invalidatesResolve: changed };
      });
      this.moduleResolve.set(moduleName, passes.resolved);
    });
    this.linkedAstGeneration++;
    this.wholeProgramObjectsValue = undefined;
    this.wholeProgramFieldsValue = undefined;
    this.wholeProgramExportsValue = undefined;
    this.diagnosticCollector?.record({
      pass: "whole-program-constructor-field-rewrite",
      moduleName: this.entryModule,
      runtimeProfile: this.mode.runtimeProfile,
      decision: "accepted",
      reason: "field-rewrite-applied",
      candidateSize: result.replacedReads + result.removedInitializers,
    });
    const recordRewrite = (
      reason:
        | "field-read-replaced"
        | "dead-field-write"
        | "field-write-effect-preserved",
      count: number,
    ) => {
      if (count === 0) return;
      this.diagnosticCollector?.record({
        pass: "whole-program-constructor-field-rewrite",
        moduleName: this.entryModule,
        runtimeProfile: this.mode.runtimeProfile,
        decision: "accepted",
        reason,
        candidateSize: count,
      });
    };
    recordRewrite("field-read-replaced", result.replacedReads);
    recordRewrite("dead-field-write", result.removedInitializers);
    recordRewrite("field-write-effect-preserved", result.preservedEffects);
  }

  /** Function-summary consumers run before scheduling and final rename/print. */
  private rewriteFunctionsAll(): void {
    if (
      this.functionRewriteVariant === "baseline" ||
      !this.functionRewritesEnabled()
    )
      return;

    let initialWholeProgram = this.analyzeWholeProgramObjects();
    this.recordWholeProgramObjectDiagnostics(initialWholeProgram);
    const initiallyResolvedMethodDeclarations = new Set(
      initialWholeProgram.resolvedMethods.map(
        (method) => method.target.declaration,
      ),
    );
    if (
      this.mode.functionSpecialization &&
      this.aggregateSpecializationVariant !== "baseline"
    ) {
      const initialFieldFacts = analyzeWholeProgramFields(initialWholeProgram, {
        trustAnnotations: this.mode.assumeAnnotations === true,
        metadataOf: (moduleName) => this.getSourceMetadata(moduleName),
      });
      const specialization = applyAggregateSpecialization(
        initialWholeProgram,
        initialFieldFacts,
        this.linkOrder.map((name) => {
          const chunk = this.moduleAST.get(name);
          const resolved = this.moduleResolve.get(name);
          if (!chunk || !resolved) throw new Error(name + " is not found");
          const resources = analyzeLocalResourceUsage(chunk);
          const runtime = runtimeEnvironmentOf(this.mode.runtimeProfile);
          return {
            name,
            chunk,
            resolved,
            metadata: this.getSourceMetadata(name),
            maxIntroducedLocalsAt: (statement: Parser.Statement) => {
              const active = resources.activeLocalsBefore(statement);
              if (active === undefined) return 0;
              return Math.max(
                0,
                Math.min(
                  runtime.resources.maxActiveLocalsPerFunction - active,
                  runtime.resources.maxRegistersPerFunction - active,
                ),
              );
            },
          };
        }),
      );
      specialization.diagnostics.forEach((diagnostic) => {
        const module = initialWholeProgram.modules.find((candidate) =>
          candidate.analysis.callGraph.functions.includes(diagnostic.callable),
        );
        this.diagnosticCollector?.record({
          pass: "aggregate-function-specialization",
          moduleName: module?.name,
          runtimeProfile: this.mode.runtimeProfile,
          decision:
            diagnostic.reason === "variant-created" ? "accepted" : "rejected",
          reason: diagnostic.reason,
          candidateSize: diagnostic.count,
          sourceRange: sourceRangeOf(diagnostic.callable.declaration),
        });
      });
      if (specialization.changed) {
        this.linkOrder.forEach((moduleName) => {
          const ast = this.moduleAST.get(moduleName);
          if (!ast) throw new Error(moduleName + " is not found");
          this.moduleResolve.set(moduleName, resolveScopes(ast));
        });
        this.linkedAstGeneration++;
        this.wholeProgramObjectsValue = undefined;
        this.wholeProgramFieldsValue = undefined;
        this.wholeProgramExportsValue = undefined;
        initialWholeProgram = this.analyzeWholeProgramObjects();
        const specializedFields = analyzeWholeProgramFields(
          initialWholeProgram,
          {
            trustAnnotations: this.mode.assumeAnnotations === true,
            metadataOf: (moduleName) => this.getSourceMetadata(moduleName),
          },
        );
        const downstream = applyWholeProgramFieldRewrites(
          initialWholeProgram,
          specializedFields,
          (moduleName) => this.getSourceMetadata(moduleName),
          {
            replaceReads: this.mode.fieldValuePropagation,
            removeInitializers: this.mode.unusedFieldInitializerRemoval,
          },
        );
        if (downstream.removedInitializers > 0)
          this.diagnosticCollector?.record({
            pass: "aggregate-function-specialization",
            moduleName: this.entryModule,
            runtimeProfile: this.mode.runtimeProfile,
            decision: "accepted",
            reason: "dead-field-write",
            candidateSize: downstream.removedInitializers,
          });
        if (downstream.changed) {
          this.linkOrder.forEach((moduleName) => {
            const ast = this.moduleAST.get(moduleName);
            if (!ast) throw new Error(moduleName + " is not found");
            this.moduleResolve.set(moduleName, resolveScopes(ast));
          });
          this.linkedAstGeneration++;
          this.wholeProgramObjectsValue = undefined;
          this.wholeProgramFieldsValue = undefined;
          this.wholeProgramExportsValue = undefined;
          initialWholeProgram = this.analyzeWholeProgramObjects();
        }
      }
    }
    const resolvedMethodDeclarations = new Set([
      ...initiallyResolvedMethodDeclarations,
      ...initialWholeProgram.resolvedMethods.map(
        (method) => method.target.declaration,
      ),
    ]);
    if (this.mode.parameterPruning) {
      initialWholeProgram = this.pruneWholeProgramParameters(
        initialWholeProgram,
        resolvedMethodDeclarations,
      );
    }

    this.linkOrder.forEach((moduleName) => {
      const ast = this.moduleAST.get(moduleName);
      const resolved = this.moduleResolve.get(moduleName);
      if (!ast || !resolved) throw new Error(moduleName + " is not found");
      const passes = new PassOrchestrator(ast, resolved);
      const runtimeProfile = this.mode.runtimeProfile;
      const moduleRange =
        sourceRangeOf(ast) ??
        ([0, this.moduleSourceText.get(moduleName)?.length ?? 0] as const);
      const recordAccepted = (pass: string, count: number) => {
        if (count === 0) return;
        this.diagnosticCollector?.record({
          pass,
          moduleName,
          runtimeProfile,
          decision: "accepted",
          reason: "function-rewrite-applied",
          candidateSize: count,
          sourceRange: moduleRange,
        });
      };
      const initialAnalysis = passes.analysis(
        OPTIMIZER_ANALYSIS_CACHE_KEY,
        analyzeOptimizerAtGeneration,
      );
      const recursive = new Set(
        initialAnalysis.callGraph.sccs
          .filter((scc) => scc.recursive)
          .flatMap((scc) => scc.functions),
      );
      initialAnalysis.interprocedural.diagnostics.forEach((diagnostic) =>
        this.diagnosticCollector?.record({
          pass: "interprocedural-summary",
          moduleName,
          runtimeProfile,
          decision:
            diagnostic.reason === "unknown-call-target"
              ? "rejected"
              : "accepted",
          reason: diagnostic.reason,
          candidateSize: 1,
          sourceRange: diagnostic.sourceRange ?? moduleRange,
        }),
      );
      initialAnalysis.callGraph.functions.forEach((callable) => {
        if (!callable.symbol || !callable.declaration.isLocal) return;
        const calls = initialAnalysis.callGraph.calls.filter((call) =>
          call.targets.has(callable),
        ).length;
        const reason = recursive.has(callable)
          ? "recursive-function"
          : callable.declaration.parameters.some(
                (parameter) => parameter.type === "VarargLiteral",
              )
            ? "vararg-function"
            : callable.symbol.references.length > calls
              ? "function-escape"
              : undefined;
        if (!reason) return;
        this.diagnosticCollector?.record({
          pass: "function-rewrite",
          moduleName,
          runtimeProfile,
          decision: "rejected",
          reason,
          candidateSize: 1,
          sourceRange: sourceRangeOf(callable.declaration),
        });
      });
      if (this.mode.functionInlining)
        passes.run("inline-closed-single-use-functions", (currentResolve) => {
          const analysis = passes.analysis(
            OPTIMIZER_ANALYSIS_CACHE_KEY,
            analyzeOptimizerAtGeneration,
          );
          const result = inlineClosedSingleUseFunctions(
            analysis.interprocedural,
            currentResolve,
            this.getSourceMetadata(moduleName),
          );
          recordAccepted(
            "inline-closed-single-use-functions",
            result.inlinedFunctions,
          );
          return {
            changed: result.changed,
            invalidatesResolve: result.changed,
          };
        });
      if (this.mode.functionInlining)
        passes.run("inline-literal-argument-functions", (currentResolve) => {
          const analysis = passes.analysis(
            OPTIMIZER_ANALYSIS_CACHE_KEY,
            analyzeOptimizerAtGeneration,
          );
          const result = inlineLiteralArgumentFunctions(
            analysis.interprocedural,
            currentResolve,
            this.getSourceMetadata(moduleName),
          );
          recordAccepted(
            "inline-literal-argument-functions",
            result.inlinedFunctions,
          );
          return {
            changed: result.changed,
            invalidatesResolve: result.changed,
          };
        });
      if (this.mode.functionInlining)
        passes.run("inline-tail-call-functions", (currentResolve) => {
          const analysis = passes.analysis(
            OPTIMIZER_ANALYSIS_CACHE_KEY,
            analyzeOptimizerAtGeneration,
          );
          const localResources = analyzeLocalResourceUsage(ast);
          const runtime = runtimeEnvironmentOf(this.mode.runtimeProfile);
          const result = inlineTailCallFunctions(
            ast,
            analysis.interprocedural,
            currentResolve,
            this.getSourceMetadata(moduleName),
            {
              maxIntroducedLocalsAt: (statement) => {
                const active = localResources.activeLocalsBefore(statement);
                if (active === undefined) return 0;
                return Math.max(
                  0,
                  Math.min(
                    runtime.resources.maxActiveLocalsPerFunction - active,
                    runtime.resources.maxRegistersPerFunction - active,
                  ),
                );
              },
            },
          );
          recordAccepted("inline-tail-call-functions", result.inlinedFunctions);
          return {
            changed: result.changed,
            invalidatesResolve: result.changed,
          };
        });
      if (this.mode.functionInlining)
        passes.run("inline-closed-statement-functions", (currentResolve) => {
          const analysis = passes.analysis(
            OPTIMIZER_ANALYSIS_CACHE_KEY,
            analyzeOptimizerAtGeneration,
          );
          const result = inlineClosedStatementFunctions(
            ast,
            analysis.interprocedural,
            currentResolve,
            this.getSourceMetadata(moduleName),
          );
          recordAccepted(
            "inline-closed-statement-functions",
            result.inlinedFunctions,
          );
          return {
            changed: result.changed,
            invalidatesResolve: result.changed,
          };
        });
      if (this.mode.functionInlining)
        passes.run("inline-bound-statement-functions", (currentResolve) => {
          const analysis = passes.analysis(
            OPTIMIZER_ANALYSIS_CACHE_KEY,
            analyzeOptimizerAtGeneration,
          );
          const localResources = analyzeLocalResourceUsage(ast);
          const result = inlineBoundStatementFunctions(
            ast,
            analysis.interprocedural,
            currentResolve,
            this.getSourceMetadata(moduleName),
            {
              maxIntroducedLocalsAt: (statement) => {
                const active = localResources.activeLocalsBefore(statement);
                if (active === undefined) return 0;
                return Math.max(
                  0,
                  Math.min(
                    runtimeEnvironmentOf(this.mode.runtimeProfile).resources
                      .maxActiveLocalsPerFunction - active,
                    runtimeEnvironmentOf(this.mode.runtimeProfile).resources
                      .maxRegistersPerFunction - active,
                  ),
                );
              },
            },
          );
          recordAccepted(
            "inline-bound-statement-functions",
            result.inlinedFunctions,
          );
          return {
            changed: result.changed,
            invalidatesResolve: result.changed,
          };
        });
      this.moduleResolve.set(moduleName, passes.resolved);
      if (passes.astGeneration > 0) {
        this.linkedAstGeneration += passes.astGeneration;
        this.wholeProgramObjectsValue = undefined;
        this.wholeProgramFieldsValue = undefined;
        this.wholeProgramExportsValue = undefined;
      }
      this.progress?.tick();
    });
    this.wholeProgramObjectsValue = this.analyzeWholeProgramObjects();
    this.recordWholeProgramObjectDiagnostics(this.wholeProgramObjectsValue);
  }

  private pruneWholeProgramParameters(
    analysis: WholeProgramObjectAnalysis,
    resolvedMethodDeclarations: ReadonlySet<Parser.FunctionDeclaration>,
  ): WholeProgramObjectAnalysis {
    const functionsByModule = new Map(
      analysis.modules.map((module) => [
        module.name,
        new Set(module.analysis.callGraph.functions),
      ]),
    );
    const changedModules = new Set<string>();
    this.linkOrder.forEach((moduleName) => {
      const functions = functionsByModule.get(moduleName);
      if (!functions) return;
      const result = pruneTrailingUnusedParameters(
        analysis.callGraph,
        this.getSourceMetadata(moduleName),
        (callable) =>
          functions.has(callable) &&
          (callable.declaration.identifier?.type !== "MemberExpression" ||
            callable.declaration.identifier.indexer !== ":" ||
            resolvedMethodDeclarations.has(callable.declaration)),
      );
      if (!result.changed) return;
      changedModules.add(moduleName);
      this.diagnosticCollector?.record({
        pass: "prune-trailing-unused-parameters",
        moduleName,
        runtimeProfile: this.mode.runtimeProfile,
        decision: "accepted",
        reason: "function-rewrite-applied",
        candidateSize: result.prunedParameters,
        sourceRange: sourceRangeOf(this.moduleAST.get(moduleName) ?? {}),
      });
      if (result.prunedMethodParameters > 0)
        this.diagnosticCollector?.record({
          pass: "whole-program-method-parameter-pruning",
          moduleName,
          runtimeProfile: this.mode.runtimeProfile,
          decision: "accepted",
          reason: "function-rewrite-applied",
          candidateSize: result.prunedMethodParameters,
          sourceRange: sourceRangeOf(this.moduleAST.get(moduleName) ?? {}),
        });
    });
    if (changedModules.size === 0) return analysis;
    changedModules.forEach((moduleName) => {
      const ast = this.moduleAST.get(moduleName);
      if (!ast) throw new Error(moduleName + " is not found");
      this.moduleResolve.set(moduleName, resolveScopes(ast));
    });
    this.linkedAstGeneration++;
    this.wholeProgramObjectsValue = undefined;
    this.wholeProgramFieldsValue = undefined;
    this.wholeProgramExportsValue = undefined;
    return this.analyzeWholeProgramObjects();
  }

  private analyzeWholeProgramObjects(): WholeProgramObjectAnalysis {
    const modules: WholeProgramModule[] = this.linkOrder.map((name) => {
      const chunk = this.moduleAST.get(name);
      const resolved = this.moduleResolve.get(name);
      if (!chunk || !resolved) throw new Error(name + " is not found");
      const module = {
        name,
        chunk,
        resolved,
        analysis: analyzeOptimizer(chunk, resolved, {
          generation: this.linkedAstGeneration,
        }),
      };
      this.progress?.tick();
      return module;
    });
    return analyzeWholeProgramObjects(modules, this.linkedAstGeneration);
  }

  private recordWholeProgramObjectDiagnostics(
    analysis: WholeProgramObjectAnalysis,
  ): void {
    analysis.diagnostics.forEach((diagnostic) =>
      this.diagnosticCollector?.record({
        pass: "whole-program-method-resolution",
        moduleName: diagnostic.moduleName,
        runtimeProfile: this.mode.runtimeProfile,
        decision:
          diagnostic.reason === "resolved-method-target"
            ? "accepted"
            : "rejected",
        reason: diagnostic.reason,
        candidateSize: 1,
        sourceRange: diagnostic.sourceRange,
      }),
    );
  }

  private requiresSchedulerSelection(): boolean {
    if (this.mode.localDeclarationMerging) return true;
    const runtime = runtimeEnvironmentOf(this.mode.runtimeProfile);
    const lifetimeAllowed =
      !runtime.semantics.debugLocalIntrospection ||
      this.mode.allowIntrospectionChanges === true;
    return (
      lifetimeAllowed &&
      (this.mode.localDeclarationHoisting || this.mode.tableReadMerging)
    );
  }

  private functionRewritesEnabled(): boolean {
    const runtime = runtimeEnvironmentOf(this.mode.runtimeProfile);
    return (
      (this.mode.parameterPruning ||
        this.mode.functionInlining ||
        this.mode.functionSpecialization) &&
      (!runtime.semantics.debugLocalIntrospection ||
        this.mode.allowIntrospectionChanges === true)
    );
  }

  private functionSpecializationEnabled(): boolean {
    if (!this.mode.functionSpecialization) return false;
    const runtime = runtimeEnvironmentOf(this.mode.runtimeProfile);
    return (
      !runtime.semantics.debugLocalIntrospection ||
      this.mode.allowIntrospectionChanges === true
    );
  }

  private fieldFactsEnabled(): boolean {
    return (
      this.mode.fieldValuePropagation || this.mode.unusedFieldInitializerRemoval
    );
  }

  private fieldRenamesEnabled(): boolean {
    return this.mode.fieldRenaming;
  }

  private exportDceEnabled(): boolean {
    return this.mode.unusedExportRemoval;
  }

  private copyDiagnosticsFrom(minifier: Minifier): void {
    minifier.optimizationDiagnostics.forEach((diagnostic) =>
      this.diagnosticCollector?.record(diagnostic),
    );
  }

  private adoptVariant(minifier: Minifier, output: SourceNode): SourceNode {
    this.identifiersInUse.clear();
    minifier.identifiersInUse.forEach((name) =>
      this.identifiersInUse.add(name),
    );
    copyMap(minifier.moduleSourceText, this.moduleSourceText);
    copyMap(minifier.moduleAST, this.moduleAST);
    copyMap(minifier.moduleNameAndFileName, this.moduleNameAndFileName);
    this.linkOrder.splice(0, this.linkOrder.length, ...minifier.linkOrder);
    copyMap(minifier.moduleResolve, this.moduleResolve);
    copyMap(minifier.renameCache, this.renameCache);
    this.globalRenames = new Map(minifier.globalRenames);
    copyMap(minifier.moduleMetadata, this.moduleMetadata);
    this.linkedAstGeneration = minifier.linkedAstGeneration;
    this.wholeProgramObjectsValue = minifier.wholeProgramObjectsValue;
    this.wholeProgramFieldsValue = minifier.wholeProgramFieldsValue;
    this.wholeProgramExportsValue = minifier.wholeProgramExportsValue;
    this.wholeProgramFieldRenamesValue = minifier.wholeProgramFieldRenamesValue;
    this.exportDceChanged = minifier.exportDceChanged;
    return output;
  }

  private recordFinalSchedulerDecision(
    decision: "accepted" | "rejected",
    reason:
      "final-output-shorter" | "final-output-not-shorter" | "trial-failed",
    byteSavings?: number,
  ): void {
    this.diagnosticCollector?.record({
      pass: "statement-scheduler-final-cost",
      decision,
      reason,
      candidateSize: 1,
      estimatedByteSavings: byteSavings,
      runtimeProfile: this.mode.runtimeProfile,
      moduleName: this.entryModule,
      sourceRange: [0, fs.readFileSync(this.entryFilePath, "utf8").length],
    });
  }

  private recordFinalFunctionRewriteDecision(
    decision: "accepted" | "rejected",
    reason:
      "final-output-shorter" | "final-output-not-shorter" | "trial-failed",
    byteSavings?: number,
  ): void {
    this.diagnosticCollector?.record({
      pass: "function-rewrite-final-cost",
      decision,
      reason,
      candidateSize: 1,
      estimatedByteSavings: byteSavings,
      runtimeProfile: this.mode.runtimeProfile,
      moduleName: this.entryModule,
      sourceRange: [0, fs.readFileSync(this.entryFilePath, "utf8").length],
    });
  }

  private recordFinalAggregateSpecializationDecision(
    decision: "accepted" | "rejected",
    reason:
      "final-output-shorter" | "final-output-not-shorter" | "trial-failed",
    byteSavings?: number,
  ): void {
    this.diagnosticCollector?.record({
      pass: "aggregate-specialization-final-cost",
      decision,
      reason,
      candidateSize: 1,
      estimatedByteSavings: byteSavings,
      runtimeProfile: this.mode.runtimeProfile,
      moduleName: this.entryModule,
      sourceRange: [0, fs.readFileSync(this.entryFilePath, "utf8").length],
    });
  }

  private recordFinalFieldFactDecision(
    decision: "accepted" | "rejected",
    reason:
      "final-output-shorter" | "final-output-not-shorter" | "trial-failed",
    byteSavings?: number,
  ): void {
    this.diagnosticCollector?.record({
      pass: "constructor-field-final-cost",
      decision,
      reason,
      candidateSize: 1,
      estimatedByteSavings: byteSavings,
      runtimeProfile: this.mode.runtimeProfile,
      moduleName: this.entryModule,
      sourceRange: [0, fs.readFileSync(this.entryFilePath, "utf8").length],
    });
  }

  private recordFinalExportDceDecision(
    decision: "accepted" | "rejected",
    reason:
      "final-output-shorter" | "final-output-not-shorter" | "trial-failed",
    byteSavings?: number,
  ): void {
    this.diagnosticCollector?.record({
      pass: "module-export-dce-final-cost",
      decision,
      reason,
      candidateSize: 1,
      estimatedByteSavings: byteSavings,
      runtimeProfile: this.mode.runtimeProfile,
      moduleName: this.entryModule,
      sourceRange: [0, fs.readFileSync(this.entryFilePath, "utf8").length],
    });
  }

  private recordFinalFieldRenameDecision(
    decision: "accepted" | "rejected",
    reason:
      "final-output-shorter" | "final-output-not-shorter" | "trial-failed",
    byteSavings?: number,
  ): void {
    this.diagnosticCollector?.record({
      pass: "whole-program-field-rename-final-cost",
      decision,
      reason,
      candidateSize: 1,
      estimatedByteSavings: byteSavings,
      runtimeProfile: this.mode.runtimeProfile,
      moduleName: this.entryModule,
      sourceRange: [0, fs.readFileSync(this.entryFilePath, "utf8").length],
    });
  }

  private recordWholeProgramFieldRenameDiagnostics(
    plan: WholeProgramFieldRenamePlan,
  ): void {
    plan.diagnostics.forEach((diagnostic) =>
      this.diagnosticCollector?.record({
        pass: "whole-program-field-rename",
        moduleName: diagnostic.moduleName,
        fieldName: diagnostic.field,
        runtimeProfile: this.mode.runtimeProfile,
        decision: diagnostic.accepted ? "accepted" : "rejected",
        reason: diagnostic.reason,
        candidateSize: 1,
        sourceRange: diagnostic.sourceRange,
      }),
    );
  }

  /**
   * dofileの呼び出し箇所ごとに、キャッシュ済みASTから新規にSourceNodeを作り直す。
   * 同じSourceNodeインスタンスを複数箇所へ挿入すると壊れるため、常に作り直す（#18）。
   */
  printModuleInline(moduleName: string): SourceNode {
    return this.printModule(moduleName);
  }

  /**
   * requireを式（IIFE）ではなく文として展開できる場合に使う。モジュール本体が
   * 「単一の式を返すreturn文」で終わっている場合のみ結果を返す。それ以外は
   * undefinedを返すので、呼び出し側は従来のIIFE方式にフォールバックする（#29）。
   */
  splitModuleForStatementSplice(
    moduleName: string,
  ): { statements: SourceNode; finalExpression: SourceNode } | undefined {
    const ast = this.moduleAST.get(moduleName);
    const fileName = this.moduleNameAndFileName.get(moduleName);
    if (!ast || !fileName) {
      throw new Error(moduleName + " is not found");
    }
    return new MinifyFile(
      fileName,
      moduleName,
      ast,
      this,
      this.mode,
    ).parseAsStatementsAndFinalExpression();
  }

  /**
   * 指定モジュールのRenameパス結果を返す。`renameAll`で事前に計算済みの
   * ものをそのまま返すだけの参照用アクセサ。
   */
  getRenameResult(moduleName: string): RenameResult {
    if (!this.mode.localRenaming && !this.mode.globalRenaming) {
      return NO_RENAME;
    }
    const cached = this.renameCache.get(moduleName);
    if (!cached) {
      throw new Error(moduleName + " is not found");
    }
    return cached;
  }

  getFieldRename(
    node: Parser.Identifier | Parser.StringLiteral,
  ): { name: string; originalName: string } | undefined {
    const name = this.wholeProgramFieldRenamesValue?.nameOf(node);
    const originalName =
      this.wholeProgramFieldRenamesValue?.originalNameOf(node);
    return name && originalName ? { name, originalName } : undefined;
  }

  getSourceMetadata(moduleName: string): SourceMetadata {
    const metadata = this.moduleMetadata.get(moduleName);
    if (!metadata) {
      throw new Error(moduleName + " is not found");
    }
    return metadata;
  }

  /**
   * Renameパス（#20）: linkOrder（依存されている側が先）の順にモジュールごとの
   * 短縮名を割り当てる。
   *
   * dofileやSLモードのrequireその場展開は、呼び出し元と同じLuaスコープに
   * 関数で包まずに直接展開されるため、モジュールをまたいで同じ短縮名を
   * 再利用すると本来無関係な変数同士が衝突しうる（#12）。これを安全に防ぐため、
   * あるモジュールが実際に使った短縮名は、後続モジュールを処理する前に
   * `identifiersInUse`（予約名の集合）へ積み増す。これにより短縮名は
   * プログラム全体で重複しなくなる（モジュール間での再利用による圧縮は
   * 犠牲になるが、モジュール内でのスコープに基づく再利用は維持される）。
   */
  private renameAll() {
    if (!this.mode.localRenaming && !this.mode.globalRenaming) {
      return;
    }
    this.linkOrder.forEach((moduleName) => {
      const ast = this.moduleAST.get(moduleName);
      const resolved = this.moduleResolve.get(moduleName);
      if (!ast || !resolved) {
        throw new Error(moduleName + " is not found");
      }
      const runtime = runtimeEnvironmentOf(this.mode.runtimeProfile);
      const result =
        this.renameCache.get(moduleName) ??
        assignRenames(
          ast,
          resolved,
          this.identifiersInUse,
          this.globalRenames,
          new Set(
            resolved.symbols.filter(
              (symbol) =>
                this.getSourceMetadata(moduleName).annotationsOfIdentifier(
                  symbol.declaration,
                ).keepName,
            ),
          ),
          {
            allowLocalNameReuse:
              !runtime.semantics.debugLocalIntrospection ||
              this.mode.allowIntrospectionChanges === true,
            renameLocals: this.mode.localRenaming,
          },
        );
      this.renameCache.set(moduleName, result);
      result.usedNames.forEach((name) => this.identifiersInUse.add(name));
      this.progress?.tick();
    });
  }

  /**
   * Transformパス（#8b, #9）: モジュールごとにASTレベルの最適化を適用する。
   * computeGlobalRenamesの後・renameAllの前に実行する必要がある（renameは
   * このパスが確定させた最終的な文構造を前提に短縮名を割り当てるため）。
   *
   * 実行順序は 8b（エイリアス挿入）→ #9（local宣言のまとめ上げ）。
   * 8bが挿入する複数の1変数1式local文は、#9のまとめ上げ対象としてそのまま
   * 束ねられるため、8bを先に行うことで両者の効果が重なる。
   *
   * 8bは新しい識別子ノード（エイリアスの宣言と、書き換えられた参照）を生成する。
   * これらのノードは元のResolveパス結果には存在しないため、#9のハザード1判定
   * （「候補文がグループ内で宣言済みの変数を参照していないか」）が正しく働くには、
   * 8bの直後・#9の直前でResolveパスを再実行しておく必要がある。この順序を
   * 誤ると、8bがrequire等の頻出グローバルをエイリアス化した際に、そのエイリアス
   * 宣言自体と「エイリアス経由で呼び出す側」の文を#9が誤って1つのlocal文に
   * まとめてしまい（エイリアス変数がまだ束縛される前のスコープで参照される形に
   * なり）、意味が壊れる（要修正が発覚した実例）。
   */
  private transformAll() {
    // globalRenames.keys()は8aが実際にリネームした（=代入もされていた）名前のみ。
    // neverRenameGlobalsは代入されていない名前にも及ぶ保護指定なので、8bのエイリアス化
    // が誤ってそれらを書き換えてしまわないよう、必ず両方をあわせてexcludeNamesに渡す。
    const excludeGlobalNames = new Set([
      ...this.globalRenames.keys(),
      ...(this.mode.neverRenameGlobals ?? []),
      ...this.annotationProtectedGlobals(),
    ]);
    // renameAllと同じmodule順・予約名更新で仮Renameを行い、plannerのbyte costを
    // 実際の出力名長に対する保守的な見積りにする。
    const plannedIdentifiersInUse = new Set(this.identifiersInUse);
    this.linkOrder.forEach((moduleName) => {
      const ast = this.moduleAST.get(moduleName);
      let resolved = this.moduleResolve.get(moduleName);
      if (!ast || !resolved) {
        throw new Error(moduleName + " is not found");
      }

      const passes = new PassOrchestrator(ast, resolved);
      if (this.mode.globalAliasing) {
        passes.run("global-alias", (currentResolve) => {
          const changed = insertGlobalAliases(ast, currentResolve, {
            excludeNames: excludeGlobalNames,
          });
          return { changed, invalidatesResolve: changed };
        });
      }
      resolved = passes.resolved;
      const runtime = runtimeEnvironmentOf(this.mode.runtimeProfile);
      const optimizerAnalysis = () =>
        passes.analysis(
          OPTIMIZER_ANALYSIS_CACHE_KEY,
          (chunk, currentResolve, generation) =>
            analyzeOptimizer(chunk, currentResolve, {
              generation,
              runtime,
              assumptions:
                this.mode.allowObservableTableReadChanges === true
                  ? new Map([
                      [
                        "allow-observable-table-read-changes",
                        "explicit allowObservableTableReadChanges opt-in",
                      ],
                    ])
                  : undefined,
            }),
        );
      const localResources = analyzeLocalResourceUsage(ast);

      const lifetimeChangesAllowed =
        !runtime.semantics.debugLocalIntrospection ||
        this.mode.allowIntrospectionChanges === true;
      const localNameReuseEnabled =
        this.mode.localNameReuse && lifetimeChangesAllowed;
      const keepNames = new Set(
        resolved.symbols.filter(
          (symbol) =>
            this.getSourceMetadata(moduleName).annotationsOfIdentifier(
              symbol.declaration,
            ).keepName,
        ),
      );
      if (
        this.schedulerVariant !== "baseline" &&
        (this.mode.localDeclarationMerging ||
          (lifetimeChangesAllowed &&
            (this.mode.localDeclarationHoisting || this.mode.tableReadMerging)))
      ) {
        const provisionalAnalysis =
          !this.mode.localRenaming && !this.mode.globalRenaming
            ? undefined
            : optimizerAnalysis();
        const provisionalRenames =
          !this.mode.localRenaming && !this.mode.globalRenaming
            ? NO_RENAME
            : assignRenames(
                ast,
                resolved,
                plannedIdentifiersInUse,
                this.globalRenames,
                keepNames,
                {
                  allowLocalNameReuse: localNameReuseEnabled,
                  renameLocals: this.mode.localRenaming,
                  analysis: provisionalAnalysis
                    ? {
                        facts: provisionalAnalysis.facts,
                        liveness:
                          provisionalAnalysis.statementDataflow.symbolLiveness,
                      }
                    : undefined,
                },
              );
        passes.run("statement-scheduler", (currentResolve) => {
          const analysis = optimizerAnalysis();
          analysis.interprocedural.diagnostics.forEach((diagnostic) =>
            this.diagnosticCollector?.record({
              pass: "interprocedural-summary",
              moduleName,
              runtimeProfile: runtime.profile,
              decision:
                diagnostic.reason === "unknown-call-target"
                  ? "rejected"
                  : "accepted",
              reason: diagnostic.reason,
              candidateSize: 1,
              sourceRange: diagnostic.sourceRange,
            }),
          );
          const metadata = this.getSourceMetadata(moduleName);
          const canMoveAnnotatedStatement = (
            statement: Parser.LocalStatement,
          ) => {
            const annotations = metadata.annotationsOf(statement);
            return (
              metadata.beforeOf(statement).length === 0 &&
              metadata.trailingOf(statement).length === 0 &&
              !annotations.keep &&
              !annotations.keepName &&
              !annotations.exported
            );
          };
          const plan = planStatementSchedule(ast, currentResolve, {
            facts: analysis.facts,
            dataflow: analysis.statementDataflow,
            outputNameLengthOf: (symbol) =>
              (provisionalRenames.nameOf(symbol.declaration) ?? symbol.name)
                .length,
            preserveRequireSplice: !this.mode.requireWrapper,
            enableLocalPacking:
              lifetimeChangesAllowed && this.mode.localDeclarationHoisting,
            enableLexicalLocalMerge: this.mode.localDeclarationMerging,
            tableEffects:
              lifetimeChangesAllowed && this.mode.tableReadMerging
                ? analysis.tableEffects
                : undefined,
            dirtyGranularity: !this.mode.fieldSensitiveTableEffects
              ? "table"
              : "static-key",
            allowObservableTableValueChanges:
              this.mode.allowObservableTableReadChanges === true,
            maxTableMergeArity:
              runtime.resources.conservativeParallelValueLimit,
            maxTableMergeArityAt: (statement) =>
              checkParallelEvaluation(runtime, {
                activeLocalsBefore:
                  localResources.activeLocalsBefore(statement) ??
                  runtime.resources.maxActiveLocalsPerFunction,
                parallelValueCount:
                  runtime.resources.conservativeParallelValueLimit,
              }).limit,
            canMoveTableRead: canMoveAnnotatedStatement,
            maxHoistedLocalsAt: (statement) => {
              const active = localResources.activeLocalsBefore(statement);
              if (active === undefined) return 0;
              return Math.max(
                0,
                Math.min(
                  runtime.resources.maxActiveLocalsPerFunction - active,
                  runtime.resources.maxRegistersPerFunction - active,
                ),
              );
            },
            canChangeLocalLifetime: canMoveAnnotatedStatement,
            diagnostics: this.diagnosticCollector,
            moduleName,
            runtimeProfile: runtime.profile,
          });
          return applyStatementSchedule(
            plan,
            this.getSourceMetadata(moduleName),
          );
        });
      }

      resolved = passes.resolved;
      this.moduleResolve.set(moduleName, resolved);
      if (this.mode.localRenaming || this.mode.globalRenaming) {
        const finalKeepNames = new Set(
          resolved.symbols.filter(
            (symbol) =>
              this.getSourceMetadata(moduleName).annotationsOfIdentifier(
                symbol.declaration,
              ).keepName,
          ),
        );
        // plannedIdentifiersInUse advances in the same link order as renameAll.
        // Cache this final-generation result so Print does not rebuild the same
        // facts, CFG, liveness, graph, and binding proof a second time.
        const finalRename = assignRenames(
          ast,
          resolved,
          plannedIdentifiersInUse,
          this.globalRenames,
          finalKeepNames,
          {
            allowLocalNameReuse: localNameReuseEnabled,
            renameLocals: this.mode.localRenaming,
          },
        );
        this.renameCache.set(moduleName, finalRename);
        finalRename.usedNames.forEach((name) =>
          plannedIdentifiersInUse.add(name),
        );
      }
      this.progress?.tick();
    });
  }

  /**
   * #8aのGlobal Renameパス: リンクされた全モジュールを横断して、代入されている
   * グローバル（neverRenameGlobalsに含まれるものを除く）に短縮名を割り当てる。
   * グローバルは1つのランタイム束縛をモジュール間で共有するため、この判定・採番は
   * renameAll（モジュールごとに独立して行うローカルのリネーム）より前に、
   * 一度だけ行う必要がある。
   *
   * 選ばれた短縮名はrenameAllの前にidentifiersInUseへ予約し、元の長い名前の予約は
   * 解除する（もう出力に現れないため）。順序を誤ると、
   * ローカルの短縮名がグローバルの新しい短縮名と衝突しうる。
   */
  private computeGlobalRenames() {
    if (!this.mode.globalRenaming) {
      return;
    }
    const neverRename = new Set([
      ...(this.mode.neverRenameGlobals ?? []),
      ...this.annotationProtectedGlobals(),
    ]);
    this.globalRenames = classifyAndRenameGlobals(
      this.moduleResolve,
      neverRename,
      this.identifiersInUse,
    );
    this.globalRenames.forEach((shortName, originalName) => {
      this.identifiersInUse.add(shortName);
      this.identifiersInUse.delete(originalName);
    });
  }

  private printModule(moduleName: string): SourceNode {
    const ast = this.moduleAST.get(moduleName);
    const fileName = this.moduleNameAndFileName.get(moduleName);
    if (!ast || !fileName) {
      throw new Error(moduleName + " is not found");
    }
    return new MinifyFile(fileName, moduleName, ast, this, this.mode).parse();
  }

  private annotationProtectedGlobals(): Set<string> {
    const protectedNames = new Set<string>();
    this.moduleResolve.forEach((resolved, moduleName) => {
      const metadata = this.getSourceMetadata(moduleName);
      resolved.globals.forEach((binding) => {
        if (
          binding.writes.some(
            (write) => metadata.annotationsOfIdentifier(write).keepName,
          )
        ) {
          protectedNames.add(binding.name);
        }
      });
    });
    return protectedNames;
  }

  /**
   * 定数畳み込みパス（#44）: opt-inオプション。既定では無効。
   * link()の直後、removeUnusedAll()の前に実行する。伝搬で参照が消えたローカル
   * 宣言はこのパス自身では消さず、直後に実行される（既定で有効な）未使用ローカル
   * 削除に任せる。
   */
  private foldConstantsAll(): void {
    if (
      !this.mode.constantExpressionEvaluation &&
      !this.mode.localConstantPropagation &&
      !this.mode.interproceduralConstantPropagation
    )
      return;
    this.linkOrder.forEach((moduleName) => {
      const ast = this.moduleAST.get(moduleName);
      const resolved = this.moduleResolve.get(moduleName);
      if (!ast || !resolved) throw new Error(moduleName + " is not found");
      const passes = new PassOrchestrator(ast, resolved);
      if (this.mode.interproceduralConstantPropagation)
        passes.run("interprocedural-constants", () => {
          const analysis = passes.analysis(
            OPTIMIZER_ANALYSIS_CACHE_KEY,
            analyzeOptimizerAtGeneration,
          );
          const changed = propagateInterproceduralConstants(
            ast,
            analysis.interprocedural,
          );
          return { changed, invalidatesResolve: changed };
        });
      if (
        this.mode.constantExpressionEvaluation ||
        this.mode.localConstantPropagation
      )
        passes.runUntilStable("fold-constants", (currentResolve) => {
          const facts = passes.analysis(
            OPTIMIZER_FACTS_CACHE_KEY,
            analyzeOptimizerFactsAtGeneration,
          );
          const changed = foldConstants(
            ast,
            currentResolve,
            this.getSourceMetadata(moduleName),
            facts,
            {
              evaluateExpressions: this.mode.constantExpressionEvaluation,
              propagateLocals: this.mode.localConstantPropagation,
            },
          );
          return { changed, invalidatesResolve: changed };
        });
      this.moduleResolve.set(moduleName, passes.resolved);
      this.progress?.tick();
    });
  }

  private removeUnusedAll(): void {
    if (!this.mode.unusedLocalRemoval && !this.mode.unusedFunctionRemoval)
      return;
    this.linkOrder.forEach((moduleName) => {
      const ast = this.moduleAST.get(moduleName);
      const metadata = this.getSourceMetadata(moduleName);
      const resolved = this.moduleResolve.get(moduleName);
      if (!ast || !resolved) throw new Error(moduleName + " is not found");
      const passes = new PassOrchestrator(ast, resolved);
      passes.runUntilStable("remove-unused", (currentResolve) => {
        const facts = passes.analysis(
          OPTIMIZER_FACTS_CACHE_KEY,
          analyzeOptimizerFactsAtGeneration,
        );
        const changed = removeUnusedLocals(
          ast,
          currentResolve,
          metadata,
          facts,
          (statement) =>
            this.diagnosticCollector?.record({
              pass: "function-dce",
              moduleName,
              runtimeProfile: this.mode.runtimeProfile,
              decision: "accepted",
              reason: "unused-function",
              candidateSize: 1,
              sourceRange: sourceRangeOf(statement),
            }),
          {
            removeLocals: this.mode.unusedLocalRemoval,
            removeFunctions: this.mode.unusedFunctionRemoval,
          },
        );
        return { changed, invalidatesResolve: changed };
      });
      this.moduleResolve.set(moduleName, passes.resolved);
      this.progress?.tick();
    });
  }

  private rebuildIdentifiersInUse(): void {
    this.identifiersInUse.clear();
    this.moduleResolve.forEach((resolved) => {
      resolved.globals.forEach((binding) =>
        this.identifiersInUse.add(binding.name),
      );
    });
  }

  /**
   * エントリファイルから到達可能な全モジュールをASTレベルで解決するLinkパス（#18）。
   * - ファイルごとのパースは一度だけ行う（同一モジュールの多重require/dofileの重複排除）
   * - require/dofileの参照グラフに循環があればエラーを投げる
   * - 出力（Print）を開始する前に、必要なモジュール解決をすべて完了させる
   */
  private link() {
    const visiting = new Set<string>();
    const stack: string[] = [];

    const visit = (moduleName: string) => {
      if (visiting.has(moduleName)) {
        const cycleStart = stack.indexOf(moduleName);
        const cycle = [...stack.slice(cycleStart), moduleName];
        throw new Error(
          "Circular require/dofile detected: " + cycle.join(" -> "),
        );
      }
      if (this.moduleAST.has(moduleName)) {
        // 解決済み（このモジュールは複数箇所から参照されていても一度しかパースしない）
        return;
      }

      visiting.add(moduleName);
      stack.push(moduleName);

      const fullResolvePath =
        path.join(this.dir, ...moduleName.split(".")) + ".lua";
      if (!fs.existsSync(fullResolvePath)) {
        throw new Error(moduleName + " is not found");
      }
      const code = fs.readFileSync(fullResolvePath).toString();
      const ast = Parser.parse(code, this.luaParseSettings) as Chunk;

      this.moduleMetadata.set(moduleName, new SourceMetadata(ast, code));

      // Resolveパス（#19）: このモジュールのスコープ/シンボルを解析し、Renameパスの
      // 入力として使い回せるようキャッシュする。グローバル参照はプログラム全体で
      // 予約すべき名前（identifiersInUse）としてここで集計する。
      const resolved = resolveScopes(ast);
      this.moduleResolve.set(moduleName, resolved);
      this.moduleSourceText.set(moduleName, code);
      this.moduleAST.set(moduleName, ast);
      // Source Mapの`sources`はURLとして解釈されるため、OS依存のpath.sepではなく
      // 常に"/"区切りで保持する（Windows上でのビルドでも壊れないように）。
      this.moduleNameAndFileName.set(
        moduleName,
        moduleName.replaceAll(".", "/") + ".lua",
      );

      findModuleReferences(ast).forEach((ref) => {
        visit(ref.moduleName);
      });

      visiting.delete(moduleName);
      stack.pop();
      this.linkOrder.push(moduleName);
      this.progress?.tick();
    };

    visit(this.entryModule);
  }

  /**
   * require()（dofileは除く）で参照されているモジュール名の集合を求める。
   * dofileは呼び出しごとに毎回展開しなおすため、キャッシュ／ホイストの対象にしない。
   */
  private collectRequireTargets(): Set<string> {
    const targets = new Set<string>();
    this.linkOrder.forEach((moduleName) => {
      const ast = this.moduleAST.get(moduleName);
      if (!ast) {
        return;
      }
      findModuleReferences(ast).forEach((ref) => {
        if (ref.kind === "require") {
          targets.add(ref.moduleName);
        }
      });
    });
    return targets;
  }

  private printModuleWithRequireWrapper(): SourceNode {
    const targets = this.collectRequireTargets();
    const moduleNames = this.linkOrder.filter(
      (moduleName) =>
        moduleName !== this.entryModule && targets.has(moduleName),
    );
    const wrapperAst = buildRequireWrapperAst(moduleNames);
    const entryAst = this.moduleAST.get(this.entryModule);
    const entryFileName = this.moduleNameAndFileName.get(this.entryModule);
    if (!entryAst || !entryFileName) {
      throw new Error(this.entryModule + " is not found");
    }
    const statements: GeneratedStatement[] = [
      wrapperAst,
      { type: "ModuleSplice", moduleName: this.entryModule },
    ];
    return new MinifyFile(
      entryFileName,
      this.entryModule,
      entryAst,
      this,
      this.mode,
    ).printGeneratedStatements(statements);
  }
}
