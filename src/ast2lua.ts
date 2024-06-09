// based on "luamin": Copyright Mathias Bynens <https://mathiasbynens.be/>
// SPDX-License-Identifier: MIT

/* eslint-disable @typescript-eslint/no-unnecessary-condition */
import Parser from "luaparse";

const PRECEDENCE: Record<string, number> = {
    'or': 1,
    'and': 2,
    '<': 3, '>': 3, '<=': 3, '>=': 3, '~=': 3, '==': 3,
    '..': 5,
    '+': 6, '-': 6, // binary -
    '*': 7, '/': 7, '%': 7,
    'unarynot': 8, 'unary#': 8, 'unary-': 8, // unary -
    '^': 10
};

/*const IDENTIFIER_PARTS = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'a',
    'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm', 'n', 'o', 'p',
    'q', 'r', 's', 't', 'u', 'v', 'w', 'x', 'y', 'z', 'A', 'B', 'C', 'D', 'E',
    'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M', 'N', 'O', 'P', 'Q', 'R', 'S', 'T',
    'U', 'V', 'W', 'X', 'Y', 'Z', '_'];
*/
export function minify(ast: Parser.Chunk) {
    return formatStatementList(ast.body);
}

function wrapArray<T>(obj: T | T[]): T[] {
    if (Array.isArray(obj)) {
        return obj;
    }
    return [obj];
}

function formatStatementList(body: Parser.Statement[] | Parser.Statement) {
    let result = '';
    wrapArray(body).forEach((statement) => {
        result = joinStatements(result, formatStatement(statement), ';');
    })
    return result;
}

function formatStatement(statement: Parser.Statement) {
    let result = '';
    if (statement.type == 'AssignmentStatement') {
        // left-hand side
        result = joinStatements(result, statement.variables.map(variable => formatExpression(variable)).join(','));
        // right-hand side
        result = joinStatements(result, '=');
        result = joinStatements(result,  statement.init.map(init => formatExpression(init)).join(','));
    } else if (statement.type == 'LocalStatement') {
        result = joinStatements(result, 'local ');
        // left-hand side
        result = joinStatements(result,  statement.variables.map(variable => generateIdentifier(variable.name)).join(','));
        // right-hand side
        if (statement.init.length) {
            result = joinStatements(result,  '=');
            result = joinStatements(result,  statement.init.map(init => formatExpression(init)).join(','));
        }
    } else if (statement.type == 'CallStatement') {
        result = formatExpression(statement.expression);
    } else if (statement.type == 'IfStatement') {
        statement.clauses.forEach((clause) => {
            if (clause.type == "IfClause") {
                result = joinStatements(result, 'if');
                result = joinStatements(result, formatExpression(clause.condition));
                result = joinStatements(result, 'then');
            } else if (clause.type == "ElseifClause") {
                result = joinStatements(result, 'elseif');
                result = joinStatements(result, formatExpression(clause.condition));
                result = joinStatements(result, 'then');
            } else {
                result = joinStatements(result, 'else');
            }
            result = joinStatements(result, formatStatementList(clause.body));
        })
        result = joinStatements(result, 'end');
        
    } else if (statement.type == 'WhileStatement') {
        result = joinStatements('while', formatExpression(statement.condition));
        result = joinStatements(result, 'do');
        result = joinStatements(result, formatStatementList(statement.body));
        result = joinStatements(result, 'end');

    } else if (statement.type == 'DoStatement') {
        result = joinStatements('do', formatStatementList(statement.body));
        result = joinStatements(result, 'end');

    } else if (statement.type == 'ReturnStatement') {
        result = joinStatements(result, 'return');
        if (statement.arguments.length) {
            result = joinStatements(
                result,
                statement.arguments.map(argument => formatExpression(argument)).join(',')
            );
        }

    } else if (statement.type == 'BreakStatement') {
        result = joinStatements(result, 'break');
    } else if (statement.type == 'RepeatStatement') {
        result = joinStatements('repeat', formatStatementList(statement.body));
        result = joinStatements(result, 'until');
        result = joinStatements(result, formatExpression(statement.condition))
    } else if (statement.type == 'FunctionDeclaration') {

        result = (statement.isLocal ? 'local ' : '') + 'function ';
        if (statement.identifier) {
            result = joinStatements(result,  formatExpression(statement.identifier));
        }
        result = joinStatements(result,  '(');

        if (statement.parameters.length) {
            result = joinStatements(result,  statement.parameters.map(parameter => {
                return parameter.type == "Identifier" ? generateIdentifier(parameter.name)
                                                      : parameter.value
            }).join(','));
        }

        result = joinStatements(result,  ')');
        result = joinStatements(result, formatStatementList(statement.body));
        result = joinStatements(result, 'end');

    } else if (statement.type == 'ForGenericStatement') {
        // see also `ForNumericStatement`

        result = joinStatements(result, 'for ');
        result = joinStatements(result, statement.variables.map(variable => generateIdentifier(variable.name)).join(','));
        result = joinStatements(result,  ' in');
        result = joinStatements(result, statement.iterators.map(iterator => formatExpression(iterator)).join(','));
        result = joinStatements(result, 'do');
        result = joinStatements(result, formatStatementList(statement.body));
        result = joinStatements(result, 'end');

    } else if (statement.type == 'ForNumericStatement') {

        // The variables in a `ForNumericStatement` are always local
        result = joinStatements(result, 'for ' + generateIdentifier(statement.variable.name) + '=');
        result = joinStatements(result,
            formatExpression(statement.start) + ',' +
            formatExpression(statement.end));

        if (statement.step) {
            result = joinStatements(result,  ',' + formatExpression(statement.step));
        }

        result = joinStatements(result, 'do');
        result = joinStatements(result, formatStatementList(statement.body));
        result = joinStatements(result, 'end');

    } else if (statement.type == 'LabelStatement') {

        // The identifier names in a `LabelStatement` can safely be renamed
        result = joinStatements(result, '::' + generateIdentifier(statement.label.name) + '::');

    } else if (statement.type == 'GotoStatement') {

        // The identifier names in a `GotoStatement` can safely be renamed
        result = joinStatements(result, 'goto ' + generateIdentifier(statement.label.name));

    } else {
        throw TypeError('Unknown statement type: `' + JSON.stringify(statement) + '`');
    }

    return result;
}

function joinStatements(a: string, b: string, separator?: string) {
    separator = separator ? separator : " ";

    const lastCharA = a.slice(-1);
    const firstCharB = b.charAt(0);

    const regexAlphaUnderscore = /[a-zA-Z_]/;
    const regexAlphaNumUnderscore = /[a-zA-Z0-9_]/;
    const regexDigits = /[0-9]/;
    
    if (lastCharA == '' || firstCharB == '') {
        return a + b;
    }
    if (regexAlphaUnderscore.test(lastCharA)) {
        if (regexAlphaNumUnderscore.test(firstCharB)) {
            // e.g. `while` + `1`
            // e.g. `local a` + `local b`
            return a + separator + b;
        } else {
            // e.g. `not` + `(2>3 or 3<2)`
            // e.g. `x` + `^`
            return a + b;
        }
    }
    if (regexDigits.test(lastCharA)) {
        if (
            firstCharB == '(' ||
            !(firstCharB == '.' ||
                regexAlphaUnderscore.test(firstCharB))
        ) {
            // e.g. `1` + `+`
            // e.g. `1` + `==`
            return a + b;
        } else {
            // e.g. `1` + `..`
            // e.g. `1` + `and`
            return a + separator + b;
        }
    }
    if (lastCharA == firstCharB && lastCharA == '-') {
        // e.g. `1-` + `-2`
        return a + separator + b;
    }
    const secondLastCharA = a.slice(-2, -1);
    if (lastCharA == '.' && secondLastCharA != '.' && regexAlphaNumUnderscore.test(firstCharB)) {
        // e.g. `1.` + `print`
        return a + separator + b;
    }
    return a + b;
}

interface ExpressionOptoions {
    precedence?: number;
    preserveIdentifiers?: boolean;
    direction?: "left" | "right" | undefined;
    parent?: string | undefined;
}

function formatExpression(expression: Parser.Expression, argOptions?: ExpressionOptoions): string {
    if (expression.type == "Identifier") {
        // eslint-disable-next-line @typescript-eslint/ban-ts-comment, @typescript-eslint/prefer-ts-expect-error
        //@ts-ignore
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
        return expression.isLocal ? generateIdentifier(expression.name) : expression.name;
    } else if (expression.type == "StringLiteral" || expression.type == "NumericLiteral" || expression.type == "BooleanLiteral" || expression.type == "NilLiteral" || expression.type == "VarargLiteral") {
        return expression.raw;
    } else if (expression.type == "LogicalExpression" || expression.type == "BinaryExpression") {
        const operator = expression.operator;
        const currentPrecedence = PRECEDENCE[operator];
        let associativity: ("left" | "right") = "left";
        const options = {
            precedence: 0,
            preserveIdentifiers: false,
            ...argOptions
        }

        const leftHand = formatExpression(expression.left, {
            precedence: currentPrecedence,
            direction: "left",
            parent: operator
        })
        const rightHand = formatExpression(expression.right, {
            precedence: currentPrecedence,
            direction: "right",
            parent: operator
        })
        if (operator == '^' || operator == '..') {
            associativity = "right";
        } else if (
            currentPrecedence < options.precedence ||
            (
                currentPrecedence == options.precedence &&
                associativity != options.direction &&
                options.parent != '+' &&
                !(options.parent == '*' && (operator == '/' || operator == '*'))
            )
        ) {
            return "(" + joinStatements(joinStatements(leftHand, operator), rightHand) + ")"
        }
        return joinStatements(joinStatements(leftHand, operator), rightHand);
    } else if (expression.type == 'UnaryExpression' ){
        const operator = expression.operator;
        const currentPrecedence = PRECEDENCE['unary' + operator];
        const options = {
            precedence: 0,
            ...argOptions
        }

        let result = joinStatements(
            operator,
            formatExpression(expression.argument, {
                'precedence': currentPrecedence
            })
        );

        if (
            currentPrecedence < options.precedence &&
            // In principle, we should parenthesize the RHS of an
            // expression like `3^-2`, because `^` has higher precedence
            // than unary `-` according to the manual. But that is
            // misleading on the RHS of `^`, since the parser will
            // always try to find a unary operator regardless of
            // precedence.
            !(
                (options.parent == '^') &&
                options.direction == 'right'
            )
        ) {
            result = '(' + result + ')';
        }
        return result;
    } else if (expression.type == 'CallExpression') {
        return formatParenForIndexer(expression.base) + '(' + expression.arguments.map((arg) => formatExpression(arg)).join(",") + ")";
    } else if (expression.type == 'TableCallExpression') {
		return formatExpression(expression.base) + formatExpression(expression.arguments);
    } else if (expression.type == 'StringCallExpression') {
        return formatExpression(expression.base) + formatExpression(expression.argument);
    } else if (expression.type == 'IndexExpression') {
        return formatBase(expression.base) + '[' + formatExpression(expression.index) + ']';
    }else if (expression.type == "MemberExpression") {
        return formatParenForIndexer(expression.base) + expression.indexer + formatExpression(expression.identifier, { preserveIdentifiers: true });
    }else if (expression.type == 'FunctionDeclaration') {
        let result = 'function(';
        if (expression.parameters.length) {
            result = joinStatements(result, expression.parameters.map(parameter => (parameter.type === "Identifier" ? generateIdentifier(parameter.name) : parameter.value)).join(','));
        }
        result = joinStatements(result, ')');
        result = joinStatements(result, formatStatementList(expression.body));
        result = joinStatements(result, 'end');
        return result;
    } else if (expression.type == 'TableConstructorExpression') {
        let result = '{';

        result = joinStatements(result, expression.fields.map(field => {
            if (field.type == 'TableKey') {
                return '[' + formatExpression(field.key) + ']=' + formatExpression(field.value);
            } else if (field.type == 'TableValue') {
                return formatExpression(field.value);
            } else { // at this point, `field.type == 'TableKeyString'`
                // TODO: keep track of nested scopes (#18)
                return formatExpression(field.key, {'preserveIdentifiers': true}) + '=' + formatExpression(field.value);
            }
        }).join(','));
        return joinStatements(result, '}');
    } else {
        throw TypeError('Unknown expression type: `' + JSON.stringify(expression) + '`');
    }
}

function formatParenForIndexer(base: Parser.Expression) {
    let result = '';
    const type = base.type;
    //@ts-check
    const needsParens = ("inParens" in base) && (
        type == 'CallExpression' ||
        type == 'BinaryExpression' ||
        type == 'FunctionDeclaration' ||
        type == 'TableConstructorExpression' ||
        type == 'LogicalExpression' ||
        type == 'StringLiteral'
    );
    if (needsParens) {
        result = joinStatements(result,  '(');
    }
    result = joinStatements(result,  formatExpression(base));
    if (needsParens) {
        result = joinStatements(result,  ')');
    }
    return result;
}


function generateIdentifier(name: string): string {
    return name;
}

function formatBase(base: Parser.Expression) {
    let result = '';
    const needsParens = ("inParens" in base) && (
        base.type == 'CallExpression' ||
        base.type == 'BinaryExpression' ||
        base.type == 'FunctionDeclaration' ||
        base.type == 'TableConstructorExpression' ||
        base.type == 'LogicalExpression' ||
        base.type == 'StringLiteral'
    );
    if (needsParens) {
        result = joinStatements(result, '(');
    }
    result = joinStatements(result, formatExpression(base));
    if (needsParens) {
        result = joinStatements(result, ')');
    }
    return result;
}

// "LabelStatement"
// "BreakStatement"
// "GotoStatement"
// "ReturnStatement"
//// "IfStatement"
//// "IfClause"
//// "ElseifClause"
//// "ElseClause"
// "WhileStatement"
// "DoStatement"
// "RepeatStatement"
//// "LocalStatement"
//// "AssignmentStatement"
//// "CallStatement"
// "FunctionDeclaration"
// "ForNumericStatement"
// "ForGenericStatement"

// "Chunk"
// "Identifier"
// "StringLiteral"
// "NumericLiteral"
// "BooleanLiteral"
// "NilLiteral"
// "VarargLiteral"
// "TableKey"
// "TableKeyString"
// "TableValue"
// "TableConstructorExpression"
// "UnaryExpression"
// "BinaryExpression"
// "LogicalExpression"
// "MemberExpression"
// "IndexExpression"
// "CallExpression"
// "TableCallExpression"
// "StringCallExpression"
// "Comment"
