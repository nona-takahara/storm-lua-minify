// based on "luamin": Copyright Mathias Bynens <https://mathiasbynens.be/>
// SPDX-License-Identifier: MIT

/* eslint-disable @typescript-eslint/no-unnecessary-condition */
import Parser, { Comment } from "luaparse";
import { SourceNode } from "source-map";
import { Minifier, MinifierMode } from "./minifier";
import { staticStringArgument } from "./linker";

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
    } else {
      // e.g. `not` + `(2>3 or 3<2)`
      // e.g. `x` + `^`
      return false;
    }
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

function addWithSeparator(
  val: SourceNode,
  adding: (string | SourceNode)[] | SourceNode | string,
  separator = " ",
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
  separator = " ",
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
  separator = " ",
) {
  return isNeedSeparator(a.toString(), b.toString()) ? separator : undefined;
}

export class MinifyFile {
  private fileName: string;
  private ast: Chunk;
  private minifier: Minifier;
  private mode: MinifierMode;

  constructor(
    fileName: string,
    ast: Chunk,
    minifier: Minifier,
    mode: MinifierMode,
  ) {
    this.fileName = fileName;
    this.ast = ast;
    this.minifier = minifier;
    this.mode = mode;
  }

  parse(noComment: boolean) {
    const body = this.formatStatementList(this.ast.body);
    if (!noComment && this.ast.comments) {
      const comments = this.ast.comments;
      comments
        .reverse()
        .filter((v) => v.raw.includes("--#") || v.raw.includes("[[#"))
        .forEach((comment) => {
          body.prepend([this.sourceNodeHelper(comment, comment.raw), "\n"]);
        });
      return body;
    } else {
      return body;
    }
  }

  /**
   * モジュール本体の最後の文が「単一の式を返すreturn文」であるときに限り、
   * それ以外の文と最後の式を分けて返す。requireを式（IIFE）ではなく文として
   * 展開したい呼び出し側（#29のレビュー対応）が利用する。
   * 該当しない場合はundefinedを返し、呼び出し側はIIFE方式へフォールバックする。
   */
  parseAsStatementsAndFinalExpression(
    noComment: boolean,
  ): { statements: SourceNode; finalExpression: SourceNode } | undefined {
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
    if (!noComment && this.ast.comments) {
      this.ast.comments
        .slice()
        .reverse()
        .filter((v) => v.raw.includes("--#") || v.raw.includes("[[#"))
        .forEach((comment) => {
          statements.prepend([
            this.sourceNodeHelper(comment, comment.raw),
            "\n",
          ]);
        });
    }

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
    return new SourceNode(
      line == undefined ? null : line,
      column == undefined ? null : column,
      this.fileName, // 本当に自分のファイル名でよいかは要検討
      chuncks,
      name,
    );
  }

  private formatStatementList(body: Parser.Statement[] | Parser.Statement) {
    const result = this.sourceNodeHelper(undefined, []);
    wrapArray(body).forEach((statement) => {
      addWithSeparator(result, this.formatStatement(statement), "\n");
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
    if (this.mode.moduleLikeLua) {
      return undefined;
    }
    if (statement.variables.length !== 1 || statement.init.length !== 1) {
      return undefined;
    }

    const initExpr = statement.init[0];
    let base: Parser.Expression;
    let argument: Parser.Expression | undefined;
    if (initExpr.type === "CallExpression") {
      base = initExpr.base;
      argument = initExpr.arguments[0];
    } else if (initExpr.type === "StringCallExpression") {
      base = initExpr.base;
      argument = initExpr.argument;
    } else {
      return undefined;
    }

    const moduleRef = this.matchModuleCall(base, argument);
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
    addWithSeparator(result, isLocal ? ["local ", targetNode] : [targetNode]);
    addWithSeparator(result, "=");
    addWithSeparator(result, spliced.finalExpression);
    return result;
  }

  private formatStatement(statement: Parser.Statement): SourceNode {
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
      const result = this.sourceNodeHelper(statement, [
        "local ",
        this.sourceNodeHelper(undefined, variables.slice(0, -1)),
      ]);

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
      return this.formatExpression(statement.expression); // NOTE: もう一度囲んでもいい
    } else if (statement.type == "IfStatement") {
      const result = this.sourceNodeHelper(statement, []);
      statement.clauses.forEach((clause) => {
        const clauseMap = this.sourceNodeHelper(clause, []);
        if (clause.type == "IfClause") {
          addWithSeparator(clauseMap, "if");
          addWithSeparator(clauseMap, this.formatExpression(clause.condition));
          addWithSeparator(clauseMap, "then");
        } else if (clause.type == "ElseifClause") {
          addWithSeparator(clauseMap, "elseif");
          addWithSeparator(clauseMap, this.formatExpression(clause.condition));
          addWithSeparator(clauseMap, "then");
        } else {
          addWithSeparator(clauseMap, "else");
        }
        addWithSeparator(clauseMap, this.formatStatementList(clause.body));
        addWithSeparator(result, clauseMap);
      });
      addWithSeparator(result, "end");
      return result;
    } else if (statement.type == "WhileStatement") {
      const result = this.sourceNodeHelper(statement, "while");
      addWithSeparator(result, this.formatExpression(statement.condition));
      addWithSeparator(result, "do");
      addWithSeparator(result, this.formatStatementList(statement.body));
      addWithSeparator(result, "end");
      return result;
    } else if (statement.type == "DoStatement") {
      const result = this.sourceNodeHelper(statement, "do");
      addWithSeparator(result, this.formatStatementList(statement.body));
      addWithSeparator(result, "end");
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
      addWithSeparator(result, "until");
      addWithSeparator(result, this.formatExpression(statement.condition));
      return result;
    } else if (statement.type == "FunctionDeclaration") {
      const result = this.sourceNodeHelper(
        statement,
        (statement.isLocal ? "local " : "") + "function ",
      );
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
      addWithSeparator(result, "end");
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
      addWithSeparator(result, "do");
      addWithSeparator(result, this.formatStatementList(statement.body));
      addWithSeparator(result, "end");
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

      addWithSeparator(result, "do");
      addWithSeparator(result, this.formatStatementList(statement.body));
      addWithSeparator(result, "end");
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
      return this.sourceNodeHelper(statement, [
        "goto ",
        this.generateIdentifier(statement.label),
      ]);
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
      return this.sourceNodeHelper(
        expression,
        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
        //@ts-ignore
        expression.isLocal
          ? this.generateIdentifier(expression, true)
          : expression.name,
        expression.name,
      );
    } else if (
      expression.type == "StringLiteral" ||
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
      } else if (
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
      const moduleRef = this.matchModuleCall(
        expression.base,
        expression.arguments[0],
      );
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
      const moduleRef = this.matchModuleCall(
        expression.base,
        expression.argument,
      );
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
      return this.sourceNodeHelper(expression, [
        this.formatBase(expression.base),
        expression.indexer,
        this.formatExpression(expression.identifier, {
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
      addWithSeparator(result, "end");
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
            return this.sourceNodeHelper(
              field,
              [
                this.formatExpression(field.key, { preserveIdentifiers: true }),
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

  private formatBase(base: Parser.Expression): SourceNode {
    const type = base.type;
    const needsParens =
      type == "CallExpression" ||
      type == "BinaryExpression" ||
      type == "FunctionDeclaration" ||
      type == "TableConstructorExpression" ||
      type == "LogicalExpression" ||
      type == "StringLiteral";
    const result = this.sourceNodeHelper(base, this.formatExpression(base));
    if (needsParens) {
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

  private formatModuleReference(
    expression: Parser.Expression,
    ref: { kind: "require" | "dofile"; moduleName: string },
  ): SourceNode | undefined {
    if (ref.kind === "dofile") {
      // dofileは呼び出しごとに毎回展開しなおす（キャッシュしない）
      return this.minifier.printModuleInline(ref.moduleName);
    }

    if (!this.mode.moduleLikeLua) {
      // SLモード（無オプション）: requireもキャッシュせずその場展開する
      // （挙動互換性のため、ホイストした共有ローカルへの参照にはしない）。
      // 式の位置に置けるようにIIFEで包む。
      const body = this.minifier.printModuleInline(ref.moduleName);
      return this.sourceNodeHelper(expression, [
        "(function() ",
        body,
        " end)()",
      ]);
    }

    // -mモードのrequireはそのまま呼び出しとして出力し、実行時のrequire関数に委ねる
    return undefined;
  }

  private generateIdentifier(
    nameItem: Parser.Identifier,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- #19/#20で対応予定のネストスコープ追跡用に予約
    nested = false,
  ): SourceNode {
    if (nameItem.name === "self") {
      return this.sourceNodeHelper(nameItem, "self", "self");
    }

    const id = this.minifier.allocateIdentifier(nameItem.name);
    return this.sourceNodeHelper(nameItem, id, nameItem.name);
  }
}
