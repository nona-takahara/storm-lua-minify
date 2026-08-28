// based on "luamin": Copyright Mathias Bynens <https://mathiasbynens.be/>
// SPDX-License-Identifier: MIT

/* eslint-disable @typescript-eslint/no-unnecessary-condition */
import Parser, { Comment } from "luaparse";
import { SourceNode } from "source-map";
import { Minifier, MinifierMode } from "./minifier";
import { staticStringArgument } from "./linker";
import { KeywordLocator } from "./keywordLocator";
import { originalNameOf } from "./transform";
import { isPreservedComment } from "./sourceMetadata";
import { GeneratedStatement } from "./generatedAst";

export type Chunk = Parser.Chunk & {
  globals?: (Parser.Base<"Identifer"> & {
    name: string;
    isLocal: boolean;
  })[];
  comments?: Comment[];
};

const PRECEDENCE: Record<string, number> = {
  or: 1,
  and: 2,
  "<": 3,
  ">": 3,
  "<=": 3,
  ">=": 3,
  "~=": 3,
  "==": 3,
  "|": 4,
  "~": 5, // binary ~ (bxor)
  "&": 6,
  "<<": 7,
  ">>": 7,
  "..": 9,
  "+": 10,
  "-": 10, // binary -
  "*": 11,
  "/": 11,
  "//": 11,
  "%": 11,
  unarynot: 12,
  "unary#": 12,
  "unary-": 12, // unary -
  "unary~": 12, // unary ~ (bnot)
  "^": 14,
};

export const IDENTIFIER_PARTS = [
  "a",
  "b",
  "c",
  "d",
  "e",
  "f",
  "g",
  "h",
  "i",
  "j",
  "k",
  "l",
  "m",
  "n",
  "o",
  "p",
  "q",
  "r",
  "s",
  "t",
  "u",
  "v",
  "w",
  "x",
  "y",
  "z",
  "A",
  "B",
  "C",
  "D",
  "E",
  "F",
  "G",
  "H",
  "I",
  "J",
  "K",
  "L",
  "M",
  "N",
  "O",
  "P",
  "Q",
  "R",
  "S",
  "T",
  "U",
  "V",
  "W",
  "X",
  "Y",
  "Z",
  "_",
];

function wrapArray<T>(obj: T | T[]): T[] {
  if (Array.isArray(obj)) {
    return obj;
  }
  return [obj];
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars -- 現時点では未参照だが、オリジナル(luamin)由来のコードのため残置
function generateZeroes(length: number) {
  let zero = "0";
  let result = "";
  if (length < 1) {
    return result;
  }
  if (length == 1) {
    return zero;
  }
  while (length) {
    if (length & 1) {
      result += zero;
    }
    if ((length >>= 1)) {
      zero += zero;
    }
  }
  return result;
}

export function isKeyword(id: string) {
  switch (id.length) {
    case 2:
      return "do" == id || "if" == id || "in" == id || "or" == id;
    case 3:
      return (
        "and" == id || "end" == id || "for" == id || "nil" == id || "not" == id
      );
    case 4:
      return "else" == id || "goto" == id || "then" == id || "true" == id;
    case 5:
      return (
        "break" == id ||
        "false" == id ||
        "local" == id ||
        "until" == id ||
        "while" == id
      );
    case 6:
      return "elseif" == id || "repeat" == id || "return" == id;
    case 8:
      return "function" == id;
  }
  return false;
}

// 末尾が16進整数リテラル（0x/0Xの後に16進数字が1つ以上続く）かどうか。
// a〜fは識別子の文字集合とも重なるため、isNeedSeparatorのalpha分岐だけでは
// 区別できない（#53）。
const HEX_INT_LITERAL_TAIL = /0[xX][0-9a-fA-F]+$/;

function isNeedSeparator(a: string, b: string) {
  const lastCharA = a.slice(-1);
  const firstCharB = b.charAt(0);

  const regexAlphaUnderscore = /[a-zA-Z_]/;
  const regexAlphaNumUnderscore = /[a-zA-Z0-9_]/;
  const regexDigits = /[0-9]/;

  if (lastCharA == "" || firstCharB == "") {
    return false;
  }
  if (regexAlphaUnderscore.test(lastCharA)) {
    if (regexAlphaNumUnderscore.test(firstCharB)) {
      // e.g. `while` + `1`
      // e.g. `local a` + `local b`
      return true;
    }
    if (firstCharB == "." && HEX_INT_LITERAL_TAIL.test(a)) {
      // e.g. `0xff` + `..` : 16進の浮動小数点(`0xff.8`)も読めてしまうため、
      // 続く`.`をそのまま出すと`0xff.`まで数値として読まれ、10進では起きない
      // 区切り落ち（malformed number）になる（#53）。
      return true;
    }
    // e.g. `not` + `(2>3 or 3<2)`
    // e.g. `x` + `^`
    return false;
  }
  if (regexDigits.test(lastCharA)) {
    if (
      firstCharB == "(" ||
      !(firstCharB == "." || regexAlphaUnderscore.test(firstCharB))
    ) {
      // e.g. `1` + `+`
      // e.g. `1` + `==`
      return false;
    } else {
      // e.g. `1` + `..`
      // e.g. `1` + `and`
      return true;
    }
  }
  if (lastCharA == firstCharB && lastCharA == "-") {
    // e.g. `1-` + `-2`
    return true;
  }
  const secondLastCharA = a.slice(-2, -1);
  if (
    lastCharA == "." &&
    secondLastCharA != "." &&
    regexAlphaNumUnderscore.test(firstCharB)
  ) {
    // e.g. `1.` + `print`
    return true;
  }
  return false;
}

interface ExpressionOptoions {
  precedence?: number;
  preserveIdentifiers?: boolean;
  direction?: "left" | "right" | undefined;
  parent?: string | undefined;
}

const requiredWhitespaceByNode = new WeakMap<SourceNode, " " | "\n">();

function whitespaceOf(...values: (string | SourceNode)[]): " " | "\n" {
  for (const value of values) {
    if (value instanceof SourceNode) {
      const whitespace = requiredWhitespaceByNode.get(value);
      if (whitespace) return whitespace;
    }
  }
  return "\n";
}

function addWithSeparator(
  val: SourceNode,
  adding: (string | SourceNode)[] | SourceNode | string,
  separator = whitespaceOf(val),
) {
  if (
    isNeedSeparator(
      val.toString(),
      wrapArray(adding)
        .map((p) => p.toString())
        .join(),
    )
  ) {
    val.add(separator);
  }
  val.add(adding);
  return val;
}

function prependWithSeparator(
  val: SourceNode,
  prepending: (string | SourceNode)[] | SourceNode | string,
  separator = whitespaceOf(val),
) {
  if (
    isNeedSeparator(
      wrapArray(prepending)
        .map((p) => p.toString())
        .join(),
      val.toString(),
    )
  ) {
    val.prepend(separator);
  }
  val.prepend(prepending);
  return val;
}

function insertSeparator(
  a: string | SourceNode,
  b: string | SourceNode,
  separator = whitespaceOf(a, b),
) {
  return isNeedSeparator(a.toString(), b.toString()) ? separator : undefined;
}

export class MinifyFile {
  private fileName: string;
  private moduleName: string;
  private ast: Chunk;
  private minifier: Minifier;
  private mode: MinifierMode;
  private requiredWhitespace: " " | "\n";

  constructor(
    fileName: string,
    moduleName: string,
    ast: Chunk,
    minifier: Minifier,
    mode: MinifierMode,
  ) {
    this.fileName = fileName;
    this.moduleName = moduleName;
    this.ast = ast;
    this.minifier = minifier;
    this.mode = mode;
    this.requiredWhitespace = mode.requiredWhitespace ?? "\n";
  }

  /** 合成文同士の境界も、通常の文リストと同じ区切り判定で出力する。 */
  printGeneratedStatements(statements: GeneratedStatement[]): SourceNode {
    return this.formatStatementList(statements);
  }

  parse() {
    const body = this.formatStatementList(this.ast.body);
    this.minifier
      .getSourceMetadata(this.moduleName)
      .afterModuleComments()
      .filter(isPreservedComment)
      .forEach((comment) => {
        body.add(["\n", this.sourceNodeHelper(comment, comment.raw)]);
      });
    return body;
  }

  /**
   * モジュール本体の最後の文が「単一の式を返すreturn文」であるときに限り、
   * それ以外の文と最後の式を分けて返す。requireを式（IIFE）ではなく文として
   * 展開したい呼び出し側（#29のレビュー対応）が利用する。
   * 該当しない場合はundefinedを返し、呼び出し側はIIFE方式へフォールバックする。
   */
  parseAsStatementsAndFinalExpression():
    { statements: SourceNode; finalExpression: SourceNode } | undefined {
    const body = this.ast.body;
    const last = body[body.length - 1];
    if (
      !last ||
      last.type !== "ReturnStatement" ||
      last.arguments.length !== 1
    ) {
      return undefined;
    }

    const statements = this.formatStatementList(body.slice(0, -1));

    const metadata = this.minifier.getSourceMetadata(this.moduleName);
    [
      ...metadata.beforeOf(last),
      ...metadata.trailingOf(last),
      ...metadata.afterModuleComments(),
    ]
      .filter(isPreservedComment)
      .forEach((comment) => {
        statements.add([
          "\n",
          this.sourceNodeHelper(comment, comment.raw),
          "\n",
        ]);
      });

    const finalExpression = this.formatExpression(last.arguments[0]);
    return { statements, finalExpression };
  }

  private sourceNodeHelper(
    node: Parser.Node | undefined,
    chuncks: (SourceNode | string)[] | SourceNode | string,
    name?: string,
  ) {
    const line = node?.loc?.start.line;
    const column = node?.loc?.start.column;
    // this.fileNameは常にこのMinifyFileインスタンスが担当するモジュール自身の
    // ファイル名（Linkパスで解決済み）なので、ここで出力するノードの由来ファイルとして正しい。
    const sourceNode = new SourceNode(
      line == undefined ? null : line,
      column == undefined ? null : column,
      this.fileName,
      chuncks,
      name,
    );
    requiredWhitespaceByNode.set(sourceNode, this.requiredWhitespace);
    return sourceNode;
  }

  private _keywordLocator: KeywordLocator | undefined;

  /**
   * luaparseのASTはキーワード単体の位置を持たないため、`then`/`do`/`until`の
   * ような「文・式の間に挟まるキーワード」の正確な位置は、モジュールの
   * ソースを再トークン化して求める（#14）。初回アクセス時に1回だけ構築する。
   */
  private keywordLocator(): KeywordLocator {
    if (!this._keywordLocator) {
      const sourceText = this.minifier.moduleSourceText.get(this.moduleName);
      if (sourceText == undefined) {
        throw new Error(this.moduleName + " is not found");
      }
      this._keywordLocator = new KeywordLocator(
        sourceText,
        this.minifier.luaParseSettings,
      );
    }
    return this._keywordLocator;
  }

  /**
   * `anchor`ノードの直後（`anchor.loc.end`以降）で最初に現れる`value`という
   * 値のキーワードトークンを探し、その位置を持つ`SourceNode`を返す。
   * `anchor`は「探しているキーワードの直前に必ず存在する、既に位置が分かって
   * いるノード」（例: `then`の場合は条件式）を渡す。ASTの入れ子構造上、
   * その直前ノードの`loc.end`以降を走査すれば、ネストした同名キーワード
   * （入れ子の`if...then`等）を誤って拾うことはない。
   */
  private keywordAfter(anchor: Parser.Node, value: string): SourceNode {
    if (!anchor.loc?.end) {
      return this.sourceNodeHelper(undefined, value);
    }
    return this.keywordFrom(anchor.loc?.end, value);
  }

  private keywordFrom(
    from: { line: number; column: number } | undefined,
    value: string,
  ): SourceNode {
    const pos = from ? this.keywordLocator().findFrom(from, value) : undefined;
    return new SourceNode(
      pos?.line ?? null,
      pos?.column ?? null,
      this.fileName,
      value,
    );
  }

  /**
   * `if`/`while`/`do`/`for`/`function`を締める`end`キーワードの位置を返す。
   * これらの文は必ず`end`で終わり、末尾に余計な内容が続かないため、
   * 文全体の`loc.end`（luaparseが既に計算済み）から`end`の文字数(3)を
   * 引くだけで、再トークン化なしに正確な位置を求められる。
   */
  private endKeyword(node: Parser.Node): SourceNode {
    const end = node.loc?.end;
    return new SourceNode(
      end?.line ?? null,
      end == undefined ? null : end.column - 3,
      this.fileName,
      "end",
    );
  }

  private formatStatementList(body: GeneratedStatement[] | GeneratedStatement) {
    const result = this.sourceNodeHelper(undefined, []);
    const metadata = this.minifier.getSourceMetadata(this.moduleName);
    wrapArray(body).forEach((statement) => {
      const statementNode = this.sourceNodeHelper(undefined, []);
      const sourceStatement =
        statement.type === "ModuleSplice" ? undefined : statement;
      (sourceStatement ? metadata.beforeOf(sourceStatement) : [])
        .filter(isPreservedComment)
        .forEach((comment) => {
          statementNode.add([
            this.sourceNodeHelper(comment, comment.raw),
            "\n",
          ]);
        });
      statementNode.add(this.formatStatement(statement));
      (sourceStatement ? metadata.trailingOf(sourceStatement) : [])
        .filter(isPreservedComment)
        .forEach((comment) => {
          statementNode.add([
            this.requiredWhitespace,
            this.sourceNodeHelper(comment, comment.raw),
            "\n",
          ]);
        });
      addWithSeparator(result, statementNode, "\n");
    });
    return result;
  }

  /**
   * SLモード限定: `local x = require("m")` / `x = require("m")` の形（変数1個・
   * 初期化式1個）を、requireを式（IIFE）として埋め込むのではなく、モジュール本体の
   * 文をそのまま展開し最後にターゲットへ代入する「文」の並びとして出力する
   * （#29のレビュー対応。無オプション実行時の挙動互換性のため）。
   *
   * モジュール本体が「単一の式を返すreturn文」で終わっていない場合や、変数・
   * 初期化式が複数ある場合、-mモードの場合は対象外とし、undefinedを返す
   * （呼び出し側は従来のIIFE方式にフォールバックする）。
   */
  private trySpliceRequireStatement(
    statement: Parser.LocalStatement | Parser.AssignmentStatement,
  ): SourceNode | undefined {
    if (this.mode.requireWrapper) {
      return undefined;
    }
    if (statement.variables.length !== 1 || statement.init.length !== 1) {
      return undefined;
    }

    const moduleRef = this.matchModuleCallExpression(statement.init[0]);
    if (!moduleRef || moduleRef.kind !== "require") {
      return undefined;
    }

    const spliced = this.minifier.splitModuleForStatementSplice(
      moduleRef.moduleName,
    );
    if (!spliced) {
      return undefined;
    }

    const isLocal = statement.type === "LocalStatement";
    const target = statement.variables[0];
    const targetNode = isLocal
      ? this.generateIdentifier(target as Parser.Identifier)
      : this.formatExpression(target);

    const result = this.sourceNodeHelper(statement, []);
    addWithSeparator(result, spliced.statements);
    if (isLocal) {
      addWithSeparator(result, "local");
    }
    addWithSeparator(result, targetNode);
    addWithSeparator(result, "=");
    addWithSeparator(result, spliced.finalExpression);
    return result;
  }

  /**
   * SLモード限定: `require("m")` を戻り値を使わない単独の文として書いた場合、
   * dofileと同じくfunctionで包まずそのまま展開する（Cプリプロセッサのincludeに
   * 近い、LifeBoat Modeでの一般的な使い方に合わせるための対応。#29のレビュー対応）。
   */
  private tryInlineBareRequireStatement(
    expr:
      | Parser.CallExpression
      | Parser.StringCallExpression
      | Parser.TableCallExpression,
  ): SourceNode | undefined {
    if (this.mode.requireWrapper) {
      return undefined;
    }
    const moduleRef = this.matchModuleCallExpression(expr);
    if (!moduleRef || moduleRef.kind !== "require") {
      return undefined;
    }
    // 戻り値を使わないrequireでは、依存モジュール末尾のreturn式も不要になる。
    // return文ごと展開すると呼び出し元を途中でreturnし、後続文がある場合は
    // 構文上も不正になるため、分離可能なら副作用を持つ先行文だけを出力する。
    const spliced = this.minifier.splitModuleForStatementSplice(
      moduleRef.moduleName,
    );
    if (spliced) {
      return spliced.statements;
    }
    return this.minifier.printModuleInline(moduleRef.moduleName);
  }

  private formatStatement(statement: GeneratedStatement): SourceNode {
    if (statement.type === "ModuleSplice") {
      return this.minifier.printModuleInline(statement.moduleName);
    }
    if (
      statement.type == "AssignmentStatement" ||
      statement.type == "LocalStatement"
    ) {
      const spliced = this.trySpliceRequireStatement(statement);
      if (spliced) {
        return spliced;
      }
    }
    if (statement.type == "AssignmentStatement") {
      // left-hand side
      const variables = statement.variables
        .map((variable) => [this.formatExpression(variable), ","])
        .flat();
      const inits = statement.init
        .map((init) => [this.formatExpression(init), ","])
        .flat();

      const result = this.sourceNodeHelper(
        statement,
        this.sourceNodeHelper(undefined, variables.slice(0, -1)),
      );
      addWithSeparator(result, "=");
      addWithSeparator(
        result,
        this.sourceNodeHelper(undefined, inits.slice(0, -1)),
      );
      return result;
    } else if (statement.type == "LocalStatement") {
      const variables = statement.variables
        .map((variable) => [this.formatExpression(variable), ","])
        .flat();
      const result = this.sourceNodeHelper(statement, "local");
      addWithSeparator(
        result,
        this.sourceNodeHelper(undefined, variables.slice(0, -1)),
      );

      if (statement.init.length) {
        const inits = statement.init
          .map((init) => [this.formatExpression(init), ","])
          .flat();

        addWithSeparator(result, "=");
        addWithSeparator(
          result,
          this.sourceNodeHelper(undefined, inits.slice(0, -1)),
        );
      }
      return result;
    } else if (statement.type == "CallStatement") {
      const bareRequire = this.tryInlineBareRequireStatement(
        statement.expression,
      );
      if (bareRequire) {
        return bareRequire;
      }
      return this.formatExpression(statement.expression); // NOTE: もう一度囲んでもいい
    } else if (statement.type == "IfStatement") {
      const result = this.sourceNodeHelper(statement, []);
      statement.clauses.forEach((clause) => {
        const clauseMap = this.sourceNodeHelper(clause, []);
        if (clause.type == "IfClause") {
          addWithSeparator(clauseMap, "if");
          addWithSeparator(clauseMap, this.formatExpression(clause.condition));
          addWithSeparator(
            clauseMap,
            this.keywordAfter(clause.condition, "then"),
          );
        } else if (clause.type == "ElseifClause") {
          addWithSeparator(clauseMap, "elseif");
          addWithSeparator(clauseMap, this.formatExpression(clause.condition));
          addWithSeparator(
            clauseMap,
            this.keywordAfter(clause.condition, "then"),
          );
        } else {
          addWithSeparator(clauseMap, "else");
        }
        addWithSeparator(clauseMap, this.formatStatementList(clause.body));
        addWithSeparator(result, clauseMap);
      });
      addWithSeparator(result, this.endKeyword(statement));
      return result;
    } else if (statement.type == "WhileStatement") {
      const result = this.sourceNodeHelper(statement, "while");
      addWithSeparator(result, this.formatExpression(statement.condition));
      addWithSeparator(result, this.keywordAfter(statement.condition, "do"));
      addWithSeparator(result, this.formatStatementList(statement.body));
      addWithSeparator(result, this.endKeyword(statement));
      return result;
    } else if (statement.type == "DoStatement") {
      const result = this.sourceNodeHelper(statement, "do");
      addWithSeparator(result, this.formatStatementList(statement.body));
      addWithSeparator(result, this.endKeyword(statement));
      return result;
    } else if (statement.type == "ReturnStatement") {
      const result = this.sourceNodeHelper(statement, "return");
      if (statement.arguments.length) {
        const returns = statement.arguments
          .map((argument) => [this.formatExpression(argument), ","])
          .flat();
        addWithSeparator(result, returns.slice(0, -1));
      }
      return result;
    } else if (statement.type == "BreakStatement") {
      return this.sourceNodeHelper(statement, "break");
    } else if (statement.type == "RepeatStatement") {
      const result = this.sourceNodeHelper(statement, "repeat");
      addWithSeparator(result, this.formatStatementList(statement.body));
      // body内の最後の文があればその直後、無ければ`repeat`キーワード自身の
      // 開始位置から`until`を探す（bodyが空でも、その手前には`repeat`しか
      // 存在しないため安全に検索できる）。
      const untilAnchor = statement.body.length
        ? statement.body[statement.body.length - 1].loc?.end
        : statement.loc?.start;
      addWithSeparator(result, this.keywordFrom(untilAnchor, "until"));
      addWithSeparator(result, this.formatExpression(statement.condition));
      return result;
    } else if (statement.type == "FunctionDeclaration") {
      const result = this.sourceNodeHelper(
        statement,
        statement.isLocal ? "local" : "function",
      );
      if (statement.isLocal) {
        addWithSeparator(result, "function");
      }
      if (statement.identifier) {
        addWithSeparator(result, this.formatExpression(statement.identifier));
      }
      addWithSeparator(result, "(");

      if (statement.parameters.length) {
        const parameters = statement.parameters
          .map((parameter) => {
            return [
              parameter.type == "Identifier"
                ? this.generateIdentifier(parameter)
                : parameter.value,
              ",",
            ];
          })
          .flat();
        addWithSeparator(result, parameters.slice(0, -1));
      }

      addWithSeparator(result, ")");
      addWithSeparator(result, this.formatStatementList(statement.body));
      addWithSeparator(result, this.endKeyword(statement));
      return result;
    } else if (statement.type == "ForGenericStatement") {
      // see also `ForNumericStatement`
      const result = this.sourceNodeHelper(statement, "for");
      const variables = statement.variables
        .map((variable) => [this.generateIdentifier(variable), ","])
        .flat();
      const iterators = statement.iterators
        .map((iterator) => [this.formatExpression(iterator), ","])
        .flat();
      addWithSeparator(result, variables.slice(0, -1));
      addWithSeparator(result, "in");
      addWithSeparator(result, iterators.slice(0, -1));
      addWithSeparator(
        result,
        this.keywordAfter(
          statement.iterators[statement.iterators.length - 1],
          "do",
        ),
      );
      addWithSeparator(result, this.formatStatementList(statement.body));
      addWithSeparator(result, this.endKeyword(statement));
      return result;
    } else if (statement.type == "ForNumericStatement") {
      // The variables in a `ForNumericStatement` are always local
      const result = this.sourceNodeHelper(statement, "for");
      addWithSeparator(result, this.generateIdentifier(statement.variable));
      addWithSeparator(result, "=");
      addWithSeparator(result, this.formatExpression(statement.start));
      addWithSeparator(result, ",");
      addWithSeparator(result, this.formatExpression(statement.end));

      if (statement.step) {
        addWithSeparator(result, ",");
        addWithSeparator(result, this.formatExpression(statement.step));
      }

      addWithSeparator(
        result,
        this.keywordAfter(statement.step ?? statement.end, "do"),
      );
      addWithSeparator(result, this.formatStatementList(statement.body));
      addWithSeparator(result, this.endKeyword(statement));
      return result;
    } else if (statement.type == "LabelStatement") {
      // The identifier names in a `LabelStatement` can safely be renamed
      return this.sourceNodeHelper(statement, [
        "::",
        this.generateIdentifier(statement.label),
        "::",
      ]);
    } else if (statement.type == "GotoStatement") {
      // The identifier names in a `GotoStatement` can safely be renamed
      const result = this.sourceNodeHelper(statement, "goto");
      addWithSeparator(result, this.generateIdentifier(statement.label));
      return result;
    } else {
      throw TypeError(
        "Unknown statement type: `" + JSON.stringify(statement) + "`",
      );
    }
  }

  /*function joinStatements(a: string | SourceNode, b: string | SourceNode, separator = " ") {
    return isNeedSeparator(a.toString(), b.toString()) ? a.toString() + separator + b.toString() : a.toString() + b.toString();
}*/

  private formatExpression(
    expression: Parser.Expression,
    argOptions?: ExpressionOptoions,
  ): SourceNode {
    if (expression.type == "Identifier") {
      return this.generateIdentifier(expression);
    } else if (expression.type == "StringLiteral") {
      const fieldRename = this.minifier.getFieldRename(expression);
      return fieldRename
        ? this.sourceNodeHelper(
            expression,
            JSON.stringify(fieldRename.name),
            fieldRename.originalName,
          )
        : this.sourceNodeHelper(expression, expression.raw);
    } else if (
      expression.type == "NumericLiteral" ||
      expression.type == "BooleanLiteral" ||
      expression.type == "NilLiteral" ||
      expression.type == "VarargLiteral"
    ) {
      return this.sourceNodeHelper(expression, expression.raw);
    } else if (
      expression.type == "LogicalExpression" ||
      expression.type == "BinaryExpression"
    ) {
      const operator = expression.operator;
      const currentPrecedence = PRECEDENCE[operator];
      let associativity: "left" | "right" = "left";
      const options = {
        precedence: 0,
        preserveIdentifiers: false,
        ...argOptions,
      };

      const leftHand = this.formatExpression(expression.left, {
        precedence: currentPrecedence,
        direction: "left",
        parent: operator,
      });
      const rightHand = this.formatExpression(expression.right, {
        precedence: currentPrecedence,
        direction: "right",
        parent: operator,
      });
      if (operator == "^" || operator == "..") {
        associativity = "right";
      }
      // 上のif（結合則の決定）とは独立に判定する必要がある。else ifだと`^`と`..`が
      // ここに来ず、優先順位の高い演算子の中に現れても丸括弧が付かなくなる
      // （#52。例: `0.5 % (2 .. 16)`が`0.5%2 ..16`になり、`%`の方が優先順位が
      // 高いため意味の違うコードとして読み直されてしまっていた）。
      if (
        currentPrecedence < options.precedence ||
        (currentPrecedence == options.precedence &&
          associativity != options.direction &&
          options.parent != "+" &&
          !(options.parent == "*" && (operator == "/" || operator == "*")))
      ) {
        return this.sourceNodeHelper(
          expression,
          [
            "(",
            leftHand,
            insertSeparator(leftHand, operator),
            operator,
            insertSeparator(operator, rightHand),
            rightHand,
            ")",
          ].filter((p): p is Exclude<typeof p, undefined> => p !== undefined),
        );
      }
      return this.sourceNodeHelper(
        expression,
        [
          leftHand,
          insertSeparator(leftHand, operator),
          operator,
          insertSeparator(operator, rightHand),
          rightHand,
        ].filter((p): p is Exclude<typeof p, undefined> => p !== undefined),
      );
    } else if (expression.type == "UnaryExpression") {
      const operator = expression.operator;
      const currentPrecedence = PRECEDENCE["unary" + operator];
      const options = {
        precedence: 0,
        ...argOptions,
      };

      const p2 = this.formatExpression(expression.argument, {
        precedence: currentPrecedence,
      });
      const result = this.sourceNodeHelper(
        expression,
        [operator, insertSeparator(operator, p2), p2].filter(
          (p): p is Exclude<typeof p, undefined> => p !== undefined,
        ),
      );

      if (
        currentPrecedence < options.precedence &&
        // In principle, we should parenthesize the RHS of an
        // expression like `3^-2`, because `^` has higher precedence
        // than unary `-` according to the manual. But that is
        // misleading on the RHS of `^`, since the parser will
        // always try to find a unary operator regardless of
        // precedence.
        !(options.parent == "^" && options.direction == "right")
      ) {
        result.prepend("(");
        result.add(")");
      }
      return result;
    } else if (expression.type == "CallExpression") {
      const moduleRef = this.matchModuleCallExpression(expression);
      if (moduleRef) {
        const replacement = this.formatModuleReference(expression, moduleRef);
        if (replacement) {
          return replacement;
        }
      }
      const args = expression.arguments
        .map((arg) => [this.formatExpression(arg), ","])
        .flat();
      return this.sourceNodeHelper(expression, [
        this.formatBase(expression.base),
        "(",
        this.sourceNodeHelper(undefined, args.slice(0, -1)),
        ")",
      ]);
    } else if (expression.type == "TableCallExpression") {
      return this.sourceNodeHelper(expression, [
        this.formatExpression(expression.base),
        this.formatExpression(expression.arguments),
      ]);
    } else if (expression.type == "StringCallExpression") {
      const moduleRef = this.matchModuleCallExpression(expression);
      if (moduleRef) {
        const replacement = this.formatModuleReference(expression, moduleRef);
        if (replacement) {
          return replacement;
        }
      }
      return this.sourceNodeHelper(expression, [
        this.formatExpression(expression.base),
        this.formatExpression(expression.argument),
      ]);
    } else if (expression.type == "IndexExpression") {
      return this.sourceNodeHelper(expression, [
        this.formatBase(expression.base),
        "[",
        this.formatExpression(expression.index),
        "]",
      ]);
    } else if (expression.type == "MemberExpression") {
      const fieldRename = this.minifier.getFieldRename(expression.identifier);
      return this.sourceNodeHelper(expression, [
        this.formatBase(expression.base),
        expression.indexer,
        fieldRename
          ? this.sourceNodeHelper(
              expression.identifier,
              fieldRename.name,
              fieldRename.originalName,
            )
          : this.formatExpression(expression.identifier, {
              preserveIdentifiers: true,
            }),
      ]);
    } else if (expression.type == "FunctionDeclaration") {
      const result = this.sourceNodeHelper(expression, ["function", "("]);

      if (expression.parameters.length) {
        const parameters = expression.parameters
          .map((parameter) => {
            return [
              this.sourceNodeHelper(
                parameter,
                parameter.type === "Identifier"
                  ? this.generateIdentifier(parameter)
                  : parameter.value,
              ),
              ",",
            ];
          })
          .flat();
        addWithSeparator(result, parameters.slice(0, -1));
      }
      result.add(")");
      const body = this.formatStatementList(expression.body);
      addWithSeparator(result, body);
      addWithSeparator(result, this.endKeyword(expression));
      return result;
    } else if (expression.type == "TableConstructorExpression") {
      const result = this.sourceNodeHelper(expression, "{");
      const fields = expression.fields
        .map((field, ix, ar) => {
          // Stormworks "propert" Trailing Comma: https://nona-takahara.github.io/blog/entry11.html
          const comma =
            ix !== ar.length - 1 ||
            this.formatExpression(field.value).toString().includes("property")
              ? ","
              : undefined;

          if (field.type == "TableKey") {
            return this.sourceNodeHelper(
              field,
              [
                this.sourceNodeHelper(undefined, [
                  "[",
                  this.formatExpression(field.key),
                  "]",
                ]),
                "=",
                this.formatExpression(field.value),
                comma,
              ].filter(
                (p): p is Exclude<typeof p, undefined> => p !== undefined,
              ),
            );
          } else if (field.type == "TableValue") {
            return [this.formatExpression(field.value), comma].filter(
              (p): p is Exclude<typeof p, undefined> => p !== undefined,
            );
          } else {
            // at this point, `field.type == 'TableKeyString'`
            // TODO: keep track of nested scopes (#18)
            const fieldRename = this.minifier.getFieldRename(field.key);
            return this.sourceNodeHelper(
              field,
              [
                fieldRename
                  ? this.sourceNodeHelper(
                      field.key,
                      fieldRename.name,
                      fieldRename.originalName,
                    )
                  : this.formatExpression(field.key, {
                      preserveIdentifiers: true,
                    }),
                "=",
                this.formatExpression(field.value),
                comma,
              ].filter(
                (p): p is Exclude<typeof p, undefined> => p !== undefined,
              ),
            );
          }
        })
        .flat();
      addWithSeparator(result, fields);
      addWithSeparator(result, "}");
      return result;
    } else {
      throw TypeError(
        "Unknown expression type: `" + JSON.stringify(expression) + "`",
      );
    }
  }

  /**
   * インデックス・メンバー参照・呼び出しの基底を出力する。
   *
   * Luaの文法で基底にそのまま置けるのは、変数・インデックス式・関数呼び出しだけで
   * ある。それ以外の式は丸括弧で包まないと基底に置けない（`3 .x` も `"a":upper()`
   * も構文エラーになる）。そのため、包む必要のある型を数え上げるのではなく、
   * そのまま置ける形かどうかだけを見る。式の種類が増えても、元のソースには現れない
   * 式を基底へ置く変換（定数畳み込みなど）が入っても、この判定だけで正しい括弧が付く。
   */
  private formatBase(base: Parser.Expression): SourceNode {
    const type = base.type;
    const canStandAsBase =
      type == "Identifier" ||
      type == "MemberExpression" ||
      type == "IndexExpression" ||
      type == "CallExpression" ||
      type == "StringCallExpression" ||
      type == "TableCallExpression";
    const result = this.sourceNodeHelper(base, this.formatExpression(base));
    if (!canStandAsBase) {
      prependWithSeparator(result, "(");
      addWithSeparator(result, ")");
    }
    return result;
  }

  // require/dofileへの静的な呼び出しを検出する。実際のモジュール解決はLinkパス
  // （Minifier.link）が事前に済ませているため、ここでは呼び出し形が
  // require/dofile への静的文字列呼び出しかどうかを判定するだけでよい（#18）。
  private matchModuleCall(
    base: Parser.Expression,
    argument: Parser.Expression | undefined,
  ): { kind: "require" | "dofile"; moduleName: string } | undefined {
    if (base.type !== "Identifier") {
      return undefined;
    }
    if (base.name !== "require" && base.name !== "dofile") {
      return undefined;
    }
    const moduleName = staticStringArgument(argument);
    if (moduleName === undefined) {
      return undefined;
    }
    return { kind: base.name, moduleName };
  }

  // CallExpression / StringCallExpression のどちらの構文でも呼べるmatchModuleCall
  private matchModuleCallExpression(
    expr: Parser.Expression,
  ): { kind: "require" | "dofile"; moduleName: string } | undefined {
    if (expr.type === "CallExpression") {
      return this.matchModuleCall(expr.base, expr.arguments[0]);
    }
    if (expr.type === "StringCallExpression") {
      return this.matchModuleCall(expr.base, expr.argument);
    }
    return undefined;
  }

  private formatModuleReference(
    expression: Parser.Expression,
    ref: { kind: "require" | "dofile"; moduleName: string },
  ): SourceNode | undefined {
    if (ref.kind === "dofile") {
      // dofileは呼び出しごとに毎回展開しなおす（キャッシュしない）
      return this.minifier.printModuleInline(ref.moduleName);
    }

    if (!this.mode.requireWrapper) {
      // SLモード（無オプション）: requireもキャッシュせずその場展開する
      // （挙動互換性のため、ホイストした共有ローカルへの参照にはしない）。
      // 式の位置に置けるようにIIFEで包む。
      const body = this.minifier.printModuleInline(ref.moduleName);
      const result = this.sourceNodeHelper(expression, "(function()");
      addWithSeparator(result, body);
      addWithSeparator(result, "end");
      result.add(")()");
      return result;
    }

    // -mモードのrequireはそのまま呼び出しとして出力し、実行時のrequire関数に委ねる
    return undefined;
  }

  // Renameパス（#20）が解決済みシンボルテーブルをもとに割り当てた短縮名を参照する。
  // 対応するローカルシンボルが無い場合（グローバル参照や"self"）は元の名前のまま出力する。
  private generateIdentifier(nameItem: Parser.Identifier): SourceNode {
    const renamed = this.minifier
      .getRenameResult(this.moduleName)
      .nameOf(nameItem);
    // #8bのエイリアス化はノードの`.name`自体を書き換えるため、loc（元のソース上の
    // 位置）はそのままでもnameItem.nameはもう元の識別子名ではない。Source Mapの
    // namesフィールドには常に「元のソースで書かれていた名前」を載せる必要がある。
    const originalName = originalNameOf(nameItem) ?? nameItem.name;
    return this.sourceNodeHelper(
      nameItem,
      renamed ?? nameItem.name,
      originalName,
    );
  }
}
