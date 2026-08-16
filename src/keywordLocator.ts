import Parser, { Options } from "luaparse";

// luaparseの型定義(@types/luaparse)には`tokenTypes`が含まれないため、
// 実行時の値を直接参照する。luaparse 0.3.1のソース上の定義は
// `var EOF = 1, StringLiteral = 2, Keyword = 4, ...`。
const tokenTypes = (
  Parser as unknown as { tokenTypes: { Keyword: number; EOF: number } }
).tokenTypes;

interface KeywordToken {
  value: string;
  line: number;
  column: number;
}

function comparePosition(
  a: { line: number; column: number },
  b: { line: number; column: number },
): number {
  return a.line !== b.line ? a.line - b.line : a.column - b.column;
}

/**
 * luaparseのASTは文・式の境界にしか`loc`を持たず、`then`/`do`/`until`のような
 * キーワード単体の出現位置は保持しない。このクラスはluaparseの低レベル
 * 再トークン化API（`parse(code, {wait: true, ...})` + `lex()`）でモジュールの
 * ソースを再走査し、キーワードトークンの正確な位置を検索できるようにする（#14）。
 */
export class KeywordLocator {
  private readonly tokens: KeywordToken[];

  constructor(sourceText: string, luaParseSettings: Partial<Options>) {
    const parser = Parser.parse(sourceText, {
      ...luaParseSettings,
      wait: true,
    });
    const tokens: KeywordToken[] = [];
    for (;;) {
      const token = parser.lex();
      if (token.type === tokenTypes.EOF) {
        break;
      }
      if (token.type === tokenTypes.Keyword) {
        tokens.push({
          value: token.value,
          line: token.line,
          column: token.range[0] - token.lineStart,
        });
      }
    }
    this.tokens = tokens;
  }

  /**
   * `from`（含む）以降で最初に現れる、値が`value`と一致するキーワードトークンの
   * 開始位置を返す。見つからない場合はundefined。
   */
  findFrom(
    from: { line: number; column: number },
    value: string,
  ): { line: number; column: number } | undefined {
    let lo = 0;
    let hi = this.tokens.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (comparePosition(this.tokens[mid], from) < 0) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }
    for (let i = lo; i < this.tokens.length; i++) {
      if (this.tokens[i].value === value) {
        return { line: this.tokens[i].line, column: this.tokens[i].column };
      }
    }
    return undefined;
  }
}
