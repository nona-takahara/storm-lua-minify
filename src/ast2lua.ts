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
    needStatementSplit: boolean;
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

const IDENTIFIER_PARTS = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'a',
    'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm', 'n', 'o', 'p',
    'q', 'r', 's', 't', 'u', 'v', 'w', 'x', 'y', 'z', 'A', 'B', 'C', 'D', 'E',
    'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M', 'N', 'O', 'P', 'Q', 'R', 'S', 'T',
    'U', 'V', 'W', 'X', 'Y', 'Z', '_'];

export function ast2lua(ast: Parser.Chunk) {
    console.log(generateStatementList(ast.body).map(s => s.lua).join("\n"));
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
            orignalLoc: statement.loc,
            needStatementSplit: false
        }];
    }

    if (statement.type == "FunctionDeclaration") {
        const defineKeyword = (statement.isLocal ? "local " : "") + "function ";
        const identifier = statement.identifier ? generateExpression(statement.identifier) : "";
        const argumentList = statement.parameters.map((parameter) => 
                (parameter.type == "VarargLiteral") ? parameter.value : generateExpression(parameter)
            ).join(",")
        return [[
            {lua: defineKeyword+identifier+"("+argumentList+")",
                orignalLoc: statement.loc,
                needStatementSplit: false
            }
        ], generateStatementList(statement.body), [
            {lua: "end", needStatementSplit: false}
        ]].flat();
    }

    if (statement.type == "CallStatement") {
        return [{
            lua: generateExpression(statement.expression),
            orignalLoc: statement.loc,
            needStatementSplit: false
        }];
    }

    if (statement.type == "IfStatement") {
        const code: CodeSnippet[] = statement.clauses.map((clauses) => {
            if (clauses.type == "IfClause") {
                return [{
                    lua: "if "+generateExpression(clauses.condition) + " then",
                    originalLoc: clauses.loc,
                    needStatementSplit: false
                } as CodeSnippet].concat(
                generateStatementList(clauses.body));
            }
            if (clauses.type == "ElseifClause") {
                return [{
                    lua: "elseif "+generateExpression(clauses.condition) + " then",
                    originalLoc: clauses.loc,
                    needStatementSplit: false
                } as CodeSnippet].concat(
                generateStatementList(clauses.body));
            }
            //if (clauses.type == "ElseClause") {
                return [{
                    lua: "else",
                    originalLoc: clauses.loc,
                    needStatementSplit: false
                } as CodeSnippet].concat(
                    generateStatementList(clauses.body));
            //}
        }).flat();
        code.push({
            lua: "end", orignalLoc: undefined, needStatementSplit: false
        });
        return code;
    }

    return [{
        lua: "{{" + statement.type + "}}",
        orignalLoc: undefined,
        needStatementSplit: false
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

    if (expression.type == "StringLiteral" || expression.type == "NumericLiteral" || expression.type == "BooleanLiteral" || expression.type == "NilLiteral" || expression.type == "VarargLiteral"){
        return expression.raw;
    }

    if (expression.type == "LogicalExpression" || expression.type == "BinaryExpression") {
        const operator = expression.operator;
        const currentPrecedence = PRECEDENCE[operator];
        let associativity: ("left" | "right") = "left";
        const options = {
			precedence: 0,
			preserveIdentifiers: false
		,...argOptions
    }

        let result = generateExpression(expression.left, {
            precedence: currentPrecedence,
            direction: "left",
            parent: operator
        })
        result += " "+ expression.operator + " ";
        result += generateExpression(expression.right, {
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
            result = '(' + result + ')';
        }
        return result;
    }

    if (expression.type == 'CallExpression') {
        let result = formatBase(expression.base) + '(';
        result += expression.arguments.map((arg) => generateExpression(arg)).join(",")
        result += ')';
        return result;
    }

    if (expression.type == "MemberExpression") {
        return formatBase(expression.base) + expression.indexer + generateExpression(expression.identifier, {preserveIdentifiers: true});
    }

    return "<" + expression.type  + ">";
}

function formatBase(base: Parser.Expression) {
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
