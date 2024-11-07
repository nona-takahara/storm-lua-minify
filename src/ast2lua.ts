// based on "luamin": Copyright Mathias Bynens <https://mathiasbynens.be/>
// SPDX-License-Identifier: MIT

/* eslint-disable @typescript-eslint/no-unnecessary-condition */
import Parser from "luaparse";
import { SourceNode } from "source-map";

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

const identifierMap = new Map<string, string>();
const identifiersInUse = new Set<string>();

const IDENTIFIER_PARTS = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'a',
    'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm', 'n', 'o', 'p',
    'q', 'r', 's', 't', 'u', 'v', 'w', 'x', 'y', 'z', 'A', 'B', 'C', 'D', 'E',
    'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M', 'N', 'O', 'P', 'Q', 'R', 'S', 'T',
    'U', 'V', 'W', 'X', 'Y', 'Z', '_'];

export function minify(ast: Parser.Chunk) {
    //ast.globals?.map(v => identifiersInUse.add(v.name));
    return formatStatementList(ast.body);
}

function sourceNodeHelper(node: Parser.Node | undefined, chuncks: (SourceNode | string)[] | SourceNode | string, name?: string) {
    const line = node?.loc?.start.line;
    const column = node?.loc?.start.column;
    return new SourceNode(line == undefined ? null : line, column == undefined ? null : column, "test.lua", chuncks, name);
}

function wrapArray<T>(obj: T | T[]): T[] {
    if (Array.isArray(obj)) {
        return obj;
    }
    return [obj];
}

function formatStatementList(body: Parser.Statement[] | Parser.Statement) {
    const result = sourceNodeHelper(undefined, []);
    wrapArray(body).forEach((statement) => {
        addWithSeparator(result, formatStatement(statement), '\n');
    })
    return result;
}

function formatStatement(statement: Parser.Statement): SourceNode {
    if (statement.type == 'AssignmentStatement') {
        // left-hand side
        const variables = statement.variables.map(variable => [formatExpression(variable), ","]).flat();
        const inits = statement.init.map(init => [formatExpression(init), ',']).flat();

        const result = sourceNodeHelper(statement, sourceNodeHelper(undefined, variables.slice(0, -1)));
        addWithSeparator(result, "=");
        addWithSeparator(result, sourceNodeHelper(undefined, inits.slice(0, -1)));
        return result;
    } else if (statement.type == 'LocalStatement') {
        const variables = statement.variables.map(variable => [formatExpression(variable), ","]).flat();
        const result = sourceNodeHelper(statement, ["local ", sourceNodeHelper(undefined, variables.slice(0, -1))]);

        if (statement.init.length) {
            const inits = statement.init.map(init => [formatExpression(init), ',']).flat();

            addWithSeparator(result, "=");
            addWithSeparator(result, sourceNodeHelper(undefined, inits.slice(0, -1)));
        }
        return result;
    } else if (statement.type == 'CallStatement') {
        return formatExpression(statement.expression); // NOTE: もう一度囲んでもいい
    } else if (statement.type == 'IfStatement') {
        const result = sourceNodeHelper(statement, []);
        statement.clauses.forEach((clause) => {
            const clauseMap = sourceNodeHelper(clause, []);
            if (clause.type == "IfClause") {
                addWithSeparator(clauseMap, "if");
                addWithSeparator(clauseMap, formatExpression(clause.condition));
                addWithSeparator(clauseMap, 'then');
            } else if (clause.type == "ElseifClause") {
                addWithSeparator(clauseMap, 'elseif');
                addWithSeparator(clauseMap, formatExpression(clause.condition));
                addWithSeparator(clauseMap, 'then');
            } else {
                addWithSeparator(clauseMap, 'else');
            }
            addWithSeparator(clauseMap, formatStatementList(clause.body));
            addWithSeparator(result, clauseMap);
        })
        addWithSeparator(result, 'end');
        return result;
    } else if (statement.type == 'WhileStatement') {
        const result = sourceNodeHelper(statement, "while");
        addWithSeparator(result, formatExpression(statement.condition));
        addWithSeparator(result, 'do');
        addWithSeparator(result, formatStatementList(statement.body));
        addWithSeparator(result, 'end');
        return result;
    } else if (statement.type == 'DoStatement') {
        const result = sourceNodeHelper(statement, "do");
        addWithSeparator(result, formatStatementList(statement.body));
        addWithSeparator(result, 'end');
        return result;
    } else if (statement.type == 'ReturnStatement') {
        const result = sourceNodeHelper(statement, "return");
        if (statement.arguments.length) {
            const returns = statement.arguments.map(argument => [formatExpression(argument), ","]).flat();
            addWithSeparator(
                result,
                returns.slice(0, -1)
            );
        }
        return result;
    } else if (statement.type == 'BreakStatement') {
        return sourceNodeHelper(statement, "break");
    } else if (statement.type == 'RepeatStatement') {
        const result = sourceNodeHelper(statement, 'repeat');
        addWithSeparator(result, formatStatementList(statement.body));
        addWithSeparator(result, 'until');
        addWithSeparator(result, formatExpression(statement.condition))
        return result;
    } else if (statement.type == 'FunctionDeclaration') {

        const result = sourceNodeHelper(statement, (statement.isLocal ? 'local ' : '') + 'function ');
        if (statement.identifier) {
            addWithSeparator(result, formatExpression(statement.identifier));
        }
        addWithSeparator(result, '(');

        if (statement.parameters.length) {
            const parameters = statement.parameters.map(parameter => {
                return [parameter.type == "Identifier" ? generateIdentifier(parameter)
                    : parameter.value, ","]
            }).flat();
            addWithSeparator(result, parameters.slice(0, -1));
        }

        addWithSeparator(result, ')');
        addWithSeparator(result, formatStatementList(statement.body));
        addWithSeparator(result, 'end');
        return result;
    } else if (statement.type == 'ForGenericStatement') {
        // see also `ForNumericStatement`
        const result = sourceNodeHelper(statement, "for");
        const variables = statement.variables.map(variable => [generateIdentifier(variable), ","]).flat()
        const iterators = statement.iterators.map(iterator => [formatExpression(iterator), ","]).flat()
        addWithSeparator(result, variables.slice(0, -1));
        addWithSeparator(result, 'in');
        addWithSeparator(result, iterators.slice(0, -1));
        addWithSeparator(result, 'do');
        addWithSeparator(result, formatStatementList(statement.body));
        addWithSeparator(result, 'end');
        return result;
    } else if (statement.type == 'ForNumericStatement') {
        // The variables in a `ForNumericStatement` are always local
        const result = sourceNodeHelper(statement, "for");
        addWithSeparator(result, generateIdentifier(statement.variable));
        addWithSeparator(result, "=");
        addWithSeparator(result, formatExpression(statement.start))
        addWithSeparator(result, ',')
        addWithSeparator(result, formatExpression(statement.end));

        if (statement.step) {
            addWithSeparator(result, ',')
            addWithSeparator(result, formatExpression(statement.step));
        }

        addWithSeparator(result, 'do');
        addWithSeparator(result, formatStatementList(statement.body));
        addWithSeparator(result, 'end');
        return result;

    } else if (statement.type == 'LabelStatement') {

        // The identifier names in a `LabelStatement` can safely be renamed
        return sourceNodeHelper(statement, ['::', generateIdentifier(statement.label), '::']);

    } else if (statement.type == 'GotoStatement') {

        // The identifier names in a `GotoStatement` can safely be renamed
        return sourceNodeHelper(statement, ['goto ', generateIdentifier(statement.label)]);

    } else {
        throw TypeError('Unknown statement type: `' + JSON.stringify(statement) + '`');
    }
}

/*function joinStatements(a: string | SourceNode, b: string | SourceNode, separator = " ") {
    return isNeedSeparator(a.toString(), b.toString()) ? a.toString() + separator + b.toString() : a.toString() + b.toString();
}*/

function addWithSeparator(val: SourceNode, adding: (string | SourceNode)[] | SourceNode | string, separator = " ") {
    if (isNeedSeparator(val.toString(), wrapArray(adding).map(p => p.toString()).join())) {
        val.add(separator);
    }
    val.add(adding);
    return val;
}

function prependWithSeparator(val: SourceNode, prepending: (string | SourceNode)[] | SourceNode | string, separator = " ") {
    if (isNeedSeparator(wrapArray(prepending).map(p => p.toString()).join(), val.toString())) {
        val.prepend(separator);
    }
    val.prepend(prepending);
    return val;
}

function insertSeparator(a: string | SourceNode, b: string | SourceNode, separator = " ") {
    return isNeedSeparator(a.toString(), b.toString()) ? separator : undefined;
}

function isNeedSeparator(a: string, b: string) {
    const lastCharA = a.slice(-1);
    const firstCharB = b.charAt(0);

    const regexAlphaUnderscore = /[a-zA-Z_]/;
    const regexAlphaNumUnderscore = /[a-zA-Z0-9_]/;
    const regexDigits = /[0-9]/;

    if (lastCharA == '' || firstCharB == '') {
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
            firstCharB == '(' ||
            !(firstCharB == '.' ||
                regexAlphaUnderscore.test(firstCharB))
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
    if (lastCharA == firstCharB && lastCharA == '-') {
        // e.g. `1-` + `-2`
        return true;
    }
    const secondLastCharA = a.slice(-2, -1);
    if (lastCharA == '.' && secondLastCharA != '.' && regexAlphaNumUnderscore.test(firstCharB)) {
        // e.g. `1.` + `print`
        return true
    }
    return false;
}

interface ExpressionOptoions {
    precedence?: number;
    preserveIdentifiers?: boolean;
    direction?: "left" | "right" | undefined;
    parent?: string | undefined;
}

function formatExpression(expression: Parser.Expression, argOptions?: ExpressionOptoions): SourceNode {
    if (expression.type == "Identifier") {
        // eslint-disable-next-line @typescript-eslint/ban-ts-comment, @typescript-eslint/prefer-ts-expect-error
        //@ts-ignore
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
        return sourceNodeHelper(expression, expression.isLocal ? generateIdentifier(expression, true) : expression.name, expression.name);
    } else if (expression.type == "StringLiteral" || expression.type == "NumericLiteral" || expression.type == "BooleanLiteral" || expression.type == "NilLiteral" || expression.type == "VarargLiteral") {
        return sourceNodeHelper(expression, expression.raw);
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
            return sourceNodeHelper(expression,
                [
                    "(",
                    leftHand,
                    insertSeparator(leftHand, operator),
                    operator,
                    insertSeparator(operator, rightHand),
                    rightHand,
                    ")"
                ].filter((p): p is Exclude<typeof p, undefined> => p !== undefined));
        }
        return sourceNodeHelper(expression,
            [
                leftHand,
                insertSeparator(leftHand, operator),
                operator,
                insertSeparator(operator, rightHand),
                rightHand
            ].filter((p): p is Exclude<typeof p, undefined> => p !== undefined)
        );
    } else if (expression.type == 'UnaryExpression') {
        const operator = expression.operator;
        const currentPrecedence = PRECEDENCE['unary' + operator];
        const options = {
            precedence: 0,
            ...argOptions
        }

        const p2 = formatExpression(expression.argument, {
            'precedence': currentPrecedence
        });
        const result = sourceNodeHelper(expression, [
            operator,
            insertSeparator(operator, p2),
            p2
        ].filter((p): p is Exclude<typeof p, undefined> => p !== undefined));

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
            result.prepend('('); result.add(')');
        }
        return result;
    } else if (expression.type == 'CallExpression') {
        const args = (expression.arguments.map((arg) => [formatExpression(arg), ","])).flat();
        return sourceNodeHelper(expression, [
            formatBase(expression.base),
            '(',
            sourceNodeHelper(undefined, args.slice(0, -1)),
            ")"
        ]);
    } else if (expression.type == 'TableCallExpression') {
        return sourceNodeHelper(expression, [formatExpression(expression.base), formatExpression(expression.arguments)]);
    } else if (expression.type == 'StringCallExpression') {
        return sourceNodeHelper(expression, [formatExpression(expression.base), formatExpression(expression.argument)]);
    } else if (expression.type == 'IndexExpression') {
        return sourceNodeHelper(expression, [formatBase(expression.base), '[', formatExpression(expression.index), ']']);
    } else if (expression.type == "MemberExpression") {
        return sourceNodeHelper(expression, [
            formatBase(expression.base),
            expression.indexer,
            formatExpression(expression.identifier, { preserveIdentifiers: true })
        ]);
    } else if (expression.type == 'FunctionDeclaration') {
        const result = sourceNodeHelper(expression, ["function", "("]);

        if (expression.parameters.length) {
            const parameters = expression.parameters.map(parameter => {
                return [sourceNodeHelper(parameter, (parameter.type === "Identifier" ? generateIdentifier(parameter) : parameter.value)), ","];
            }).flat();
            addWithSeparator(result, parameters.slice(0, -1));
        }
        result.add(")");
        const body = formatStatementList(expression.body);
        addWithSeparator(result, body);
        addWithSeparator(result, "end");
        return result;
    } else if (expression.type == 'TableConstructorExpression') {
        const result = sourceNodeHelper(expression, "{");
        const fields = expression.fields.map((field, ix, ar) => {
            if (field.type == 'TableKey') {
                return sourceNodeHelper(field, [
                    sourceNodeHelper(undefined, ['[', formatExpression(field.key), ']']),
                    '=',
                    formatExpression(field.value),
                    (ix !== ar.length - 1) ? ',' : undefined
                ].filter((p): p is Exclude<typeof p, undefined> => p !== undefined));
            } else if (field.type == 'TableValue') {
                return [
                    formatExpression(field.value),
                    (ix !== ar.length - 1) ? ',' : undefined
                ].filter((p): p is Exclude<typeof p, undefined> => p !== undefined);
            } else { // at this point, `field.type == 'TableKeyString'`
                // TODO: keep track of nested scopes (#18)
                return sourceNodeHelper(field, [
                    formatExpression(field.key, { 'preserveIdentifiers': true }),
                    '=',
                    formatExpression(field.value),
                    (ix !== ar.length - 1) ? ',' : undefined
                ].filter((p): p is Exclude<typeof p, undefined> => p !== undefined));
            }
        }).flat();
        addWithSeparator(result, fields);
        addWithSeparator(result, "}");
        return result;
    } else {
        throw TypeError('Unknown expression type: `' + JSON.stringify(expression) + '`');
    }
}

function formatBase(base: Parser.Expression): SourceNode {
    const type = base.type;
    //@ts-check
    const needsParens = (
        type == 'CallExpression' ||
        type == 'BinaryExpression' ||
        type == 'FunctionDeclaration' ||
        type == 'TableConstructorExpression' ||
        type == 'LogicalExpression' ||
        type == 'StringLiteral'
    );
    const result = sourceNodeHelper(base, formatExpression(base));
    if (needsParens) {
        prependWithSeparator(result, "(");
        addWithSeparator(result, ")");
    }
    return result;
}

let currentIdentifier = "";

function generateIdentifier(nameItem: Parser.Identifier, nested = false): SourceNode {
    if (nameItem.name === "self") {
        return sourceNodeHelper(nameItem, "self", undefined);
    }

    const defined = identifierMap.get(nameItem.name);
    if (defined) {
        return sourceNodeHelper(nameItem, defined, defined); // 第3引数は要調査
    }

    const length = currentIdentifier.length;
    let position = length - 1;
    let character: string;
    let index;
    while (position >= 0) {
        character = currentIdentifier.charAt(position);
        index = IDENTIFIER_PARTS.indexOf(character);
        if (index != IDENTIFIER_PARTS.length - 1) {
            currentIdentifier = currentIdentifier.substring(0, position) +
                IDENTIFIER_PARTS[index + 1] + generateZeroes(length - (position + 1));
            if (
                isKeyword(currentIdentifier) ||
                identifiersInUse.has(currentIdentifier)
            ) {
                return generateIdentifier(nameItem, nested);
            }
            identifierMap.set(nameItem.name, currentIdentifier);
            return generateIdentifier(nameItem, nested);
        }
        --position;
    }
    currentIdentifier = 'a' + generateZeroes(length);
    if (identifiersInUse.has(currentIdentifier)) {
        return generateIdentifier(nameItem, nested);
    }
    identifierMap.set(nameItem.name, currentIdentifier);
    return generateIdentifier(nameItem, nested);

    //    return sourceNodeHelper(nameItem, nameItem.name, nested ? nameItem.name : undefined);
}


function generateZeroes(length: number) {
    let zero = '0';
    let result = '';
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
        // eslint-disable-next-line no-cond-assign
        if (length >>= 1) {
            zero += zero;
        }
    }
    return result;
}

function isKeyword(id: string) {
    switch (id.length) {
        case 2:
            return 'do' == id || 'if' == id || 'in' == id || 'or' == id;
        case 3:
            return 'and' == id || 'end' == id || 'for' == id || 'nil' == id ||
                'not' == id;
        case 4:
            return 'else' == id || 'goto' == id || 'then' == id || 'true' == id;
        case 5:
            return 'break' == id || 'false' == id || 'local' == id ||
                'until' == id || 'while' == id;
        case 6:
            return 'elseif' == id || 'repeat' == id || 'return' == id;
        case 8:
            return 'function' == id;
    }
    return false;
}
