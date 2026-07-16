import Parser, { Options } from "luaparse";
import path from "path";
import fs from "fs";
import { SourceNode } from "source-map";
import { Chunk, MinifyFile } from "./ast2lua";
import { findModuleReferences } from "./linker";
import { resolveScopes, ResolveResult } from "./resolver";
import { assignRenames, RenameResult } from "./renamer";

export interface MinifierMode {
  moduleLikeLua: boolean;
  // 識別子の短縮(リネーム)を行うかどうか。デバッグ用途でfalseにできる。省略時はtrue扱い。
  rename?: boolean;
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

  constructor(
    entryFilePath: string,
    luaParseSettings: Partial<Options>,
    mode: MinifierMode,
  ) {
    this.identifiersInUse = new Set<string>();
    this.moduleSourceText = new Map<string, string>();
    this.moduleAST = new Map<string, Chunk>();
    this.moduleNameAndFileName = new Map<string, string>();
    this.luaParseSettings = luaParseSettings;
    this.mode = mode;
    const pn = path.parse(entryFilePath);
    this.dir = pn.dir;
    this.entryModule = pn.name;
  }

  parse(): SourceNode {
    this.link();
    this.renameAll();

    const parts: (SourceNode | string)[] = [];

    const entryComments = this.moduleAST.get(this.entryModule)?.comments;
    if (entryComments) {
      entryComments
        .filter((v) => v.raw.includes("--#") || v.raw.includes("[[#"))
        .forEach((comment) => {
          parts.push(
            new SourceNode(
              comment.loc?.start.line ?? null,
              comment.loc?.start.column ?? null,
              this.moduleNameAndFileName.get(this.entryModule) ?? null, // 本当に自分のファイル名でよいかは要検討
              comment.raw,
            ),
            "\n",
          );
        });
    }

    if (this.mode.moduleLikeLua) {
      parts.push(this.buildRequireWrapper());
    }

    parts.push(this.printModule(this.entryModule));

    const result = new SourceNode(null, null, null, parts);

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
    ).parseAsStatementsAndFinalExpression(moduleName === this.entryModule);
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
      const result = assignRenames(resolved, this.identifiersInUse);
      this.renameCache.set(moduleName, result);
      result.usedNames.forEach((name) => this.identifiersInUse.add(name));
    });
  }

  private printModule(moduleName: string): SourceNode {
    const ast = this.moduleAST.get(moduleName);
    const fileName = this.moduleNameAndFileName.get(moduleName);
    if (!ast || !fileName) {
      throw new Error(moduleName + " is not found");
    }
    return new MinifyFile(fileName, moduleName, ast, this, this.mode).parse(
      moduleName === this.entryModule,
    );
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

      const resolvePath = moduleName.replaceAll(".", path.sep) + ".lua";
      const fullResolvePath = path.join(this.dir, resolvePath);
      if (!fs.existsSync(fullResolvePath)) {
        throw new Error(moduleName + " is not found");
      }
      const code = fs.readFileSync(fullResolvePath).toString();
      const ast = Parser.parse(code, this.luaParseSettings) as Chunk;

      // Resolveパス（#19）: このモジュールのスコープ/シンボルを解析し、Renameパスの
      // 入力として使い回せるようキャッシュする。グローバル参照はプログラム全体で
      // 予約すべき名前（identifiersInUse）としてここで集計する。
      const resolved = resolveScopes(ast);
      this.moduleResolve.set(moduleName, resolved);
      resolved.globals.forEach((binding) =>
        this.identifiersInUse.add(binding.name),
      );

      this.moduleSourceText.set(moduleName, code);
      this.moduleAST.set(moduleName, ast);
      this.moduleNameAndFileName.set(moduleName, resolvePath);

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

  private buildRequireWrapper(): SourceNode {
    const targets = this.collectRequireTargets();
    const parts: (SourceNode | string)[] = [
      "function require(m,r)package=package or{loaded={}};if package.loaded[m]then return package.loaded[m]end\n",
    ];
    this.linkOrder.forEach((moduleName) => {
      if (moduleName === this.entryModule || !targets.has(moduleName)) {
        return;
      }
      parts.push(
        'if m=="',
        moduleName,
        '"then r=(function() ',
        this.printModule(moduleName),
        " end)()end\n",
      );
    });
    parts.push(
      "package.loaded[m]=package.loaded[m]or r or true;return package.loaded[m]end\n",
    );
    return new SourceNode(null, null, null, parts);
  }
}
