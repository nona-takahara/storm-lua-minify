import Parser from "luaparse";
import { ResolveResult, Symbol } from "./resolver";

export interface FreshTable {
  readonly symbol: Symbol;
  readonly declaration: Parser.LocalStatement;
  readonly constructor: Parser.TableConstructorExpression;
  readonly functionDepth: number;
}

export interface TableEffect {
  readonly access: "read" | "write";
  readonly table: FreshTable;
  // undefinedは動的keyまたは安全にdecodeできない文字列literal。
  readonly staticKey: string | undefined;
  readonly expression: Parser.MemberExpression | Parser.IndexExpression;
  readonly owner: Parser.Statement;
}

export type TableEscapeReason =
  "alias" | "call" | "return" | "store" | "capture" | "value-use";

export interface TableEscape {
  readonly table: FreshTable;
  readonly reason: TableEscapeReason;
  readonly identifier: Parser.Identifier;
  readonly owner: Parser.Statement;
}

export interface TableEffectAnalysis {
  readonly freshTables: readonly FreshTable[];
  readonly effects: readonly TableEffect[];
  readonly escapes: readonly TableEscape[];
  isNonescaping(table: FreshTable): boolean;
  effectsOf(table: FreshTable): readonly TableEffect[];
}

type ValueUse = "value-use" | "alias" | "call" | "return" | "store";

/** fresh local tableに対する構文事実を収集する。ASTは変更しない。 */
export function analyzeTableEffects(
  chunk: Parser.Chunk,
  resolved: ResolveResult,
): TableEffectAnalysis {
  const freshTables: FreshTable[] = [];
  const freshBySymbol = new Map<Symbol, FreshTable>();
  const effects: TableEffect[] = [];
  const escapes: TableEscape[] = [];

  analyzeBlock(chunk.body, 0);

  function escapeIdentifier(
    identifier: Parser.Identifier,
    use: ValueUse,
    owner: Parser.Statement,
    functionDepth: number,
  ): void {
    const symbol = resolved.symbolOf(identifier);
    const table = symbol ? freshBySymbol.get(symbol) : undefined;
    if (!table) return;
    escapes.push({
      table,
      reason: functionDepth > table.functionDepth ? "capture" : use,
      identifier,
      owner,
    });
  }

  function analyzeExpression(
    expression: Parser.Expression,
    owner: Parser.Statement,
    use: ValueUse,
    functionDepth: number,
  ): void {
    switch (expression.type) {
      case "Identifier":
        escapeIdentifier(expression, use, owner, functionDepth);
        return;
      case "StringLiteral":
      case "NumericLiteral":
      case "BooleanLiteral":
      case "NilLiteral":
      case "VarargLiteral":
        return;
      case "LogicalExpression":
      case "BinaryExpression":
        analyzeExpression(expression.left, owner, "value-use", functionDepth);
        analyzeExpression(expression.right, owner, "value-use", functionDepth);
        return;
      case "UnaryExpression":
        analyzeExpression(
          expression.argument,
          owner,
          "value-use",
          functionDepth,
        );
        return;
      case "MemberExpression":
      case "IndexExpression":
        analyzeTableAccess(expression, "read", owner, functionDepth);
        return;
      case "CallExpression":
        analyzeCallParts(
          expression.base,
          expression.arguments,
          owner,
          functionDepth,
        );
        return;
      case "TableCallExpression":
        analyzeCallParts(
          expression.base,
          [expression.arguments],
          owner,
          functionDepth,
        );
        return;
      case "StringCallExpression":
        analyzeCallParts(
          expression.base,
          [expression.argument],
          owner,
          functionDepth,
        );
        return;
      case "FunctionDeclaration":
        analyzeBlock(expression.body, functionDepth + 1);
        return;
      case "TableConstructorExpression":
        expression.fields.forEach((field) => {
          if (field.type === "TableKey") {
            analyzeExpression(field.key, owner, "value-use", functionDepth);
          }
          analyzeExpression(field.value, owner, "store", functionDepth);
        });
        return;
      default: {
        const exhaustive: never = expression;
        throw new TypeError(
          "Unknown expression type: `" + JSON.stringify(exhaustive) + "`",
        );
      }
    }
  }

  function analyzeCallParts(
    base: Parser.Expression,
    args: Parser.Expression[],
    owner: Parser.Statement,
    functionDepth: number,
  ): void {
    analyzeExpression(base, owner, "call", functionDepth);
    args.forEach((argument) => {
      analyzeExpression(argument, owner, "call", functionDepth);
    });
    if (base.type === "MemberExpression" && base.indexer === ":") {
      const table = tableOfBase(base.base);
      if (table && base.base.type === "Identifier") {
        escapeIdentifier(base.base, "call", owner, functionDepth);
      }
    }
  }

  function analyzeTableAccess(
    expression: Parser.MemberExpression | Parser.IndexExpression,
    access: TableEffect["access"],
    owner: Parser.Statement,
    functionDepth: number,
  ): void {
    const table = tableOfBase(expression.base);
    if (table) {
      effects.push({
        access,
        table,
        staticKey: staticKeyOf(expression),
        expression,
        owner,
      });
      if (
        functionDepth > table.functionDepth &&
        expression.base.type === "Identifier"
      ) {
        escapeIdentifier(expression.base, "value-use", owner, functionDepth);
      }
    } else {
      analyzeExpression(expression.base, owner, "value-use", functionDepth);
    }
    if (expression.type === "IndexExpression") {
      analyzeExpression(expression.index, owner, "value-use", functionDepth);
    }
  }

  function tableOfBase(base: Parser.Expression): FreshTable | undefined {
    if (base.type !== "Identifier") return undefined;
    const symbol = resolved.symbolOf(base);
    return symbol ? freshBySymbol.get(symbol) : undefined;
  }

  function analyzeStatement(
    statement: Parser.Statement,
    functionDepth: number,
  ): void {
    switch (statement.type) {
      case "LocalStatement":
        if (
          statement.variables.length === 1 &&
          statement.init.length === 1 &&
          statement.init[0].type === "TableConstructorExpression"
        ) {
          const symbol = resolved.symbolOf(statement.variables[0]);
          if (symbol?.kind === "local") {
            const table: FreshTable = {
              symbol,
              declaration: statement,
              constructor: statement.init[0],
              functionDepth,
            };
            freshTables.push(table);
            freshBySymbol.set(symbol, table);
          }
        }
        statement.init.forEach((expression) => {
          analyzeExpression(expression, statement, "alias", functionDepth);
        });
        return;
      case "AssignmentStatement":
        statement.init.forEach((expression) => {
          analyzeExpression(expression, statement, "store", functionDepth);
        });
        statement.variables.forEach((variable) => {
          if (
            variable.type === "MemberExpression" ||
            variable.type === "IndexExpression"
          ) {
            analyzeTableAccess(variable, "write", statement, functionDepth);
          }
        });
        return;
      case "CallStatement":
        analyzeExpression(
          statement.expression,
          statement,
          "call",
          functionDepth,
        );
        return;
      case "DoStatement":
        analyzeBlock(statement.body, functionDepth);
        return;
      case "WhileStatement":
        analyzeExpression(
          statement.condition,
          statement,
          "value-use",
          functionDepth,
        );
        analyzeBlock(statement.body, functionDepth);
        return;
      case "RepeatStatement":
        analyzeBlock(statement.body, functionDepth);
        analyzeExpression(
          statement.condition,
          statement,
          "value-use",
          functionDepth,
        );
        return;
      case "IfStatement":
        statement.clauses.forEach((clause) => {
          if (clause.type !== "ElseClause") {
            analyzeExpression(
              clause.condition,
              statement,
              "value-use",
              functionDepth,
            );
          }
          analyzeBlock(clause.body, functionDepth);
        });
        return;
      case "ForNumericStatement":
        analyzeExpression(
          statement.start,
          statement,
          "value-use",
          functionDepth,
        );
        analyzeExpression(statement.end, statement, "value-use", functionDepth);
        if (statement.step) {
          analyzeExpression(
            statement.step,
            statement,
            "value-use",
            functionDepth,
          );
        }
        analyzeBlock(statement.body, functionDepth);
        return;
      case "ForGenericStatement":
        statement.iterators.forEach((iterator) => {
          analyzeExpression(iterator, statement, "value-use", functionDepth);
        });
        analyzeBlock(statement.body, functionDepth);
        return;
      case "FunctionDeclaration":
        if (
          statement.identifier &&
          statement.identifier.type !== "Identifier"
        ) {
          analyzeTableAccess(
            statement.identifier,
            "write",
            statement,
            functionDepth,
          );
        }
        analyzeBlock(statement.body, functionDepth + 1);
        return;
      case "ReturnStatement":
        statement.arguments.forEach((argument) => {
          analyzeExpression(argument, statement, "return", functionDepth);
        });
        return;
      case "BreakStatement":
      case "LabelStatement":
      case "GotoStatement":
        return;
      default: {
        const exhaustive: never = statement;
        throw new TypeError(
          "Unknown statement type: `" + JSON.stringify(exhaustive) + "`",
        );
      }
    }
  }

  function analyzeBlock(body: Parser.Statement[], functionDepth: number): void {
    body.forEach((statement) => {
      analyzeStatement(statement, functionDepth);
    });
  }

  return {
    freshTables,
    effects,
    escapes,
    isNonescaping: (table) => !escapes.some((escape) => escape.table === table),
    effectsOf: (table) => effects.filter((effect) => effect.table === table),
  };
}

export function staticKeyOf(
  expression: Parser.MemberExpression | Parser.IndexExpression,
): string | undefined {
  if (expression.type === "MemberExpression") return expression.identifier.name;
  if (expression.index.type !== "StringLiteral") return undefined;
  const raw = expression.index.raw;
  if (raw.length < 2 || raw.includes("\\")) return undefined;
  const quote = raw[0];
  if ((quote !== '"' && quote !== "'") || raw[raw.length - 1] !== quote) {
    return undefined;
  }
  return raw.slice(1, -1);
}
