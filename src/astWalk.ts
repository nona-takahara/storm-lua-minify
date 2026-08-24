import Parser from "luaparse";

/**
 * ASTを変更せずに、式中の変数参照とnested blockを列挙するための共通walker。
 * 宣言Identifier、member/table fieldの名前は変数参照ではないため通知しない。
 * blockの再帰方針は利用側が決める。これにより、同一blockだけを解析するpassと
 * nested blockまで集めるpassの両方が、同じAST分類を利用できる。
 */
export interface AstWalkVisitor {
  readonly onIdentifierReference?: (id: Parser.Identifier) => void;
  readonly onBlock?: (body: Parser.Statement[]) => void;
  // Function bodyは遅延実行されるためwalker自身は入らない。必要な解析だけが
  // 関数を独立したexecution unitとして受け取り、bodyを走査する。
  readonly onFunction?: (fn: Parser.FunctionDeclaration) => void;
}

export function walkStatement(
  statement: Parser.Statement,
  visitor: AstWalkVisitor,
): void {
  switch (statement.type) {
    case "LocalStatement":
      statement.init.forEach((expr) => {
        walkExpression(expr, visitor);
      });
      return;
    case "AssignmentStatement":
      statement.variables.forEach((variable) => {
        if (variable.type === "Identifier") {
          visitor.onIdentifierReference?.(variable);
        } else {
          walkExpression(variable, visitor);
        }
      });
      statement.init.forEach((expr) => {
        walkExpression(expr, visitor);
      });
      return;
    case "CallStatement":
      walkExpression(statement.expression, visitor);
      return;
    case "DoStatement":
      visitor.onBlock?.(statement.body);
      return;
    case "WhileStatement":
      walkExpression(statement.condition, visitor);
      visitor.onBlock?.(statement.body);
      return;
    case "RepeatStatement":
      visitor.onBlock?.(statement.body);
      walkExpression(statement.condition, visitor);
      return;
    case "IfStatement":
      statement.clauses.forEach((clause) => {
        if (clause.type !== "ElseClause") {
          walkExpression(clause.condition, visitor);
        }
        visitor.onBlock?.(clause.body);
      });
      return;
    case "ForNumericStatement":
      walkExpression(statement.start, visitor);
      walkExpression(statement.end, visitor);
      if (statement.step) walkExpression(statement.step, visitor);
      visitor.onBlock?.(statement.body);
      return;
    case "ForGenericStatement":
      statement.iterators.forEach((iterator) => {
        walkExpression(iterator, visitor);
      });
      visitor.onBlock?.(statement.body);
      return;
    case "FunctionDeclaration":
      if (statement.identifier) {
        if (statement.identifier.type === "Identifier") {
          if (!statement.isLocal) {
            visitor.onIdentifierReference?.(statement.identifier);
          }
        } else {
          walkExpression(statement.identifier, visitor);
        }
      }
      visitor.onFunction?.(statement);
      visitor.onBlock?.(statement.body);
      return;
    case "ReturnStatement":
      statement.arguments.forEach((argument) => {
        walkExpression(argument, visitor);
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

export function walkExpression(
  expression: Parser.Expression,
  visitor: AstWalkVisitor,
): void {
  switch (expression.type) {
    case "Identifier":
      visitor.onIdentifierReference?.(expression);
      return;
    case "StringLiteral":
    case "NumericLiteral":
    case "BooleanLiteral":
    case "NilLiteral":
    case "VarargLiteral":
      return;
    case "LogicalExpression":
    case "BinaryExpression":
      walkExpression(expression.left, visitor);
      walkExpression(expression.right, visitor);
      return;
    case "UnaryExpression":
      walkExpression(expression.argument, visitor);
      return;
    case "CallExpression":
      walkExpression(expression.base, visitor);
      expression.arguments.forEach((argument) => {
        walkExpression(argument, visitor);
      });
      return;
    case "TableCallExpression":
      walkExpression(expression.base, visitor);
      walkExpression(expression.arguments, visitor);
      return;
    case "StringCallExpression":
      walkExpression(expression.base, visitor);
      walkExpression(expression.argument, visitor);
      return;
    case "IndexExpression":
      walkExpression(expression.base, visitor);
      walkExpression(expression.index, visitor);
      return;
    case "MemberExpression":
      walkExpression(expression.base, visitor);
      return;
    case "FunctionDeclaration":
      visitor.onFunction?.(expression);
      visitor.onBlock?.(expression.body);
      return;
    case "TableConstructorExpression":
      expression.fields.forEach((field) => {
        if (field.type === "TableKey") {
          walkExpression(field.key, visitor);
        }
        walkExpression(field.value, visitor);
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
