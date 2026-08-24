import Parser, { Options } from "luaparse";
import path from "path";
import fs from "fs";
import { SourceNode } from "source-map";
import { Chunk, MinifyFile } from "./ast2lua";
import { findModuleReferences } from "./linker";
import { resolveScopes, ResolveResult } from "./resolver";
import { assignRenames, RenameResult } from "./renamer";
import { classifyAndRenameGlobals } from "./globalRename";
import { mergeLocalDeclarations, insertGlobalAliases } from "./transform";
import { SourceMetadata } from "./sourceMetadata";
import { removeUnusedLocals } from "./removeUnused";
import { foldConstants } from "./constantFold";
import { buildRequireWrapperAst, GeneratedStatement } from "./generatedAst";
import {
  applyNonAdjacentLocalPlan,
  planNonAdjacentLocals,
} from "./nonAdjacentLocals";
import { analyzeTableEffects } from "./tableEffects";
import { applyTableReadMergePlan, planTableReadMerges } from "./tableReadMerge";
import { PassOrchestrator } from "./optimizerPass";
import {
  analyzeLocalResourceUsage,
  checkParallelEvaluation,
  RuntimeProfile,
  runtimeEnvironmentOf,
} from "./runtimeEnvironment";
import {
  OptimizationDiagnostic,
  OptimizationDiagnosticCollector,
} from "./optimizerDiagnostics";

export type { RuntimeProfile } from "./runtimeEnvironment";

export interface MinifierMode {
  moduleLikeLua: boolean;
  // 実行環境の意味論。moduleLikeLua（require出力方式）とは独立。
  // 省略時は後方互換のためlua53として扱う。
  runtimeProfile?: RuntimeProfile;
  // 選択環境で意味を保存する効果解析Transformのmaster opt-out。
  // Stormworks profileでは省略時に有効。
  effectAwareTransforms?: boolean;
  // RHSを元位置に残す非連続local宣言hoistの個別opt-out。
  effectAwareLocalHoist?: boolean;
  // fresh・nonescape tableの安定したreadを含むlocal mergeの個別opt-out。
  effectAwareTableReads?: boolean;
  // dirtyなtable readも対象に含める積極的なopt-in。
  aggressiveTableReadMerges?: boolean;
  // table全体ではなくstatic key単位でdirtyを追跡する精密化の個別opt-out。
  fieldSensitiveTableEffects?: boolean;
  // 純Luaでdebug APIから観測できるlocal lifetimeの変更を許可するopt-in。
  // Stormworksではdebug introspectionを前提にしないため指定不要。
  allowLocalLifetimeChanges?: boolean;
  // 字句の結合を防ぐために必要な1バイトの空白。省略時は、出力サイズを
  // 増やさずStormworksの行単位診断を改善できるLFを使う。
  requiredWhitespace?: " " | "\n";
  // 識別子の短縮(リネーム)を行うかどうか。デバッグ用途でfalseにできる。省略時はtrue扱い。
  rename?: boolean;
  // 内部でのみ使用するグローバル識別子の短縮（#8a）を行うかどうか。省略時はfalse扱い。
  // 外部から名前で参照されるグローバルを静的に識別できないため、明示的なopt-inとする。
  // renameがfalseの場合はこちらの値に関わらず無効になる。
  globalRename?: boolean;
  // 代入されていてもリネームしないグローバル名（エンジン側のコールバック規約名など）。
  // CLIの--reserved-globals-configで指定された設定ファイルから読み込む想定。
  neverRenameGlobals?: ReadonlySet<string>;
  // 連続するlocal変数宣言のまとめ上げ（#9）を行うかどうか。省略時はtrue扱い。
  mergeLocals?: boolean;
  // 外部グローバル識別子（リネーム不可のもの）のローカル代入短縮（#8b）を
  // 行うかどうか。省略時はtrue扱い。renameがfalseの場合は常に無効になる。
  globalAlias?: boolean;
  // 未使用ローカル宣言の安全な範囲での削除。省略時はtrue扱い。
  removeUnused?: boolean;
  // 将来の未使用グローバル削除用スイッチ。removeUnused=falseなら常に無効。
  removeUnusedGlobals?: boolean;
  // 定数式の事前計算と、定数ローカル変数の伝搬。省略時はfalse扱い（明示的に有効化する）。
  foldConstants?: boolean;
  // 最適化候補の採否理由を収集する。既定offで、生成結果には影響しない。
  collectOptimizationDiagnostics?: boolean;
}

const NO_RENAME: RenameResult = {
  nameOf: () => undefined,
  usedNames: new Set(),
};

export class Minifier {
  readonly identifiersInUse: Set<string>;
  readonly moduleSourceText: Map<string, string>;
  readonly moduleAST: Map<string, Chunk>;
  readonly moduleNameAndFileName: Map<string, string>;
  readonly dir: string;
  readonly entryModule: string;
  readonly mode: MinifierMode;
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

  constructor(
    entryFilePath: string,
    luaParseSettings: Partial<Options>,
    mode: MinifierMode,
  ) {
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
    this.mode = mode;
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

  parse(): SourceNode {
    this.link();
    this.foldConstantsAll();
    this.removeUnusedAll();
    this.rebuildIdentifiersInUse();
    this.computeGlobalRenames();
    this.transformAll();
    this.renameAll();

    const result = this.mode.moduleLikeLua
      ? this.printModuleWithRequireWrapper()
      : this.printModule(this.entryModule);

    this.moduleSourceText.forEach((v, k) => {
      const fileName = this.moduleNameAndFileName.get(k);
      if (fileName) {
        result.setSourceContent(fileName, v);
      }
    });

    return result;
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
    if (this.mode.rename === false) {
      return NO_RENAME;
    }
    const cached = this.renameCache.get(moduleName);
    if (!cached) {
      throw new Error(moduleName + " is not found");
    }
    return cached;
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
    if (this.mode.rename === false) {
      return;
    }
    this.linkOrder.forEach((moduleName) => {
      const resolved = this.moduleResolve.get(moduleName);
      if (!resolved) {
        throw new Error(moduleName + " is not found");
      }
      const result = assignRenames(
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
      );
      this.renameCache.set(moduleName, result);
      result.usedNames.forEach((name) => this.identifiersInUse.add(name));
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
      if (this.mode.rename !== false && this.mode.globalAlias !== false) {
        passes.run("global-alias", (currentResolve) => {
          const changed = insertGlobalAliases(ast, currentResolve, {
            excludeNames: excludeGlobalNames,
          });
          return { changed, invalidatesResolve: changed };
        });
      }
      resolved = passes.resolved;
      const runtime = runtimeEnvironmentOf(this.mode.runtimeProfile ?? "lua53");
      const localResources = analyzeLocalResourceUsage(ast);

      const effectAwareLocalsEnabled =
        this.mode.effectAwareTransforms !== false &&
        (!runtime.semantics.debugLocalIntrospection ||
          this.mode.allowLocalLifetimeChanges === true);
      if (
        effectAwareLocalsEnabled &&
        this.mode.effectAwareTableReads !== false
      ) {
        passes.run("effect-aware-table-reads", (currentResolve) => {
          const tablePlan = planTableReadMerges(
            ast,
            analyzeTableEffects(ast, currentResolve),
            {
              dirtyGranularity:
                this.mode.fieldSensitiveTableEffects === false
                  ? "table"
                  : "static-key",
              canMoveStatement: (statement) => {
                const metadata = this.getSourceMetadata(moduleName);
                const annotations = metadata.annotationsOf(statement);
                return (
                  metadata.beforeOf(statement).length === 0 &&
                  metadata.trailingOf(statement).length === 0 &&
                  !annotations.keep &&
                  !annotations.keepName &&
                  !annotations.exported
                );
              },
              maxMergeArity: runtime.resources.conservativeParallelValueLimit,
              maxMergeArityAt: (statement) =>
                checkParallelEvaluation(runtime, {
                  activeLocalsBefore:
                    localResources.activeLocalsBefore(statement) ??
                    runtime.resources.maxActiveLocalsPerFunction,
                  parallelValueCount:
                    runtime.resources.conservativeParallelValueLimit,
                }).limit,
              diagnostics: this.diagnosticCollector,
              moduleName,
              runtimeProfile: runtime.profile,
              allowObservableValueChanges:
                this.mode.aggressiveTableReadMerges === true,
            },
          );
          return applyTableReadMergePlan(
            tablePlan,
            this.getSourceMetadata(moduleName),
          );
        });
      }

      resolved = passes.resolved;
      const keepNames = new Set(
        resolved.symbols.filter(
          (symbol) =>
            this.getSourceMetadata(moduleName).annotationsOfIdentifier(
              symbol.declaration,
            ).keepName,
        ),
      );
      if (
        effectAwareLocalsEnabled &&
        this.mode.effectAwareLocalHoist !== false
      ) {
        const provisionalRenames =
          this.mode.rename === false
            ? NO_RENAME
            : assignRenames(
                resolved,
                plannedIdentifiersInUse,
                this.globalRenames,
                keepNames,
              );
        passes.run("effect-aware-local-hoist", (currentResolve) => {
          const plan = planNonAdjacentLocals(ast, currentResolve, {
            outputNameLengthOf: (symbol) =>
              (provisionalRenames.nameOf(symbol.declaration) ?? symbol.name)
                .length,
            preserveRequireSplice: !this.mode.moduleLikeLua,
            diagnostics: this.diagnosticCollector,
            moduleName,
            runtimeProfile: runtime.profile,
          });
          return applyNonAdjacentLocalPlan(
            plan,
            this.getSourceMetadata(moduleName),
          );
        });
      }

      resolved = passes.resolved;
      if (this.mode.mergeLocals !== false) {
        passes.run("merge-local-declarations", (currentResolve) => ({
          changed: mergeLocalDeclarations(
            ast,
            currentResolve,
            {
              preserveRequireSplice: !this.mode.moduleLikeLua,
            },
            this.getSourceMetadata(moduleName),
          ),
          invalidatesResolve: false,
        }));
      }

      resolved = passes.resolved;
      this.moduleResolve.set(moduleName, resolved);
      if (this.mode.rename !== false) {
        const finalKeepNames = new Set(
          resolved.symbols.filter(
            (symbol) =>
              this.getSourceMetadata(moduleName).annotationsOfIdentifier(
                symbol.declaration,
              ).keepName,
          ),
        );
        assignRenames(
          resolved,
          plannedIdentifiersInUse,
          this.globalRenames,
          finalKeepNames,
        ).usedNames.forEach((name) => plannedIdentifiersInUse.add(name));
      }
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
    if (this.mode.rename === false || this.mode.globalRename !== true) {
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
    if (this.mode.foldConstants !== true) return;
    this.linkOrder.forEach((moduleName) => {
      const ast = this.moduleAST.get(moduleName);
      const resolved = this.moduleResolve.get(moduleName);
      if (!ast || !resolved) throw new Error(moduleName + " is not found");
      const passes = new PassOrchestrator(ast, resolved);
      passes.runUntilStable("fold-constants", (currentResolve) => {
        const changed = foldConstants(
          ast,
          currentResolve,
          this.getSourceMetadata(moduleName),
        );
        return { changed, invalidatesResolve: changed };
      });
      this.moduleResolve.set(moduleName, passes.resolved);
    });
  }

  private removeUnusedAll(): void {
    if (this.mode.removeUnused === false) return;
    this.linkOrder.forEach((moduleName) => {
      const ast = this.moduleAST.get(moduleName);
      const metadata = this.getSourceMetadata(moduleName);
      const resolved = this.moduleResolve.get(moduleName);
      if (!ast || !resolved) throw new Error(moduleName + " is not found");
      const passes = new PassOrchestrator(ast, resolved);
      passes.runUntilStable("remove-unused", (currentResolve) => {
        const changed = removeUnusedLocals(ast, currentResolve, metadata);
        return { changed, invalidatesResolve: changed };
      });
      this.moduleResolve.set(moduleName, passes.resolved);
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
