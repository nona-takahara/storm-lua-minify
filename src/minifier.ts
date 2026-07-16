import Parser, { Options } from "luaparse";
import path from "path";
import fs from "fs";
import { SourceNode } from "source-map";
import { Chunk, MinifyFile, IDENTIFIER_PARTS, isKeyword } from "./ast2lua";
import { findModuleReferences } from "./linker";

export interface MinifierMode {
  moduleLikeLua: boolean;
}

export class Minifier {
  readonly identifierMap: Map<string, string>;
  readonly identifiersInUse: Set<string>;
  readonly moduleSourceText: Map<string, string>;
  readonly moduleAST: Map<string, Chunk>;
  readonly moduleNameAndFileName: Map<string, string>;
  readonly dir: string;
  readonly entryModule: string;
  readonly mode: MinifierMode;
  readonly luaParseSettings: Partial<Options>;

  private currentIdentifier = 0;
  // Linkパスで解決されたモジュール名を、依存されている側が先に来る順序で並べたもの
  private readonly linkOrder: string[] = [];

  constructor(
    entryFilePath: string,
    luaParseSettings: Partial<Options>,
    mode: MinifierMode,
  ) {
    this.identifierMap = new Map<string, string>();
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

  allocateIdentifier(key: string): string {
    const defined = this.identifierMap.get(key);
    if (defined) {
      return defined;
    }
    if (this.identifiersInUse.has(key)) {
      return key;
    }

    let id = "";
    do {
      let p = this.currentIdentifier++;
      const l = IDENTIFIER_PARTS.length;
      id = IDENTIFIER_PARTS[p % l];
      p = Math.floor(p / l);
      while (p >= l) {
        id += IDENTIFIER_PARTS[p % l];
        p = Math.floor(p / l);
      }
    } while (isKeyword(id) || this.identifiersInUse.has(id));

    this.identifierMap.set(key, id);
    return id;
  }

  private printModule(moduleName: string): SourceNode {
    const ast = this.moduleAST.get(moduleName);
    const fileName = this.moduleNameAndFileName.get(moduleName);
    if (!ast || !fileName) {
      throw new Error(moduleName + " is not found");
    }
    return new MinifyFile(fileName, ast, this, this.mode).parse(
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
      if (!("globals" in ast)) {
        throw new Error(moduleName + " is not found");
      }
      ast.globals?.forEach((v) => this.identifiersInUse.add(v.name));

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
