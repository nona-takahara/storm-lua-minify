import Parser from "luaparse";
import { ResolveResult } from "./resolver";
import { SourceMetadata } from "./sourceMetadata";

function rangeOf(node: object): [number, number] | undefined {
  return (node as { range?: [number, number] }).range;
}

function nestedBodies(statement: Parser.Statement): Parser.Statement[][] {
  switch (statement.type) {
    case "DoStatement":
    case "WhileStatement":
    case "RepeatStatement":
    case "FunctionDeclaration":
    case "ForNumericStatement":
    case "ForGenericStatement":
      return [statement.body];
    case "IfStatement":
      return statement.clauses.map((clause) => clause.body);
    default:
      return [];
  }
}

/**
 * 初期値ごと捨ててよい式か。基準は「評価しても何も起きないこと」で、値が
 * その場で決まっていて、実行時のエラーもメタメソッドの呼び出しも起こさない
 * 式だけが当たる。
 *
 * 負の数値定数は、Luaの構文では数値リテラルではなく単項マイナスの式になる。
 * `-5` と `5` は同じだけ何も起こさないので、同じ扱いにする。単項マイナスを
 * 数値リテラル以外へ適用した形（`-"abc"` など）は実行時エラーになりうるので
 * 含めない。エラーを消してはならない。
 */
function isDiscardableInitializer(expression: Parser.Expression): boolean {
  switch (expression.type) {
    case "NilLiteral":
    case "BooleanLiteral":
    case "NumericLiteral":
    case "StringLiteral":
    case "FunctionDeclaration":
      return true;
    case "UnaryExpression":
      return (
        expression.operator === "-" &&
        expression.argument.type === "NumericLiteral"
      );
    default:
      return false;
  }
}

function isStatementCall(
  expression: Parser.Expression,
): expression is
  | Parser.CallExpression
  | Parser.TableCallExpression
  | Parser.StringCallExpression {
  return (
    expression.type === "CallExpression" ||
    expression.type === "TableCallExpression" ||
    expression.type === "StringCallExpression"
  );
}

function callStatement(
  expression:
    | Parser.CallExpression
    | Parser.TableCallExpression
    | Parser.StringCallExpression,
): Parser.CallStatement {
  return {
    type: "CallStatement",
    expression,
    loc: expression.loc,
    range: rangeOf(expression),
  } as Parser.CallStatement;
}

function hasExternalReference(
  statement: Parser.FunctionDeclaration,
  references: readonly Parser.Identifier[],
): boolean {
  const range = rangeOf(statement);
  if (!range) return references.length > 0;
  return references.some((reference) => {
    const position = rangeOf(reference)?.[0];
    return (
      position === undefined || position < range[0] || position >= range[1]
    );
  });
}

function removeFromBlock(
  body: Parser.Statement[],
  resolved: ResolveResult,
  metadata: SourceMetadata,
): boolean {
  let changed = false;
  body.forEach((statement) => {
    nestedBodies(statement).forEach((nested) => {
      changed = removeFromBlock(nested, resolved, metadata) || changed;
    });
  });

  const replacements = new Map<Parser.Statement, Parser.Statement[]>();
  body.forEach((statement) => {
    if (metadata.annotationsOf(statement).keep) return;
    if (
      statement.type === "FunctionDeclaration" &&
      statement.isLocal &&
      statement.identifier?.type === "Identifier"
    ) {
      const symbol = resolved.symbolOf(statement.identifier);
      if (symbol && !hasExternalReference(statement, symbol.references)) {
        changed = true;
        replacements.set(statement, []);
        return;
      }
    }
    if (statement.type !== "LocalStatement") return;

    const unused = statement.variables.map((variable) => {
      const symbol = resolved.symbolOf(variable);
      return Boolean(symbol && symbol.references.length === 0);
    });
    if (!unused.some(Boolean)) return;

    if (unused.every(Boolean)) {
      if (
        statement.init.every(
          (expression) =>
            isDiscardableInitializer(expression) || isStatementCall(expression),
        )
      ) {
        const calls = statement.init.filter(isStatementCall).map(callStatement);
        changed = true;
        replacements.set(statement, calls);
      }
      return;
    }

    let variables = [...statement.variables];
    let init = [...statement.init];
    let unusedAfterPairRemoval = [...unused];

    // 初期値なしなら全変数の値はnilで固定され、位置対応を維持する必要がない。
    if (init.length === 0) {
      variables = variables.filter((_, index) => !unused[index]);
      unusedAfterPairRemoval = unused.filter((value) => !value);
    }

    // 要素数が一致するときだけ、変数とRHSの対応を崩さず安全なペアを抜ける。
    if (init.length > 0 && variables.length === init.length) {
      const retainedIndexes = variables
        .map((_, index) => index)
        .filter(
          (index) => !(unused[index] && isDiscardableInitializer(init[index])),
        );
      variables = retainedIndexes.map((index) => variables[index]);
      init = retainedIndexes.map((index) => init[index]);
      unusedAfterPairRemoval = retainedIndexes.map((index) => unused[index]);
    }

    // 末尾の未使用名は、対応RHSを余剰式として評価させたまま名前だけ除ける。
    let retainedVariableCount = variables.length;
    while (
      retainedVariableCount > 0 &&
      unusedAfterPairRemoval[retainedVariableCount - 1]
    ) {
      retainedVariableCount--;
    }
    variables = variables.slice(0, retainedVariableCount);

    if (variables.length === statement.variables.length) return;
    changed = true;
    const replacement = {
      ...statement,
      variables,
      init,
    } as Parser.LocalStatement;
    replacements.set(statement, [replacement]);
  });

  if (replacements.size > 0) {
    const nextBody: Parser.Statement[] = [];
    body.forEach((statement, index) => {
      const replacement = replacements.get(statement);
      if (!replacement) {
        nextBody.push(statement);
        return;
      }
      if (replacement.length > 0) {
        metadata.replaceStatement(statement, replacement);
        nextBody.push(...replacement);
        return;
      }
      const next = body.slice(index + 1).find((candidate) => {
        const candidateReplacement = replacements.get(candidate);
        return !candidateReplacement || candidateReplacement.length > 0;
      });
      const nextReplacement = next ? replacements.get(next) : undefined;
      metadata.removeStatement(statement, nextReplacement?.[0] ?? next);
    });
    body.splice(0, body.length, ...nextBody);
  }
  return changed;
}

export function removeUnusedLocals(
  chunk: Parser.Chunk,
  resolved: ResolveResult,
  metadata: SourceMetadata,
): boolean {
  return removeFromBlock(chunk.body, resolved, metadata);
}
