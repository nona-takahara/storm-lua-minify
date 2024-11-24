import Parser, { Comment, Options } from "luaparse";
import path from "path";
import fs from "fs";
import { SourceNode } from "source-map";
import { Chunk, MinifyFile } from "./ast2lua";

export interface MinifierMode {
  moduleLikeLua: boolean;
}

export class Minifier {
  readonly identifierMap: Map<string, string>;
  readonly identifiersInUse: Set<string>;
  readonly moduleSourceText: Map<string, string>;
  readonly moduleSourceNode: Map<string, SourceNode>;
  readonly moduleAST: Map<string, Chunk>;
  readonly dir: string;
  readonly entryModule: string;
  readonly mode: MinifierMode;
  readonly luaParseSettings: Partial<Options>;

  constructor(
    entryFilePath: string,
    luaParseSettings: Partial<Options>,
    mode: MinifierMode
  ) {
    this.identifierMap = new Map<string, string>();
    this.identifiersInUse = new Set<string>();
    this.moduleSourceText = new Map<string, string>();
    this.moduleSourceNode = new Map<string, SourceNode>();
    this.moduleAST = new Map<string, Chunk>();
    this.luaParseSettings = luaParseSettings;
    this.mode = mode;
    const pn = path.parse(entryFilePath);
    this.dir = pn.dir;
    this.entryModule = pn.name;
  }

  parse() {
    const sn = this.parseModule(this.entryModule);

    if (this.mode.moduleLikeLua) {
      // require関数を作成し、流し込む
      /*
      function require(m,r)
        package=package or {loaded={}}
        if package.loaded[m] then return package.loaded[m] end
        if m=="<MODULE_NAME>" then r=(function()[[MODULE]]end)() end
        package.loaded[m]=package.loaded[m] or r or true;return package.loaded[m]
      end
      */
      sn.prepend("package.loaded[m]=package.loaded[m]or r or true;return package.loaded[m]end\n");
      this.moduleSourceNode.forEach((v, k) => {
        if (k !== this.entryModule) {
            sn.prepend(["if m==\"", k, "\"then r=(function() ", v ," end)()end\n"]);
        }
      });
      sn.prepend("function require(m,r)package=package or{loaded={}};if package.loaded[m]then return package.loaded[m]end\n");
    }

    // コメントの流し込み
    const comments = this.moduleAST.get(this.entryModule)?.comments as
      | Comment[]
      | undefined;
    if (comments) {
      comments
        .reverse()
        .filter((v) => v.raw.includes("--#") || v.raw.includes("[[#"))
        .forEach((comment) => {
          sn.prepend([
            new SourceNode(
              comment.loc?.start.line || null,
              comment.loc?.start.column || null,
              this.entryModule, // 本当に自分のファイル名でよいかは要検討
              comment.raw
            )
          ,"\n"]);
        });
    }

    return sn;
  }

  parseModule(moduleName: string): SourceNode {
    const resolvePath = moduleName.replaceAll(".", path.sep) + ".lua";
    const fullResolvePath = path.join(this.dir, resolvePath);

    if (this.moduleSourceNode.has(moduleName)) {
      const res = this.moduleSourceNode.get(moduleName);
      if (res) {
        return res;
      }
    } else if (fs.existsSync(fullResolvePath)) {
      const code = fs.readFileSync(fullResolvePath).toString();
      const ast = Parser.parse(code, this.luaParseSettings) as Chunk;
      if ("globals" in ast) {
        ast.globals?.map((v) => this.identifiersInUse.add(v.name));

        const sourceNode = new MinifyFile(
          resolvePath,
          ast,
          this,
          this.mode
        ).parse(resolvePath === this.entryModule);

        this.moduleSourceText.set(moduleName, code);
        this.moduleAST.set(moduleName, ast);
        this.moduleSourceNode.set(moduleName, sourceNode);
        return sourceNode;
      }
    }
    throw new Error(moduleName + " is not found");
  }
}
