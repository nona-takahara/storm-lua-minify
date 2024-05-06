// luamin: Copyright Mathias Bynens <https://mathiasbynens.be/>

import Parser from "luaparse";

interface FilePosition {
    line: number;
    column: number;
}


interface FileRange {
    start: FilePosition;
    end: FilePosition;
}

interface CodeSnippet {
    lua: string;
    orignalLoc?: FileRange;
}


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
export function ast2lua(ast: Parser.Chunk) {
    console.log(joinLua(generateStatementList(ast.body), "\n"));
}

export function joinLua(code: CodeSnippet[], separator?: string): string {
    return code.reduce((a, b) => ({ lua: joinSnippet(a.lua, b.lua, separator) })).lua;
}

function joinSnippet(a: string, b: string, separator?: string) {
    separator = separator ? separator : " ";

    const regexAlphaUnderscore = /[a-zA-Z_]/;
    const regexAlphaNumUnderscore = /[a-zA-Z0-9_]/;
    const regexDigits = /[0-9]/;

    const lastCharA = a.slice(-1);
    const firstCharB = b.charAt(0);

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

function generateStatementList(statement: Parser.Statement[] | Parser.Statement): CodeSnippet[] {
    let res: CodeSnippet[];
    if (Array.isArray(statement)) {
        res = statement.map((st) => generateStatement(st)).flat();
    } else {
        res = generateStatement(statement);
    }
    return res;
}

function generateStatement(statement: Parser.Statement): CodeSnippet[] {
    if (statement.type == "AssignmentStatement" || statement.type == "LocalStatement") {
        const leftHand = statement.variables.map((variable) =>
            generateExpression(variable)
        ).join(",");
        const assignment = statement.init.length ? "=" : "";
        const rightHand = statement.init.map((initexp) => generateExpression(initexp)).join(",");
        return [{
            lua:
                ((statement.type == "LocalStatement") ? "local " : "")
                + leftHand + assignment + rightHand,
            orignalLoc: statement.loc
        }];
    }

    if (statement.type == "FunctionDeclaration") {
        const defineKeyword = (statement.isLocal ? "local " : "") + "function";
        const identifier = statement.identifier ? generateExpression(statement.identifier) : "";
        const argumentList = statement.parameters.map((parameter) =>
            (parameter.type == "VarargLiteral") ? parameter.value : generateExpression(parameter)
        ).join(",")
        return [[
            {
                lua: joinSnippet(defineKeyword, identifier) + "(" + argumentList + ")",
                orignalLoc: statement.loc
            }
        ], generateStatementList(statement.body), [
            { lua: "end" }
        ]].flat();
    }

    if (statement.type == "CallStatement") {
        return [{
            lua: generateExpression(statement.expression),
            orignalLoc: statement.loc
        }];
    }

    if (statement.type == "IfStatement") {
        const code: CodeSnippet[] = statement.clauses.map((clauses) => {
            if (clauses.type == "IfClause") {
                return [{
                    lua: joinSnippet(joinSnippet("if", generateExpression(clauses.condition)), "then"),
                    originalLoc: clauses.loc
                } as CodeSnippet].concat(
                    generateStatementList(clauses.body));
            }
            if (clauses.type == "ElseifClause") {
                return [{
                    lua: joinSnippet(joinSnippet("elseif", generateExpression(clauses.condition)), "then"),
                    originalLoc: clauses.loc
                } as CodeSnippet].concat(
                    generateStatementList(clauses.body));
            }
            //if (clauses.type == "ElseClause") {
            return [{
                lua: "else",
                originalLoc: clauses.loc
            } as CodeSnippet].concat(
                generateStatementList(clauses.body));
            //}
        }).flat();
        code.push({
            lua: "end", orignalLoc: undefined
        });
        return code;
    }

    return [{
        lua: "{{" + statement.type + "}}",
        orignalLoc: undefined
    }];
    //throw TypeError('Unknown statement type: `' + statement.type + '`');
}

interface ExpressionOptoions {
    precedence?: number;
    preserveIdentifiers?: boolean;
    direction?: "left" | "right" | undefined;
    parent?: string | undefined;
}

function generateExpression(expression: Parser.Expression, argOptions?: ExpressionOptoions): string {

    if (expression.type == "Identifier") {
        return expression.name;
    }

    if (expression.type == "StringLiteral" || expression.type == "NumericLiteral" || expression.type == "BooleanLiteral" || expression.type == "NilLiteral" || expression.type == "VarargLiteral") {
        return expression.raw;
    }

    if (expression.type == "LogicalExpression" || expression.type == "BinaryExpression") {
        const operator = expression.operator;
        const currentPrecedence = PRECEDENCE[operator];
        let associativity: ("left" | "right") = "left";
        const options = {
            precedence: 0,
            preserveIdentifiers: false,
            ...argOptions
        }

        const leftHand = generateExpression(expression.left, {
            precedence: currentPrecedence,
            direction: "left",
            parent: operator
        })
        const rightHand = generateExpression(expression.right, {
            precedence: currentPrecedence,
            direction: "right",
            parent: operator
        })
        if (operator == '^' || operator == '..') {
            associativity = "right";
        }

        if (
            currentPrecedence < options.precedence ||
            (
                currentPrecedence == options.precedence &&
                associativity != options.direction &&
                options.parent != '+' &&
                !(options.parent == '*' && (operator == '/' || operator == '*'))
            )
        ) {
            return "(" + joinSnippet(joinSnippet(leftHand, operator), rightHand) + ")"
        }
        return joinSnippet(joinSnippet(leftHand, operator), rightHand);
    }

    if (expression.type == 'CallExpression') {
        return formatParenForIndexer(expression.base) + '(' + expression.arguments.map((arg) => generateExpression(arg)).join(",") + ")";
    }

    if (expression.type == "MemberExpression") {
        return formatParenForIndexer(expression.base) + expression.indexer + generateExpression(expression.identifier, { preserveIdentifiers: true });
    }

    return "<" + expression.type + ">";
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
        result += '(';
    }
    result += generateExpression(base);
    if (needsParens) {
        result += ')';
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
