// Resolveパス（#19）: 宣言ごとに一意なシンボルを持つスコープツリーを構築し、
// 識別子の参照を対応する宣言シンボルに解決する。グローバル参照も識別する。
// このパスは解析のみを行い、ASTやその出力を一切変更しない。
import Parser from "luaparse";

export type SymbolKind = "local" | "param" | "for" | "label";

export interface Scope {
  readonly kind: "chunk" | "function" | "block";
  readonly parent: Scope | null;
  readonly children: Scope[];
  // このスコープで直接宣言されたシンボル（宣言順。同名の再宣言もすべて含む）
  readonly symbols: Symbol[];
}

export interface Symbol {
  readonly id: number;
  readonly name: string;
  readonly kind: SymbolKind;
  readonly scope: Scope;
  readonly declaration: Parser.Identifier;
  // このシンボルを指す参照（宣言箇所自体は含まない）
  readonly references: Parser.Identifier[];
}

export interface GlobalBinding {
  readonly name: string;
  readonly references: Parser.Identifier[];
  // 代入先（AssignmentStatementの左辺、または`function name() end`形式の宣言）
  // として出現した箇所のみ。一度もここに現れないグローバルは、エンジン等の
  // 外部から供給される値を読むだけの識別子とみなせる（#8a）。
  readonly writes: Parser.Identifier[];
}

export interface ResolveResult {
  readonly chunkScope: Scope;
  // チャンク全体で宣言された全シンボル（宣言順）
  readonly symbols: Symbol[];
  readonly globals: Map<string, GlobalBinding>;
  // 宣言・参照どちらの識別子ノードからも対応するシンボルを引ける。
  // グローバル参照やフィールド名など、シンボルを持たない識別子はundefinedを返す。
  symbolOf(identifier: Parser.Identifier): Symbol | undefined;
  // このノードが実際にグローバル参照として解決されたものであればtrue。
  // フィールド名（`.foo`）やテーブルキー名は、たまたま同じ名前文字列の
  // グローバルが存在してもここではfalseになる（#8a: ノード同一性ベースで
  // 判定するため、名前文字列だけを見た誤リネームを防ぐ）。
  isGlobalReference(identifier: Parser.Identifier): boolean;
  // 関数本体の字句scope。upvalue/capture解析がAST範囲や宣言名を再推測せず、
  // Resolveと同じ束縛境界を参照するために公開する。
  scopeOfFunction(fn: Parser.FunctionDeclaration): Scope | undefined;
}

export interface ResolveOptions {
  /** Resolve an identifier using its emitted spelling without mutating the AST. */
  readonly identifierName?: (identifier: Parser.Identifier) => string;
}

interface MutableScope extends Scope {
  readonly parent: MutableScope | null;
  readonly children: MutableScope[];
  readonly bindings: Map<string, Symbol>;
  readonly labels: Map<string, Symbol>;
}

export function resolveScopes(
  chunk: Parser.Chunk,
  options: ResolveOptions = {},
): ResolveResult {
  let nextSymbolId = 0;
  const allSymbols: Symbol[] = [];
  const globals = new Map<string, GlobalBinding>();
  const identifierSymbols = new WeakMap<Parser.Identifier, Symbol>();
  const globalReferenceNodes = new WeakSet<Parser.Identifier>();
  const functionScopes = new WeakMap<Parser.FunctionDeclaration, Scope>();
  const identifierName =
    options.identifierName ??
    ((identifier: Parser.Identifier) => identifier.name);

  function createScope(
    kind: Scope["kind"],
    parent: MutableScope | null,
  ): MutableScope {
    const scope: MutableScope = {
      kind,
      parent,
      children: [],
      symbols: [],
      bindings: new Map(),
      labels: new Map(),
    };
    parent?.children.push(scope);
    return scope;
  }

  function declare(
    scope: MutableScope,
    node: Parser.Identifier,
    kind: SymbolKind,
  ): Symbol {
    const name = identifierName(node);
    const symbol: Symbol = {
      id: nextSymbolId++,
      name,
      kind,
      scope,
      declaration: node,
      references: [],
    };
    // 同名の再宣言はスコープ内の以後の参照から見た束縛を上書きする（Luaの通常のシャドーイング）
    scope.symbols.push(symbol);
    scope.bindings.set(name, symbol);
    allSymbols.push(symbol);
    identifierSymbols.set(node, symbol);
    return symbol;
  }

  function declareLabel(scope: MutableScope, node: Parser.Identifier): Symbol {
    const name = identifierName(node);
    const symbol: Symbol = {
      id: nextSymbolId++,
      name,
      kind: "label",
      scope,
      declaration: node,
      references: [],
    };
    scope.symbols.push(symbol);
    scope.labels.set(name, symbol);
    allSymbols.push(symbol);
    identifierSymbols.set(node, symbol);
    return symbol;
  }

  function lookupBinding(
    scope: MutableScope,
    name: string,
  ): Symbol | undefined {
    for (let s: MutableScope | null = scope; s; s = s.parent) {
      const found = s.bindings.get(name);
      if (found) {
        return found;
      }
    }
    return undefined;
  }

  function lookupLabel(scope: MutableScope, name: string): Symbol | undefined {
    for (let s: MutableScope | null = scope; s; s = s.parent) {
      const found = s.labels.get(name);
      if (found) {
        return found;
      }
    }
    return undefined;
  }

  function reference(
    scope: MutableScope,
    node: Parser.Identifier,
    isWrite = false,
  ) {
    const name = identifierName(node);
    const symbol = lookupBinding(scope, name);
    if (symbol) {
      symbol.references.push(node);
      identifierSymbols.set(node, symbol);
      return;
    }
    let binding = globals.get(name);
    if (!binding) {
      binding = { name, references: [], writes: [] };
      globals.set(name, binding);
    }
    binding.references.push(node);
    if (isWrite) {
      binding.writes.push(node);
    }
    globalReferenceNodes.add(node);
  }

  // ラベルはブロック内での宣言位置に関わらずブロック全体から参照できる
  // （前方goto）ため、通常の宣言文と違い先読みで登録する。
  function hoistLabels(body: Parser.Statement[], scope: MutableScope) {
    body.forEach((statement) => {
      if (statement.type === "LabelStatement") {
        declareLabel(scope, statement.label);
      }
    });
  }

  function resolveBlock(body: Parser.Statement[], scope: MutableScope) {
    hoistLabels(body, scope);
    body.forEach((statement) => {
      resolveStatement(statement, scope);
    });
  }

  function resolveStatement(
    statement: Parser.Statement,
    scope: MutableScope,
  ): void {
    switch (statement.type) {
      case "LocalStatement":
        // 初期化式は新しいローカルが宣言される前の束縛で解決する
        // （`local x = x` の右辺は外側のxを指す）
        statement.init.forEach((expr) => {
          resolveExpression(expr, scope);
        });
        statement.variables.forEach((v) => declare(scope, v, "local"));
        return;
      case "AssignmentStatement":
        statement.init.forEach((expr) => {
          resolveExpression(expr, scope);
        });
        statement.variables.forEach((v) => {
          if (v.type === "Identifier") {
            reference(scope, v, true);
          } else {
            resolveExpression(v, scope);
          }
        });
        return;
      case "CallStatement":
        resolveExpression(statement.expression, scope);
        return;
      case "DoStatement": {
        const inner = createScope("block", scope);
        resolveBlock(statement.body, inner);
        return;
      }
      case "WhileStatement": {
        resolveExpression(statement.condition, scope);
        const inner = createScope("block", scope);
        resolveBlock(statement.body, inner);
        return;
      }
      case "RepeatStatement": {
        // `until`の条件式は本体で宣言されたローカルを参照できる
        const inner = createScope("block", scope);
        resolveBlock(statement.body, inner);
        resolveExpression(statement.condition, inner);
        return;
      }
      case "IfStatement":
        statement.clauses.forEach((clause) => {
          if (clause.type !== "ElseClause") {
            resolveExpression(clause.condition, scope);
          }
          const inner = createScope("block", scope);
          resolveBlock(clause.body, inner);
        });
        return;
      case "ForNumericStatement": {
        resolveExpression(statement.start, scope);
        resolveExpression(statement.end, scope);
        if (statement.step) {
          resolveExpression(statement.step, scope);
        }
        const inner = createScope("block", scope);
        declare(inner, statement.variable, "for");
        resolveBlock(statement.body, inner);
        return;
      }
      case "ForGenericStatement": {
        statement.iterators.forEach((iterator) => {
          resolveExpression(iterator, scope);
        });
        const inner = createScope("block", scope);
        statement.variables.forEach((v) => declare(inner, v, "for"));
        resolveBlock(statement.body, inner);
        return;
      }
      case "FunctionDeclaration":
        resolveFunctionDeclaration(statement, scope);
        return;
      case "ReturnStatement":
        statement.arguments.forEach((argument) => {
          resolveExpression(argument, scope);
        });
        return;
      case "BreakStatement":
        return;
      case "LabelStatement":
        // hoistLabelsで宣言済みのため、ここでは何もしない
        return;
      case "GotoStatement": {
        const symbol = lookupLabel(scope, identifierName(statement.label));
        if (symbol) {
          symbol.references.push(statement.label);
          identifierSymbols.set(statement.label, symbol);
        }
        return;
      }
      default: {
        const exhaustive: never = statement;
        throw new TypeError(
          "Unknown statement type: `" + JSON.stringify(exhaustive) + "`",
        );
      }
    }
  }

  function resolveFunctionDeclaration(
    fn: Parser.FunctionDeclaration,
    scope: MutableScope,
  ) {
    if (fn.identifier) {
      if (fn.identifier.type === "Identifier") {
        if (fn.isLocal) {
          // `local function`は再帰呼び出しのため、本体を解決する前に自身を宣言する
          declare(scope, fn.identifier, "local");
        } else {
          // 非local: 既存のローカル/グローバルへの代入として扱う（新規宣言ではない）
          reference(scope, fn.identifier, true);
        }
      } else {
        resolveExpression(fn.identifier, scope);
      }
    }
    const inner = createScope("function", scope);
    functionScopes.set(fn, inner);
    fn.parameters.forEach((parameter) => {
      if (parameter.type === "Identifier") {
        declare(inner, parameter, "param");
      }
    });
    resolveBlock(fn.body, inner);
  }

  function resolveExpression(
    expr: Parser.Expression,
    scope: MutableScope,
  ): void {
    switch (expr.type) {
      case "Identifier":
        reference(scope, expr);
        return;
      case "StringLiteral":
      case "NumericLiteral":
      case "BooleanLiteral":
      case "NilLiteral":
      case "VarargLiteral":
        return;
      case "LogicalExpression":
      case "BinaryExpression":
        resolveExpression(expr.left, scope);
        resolveExpression(expr.right, scope);
        return;
      case "UnaryExpression":
        resolveExpression(expr.argument, scope);
        return;
      case "CallExpression":
        resolveExpression(expr.base, scope);
        expr.arguments.forEach((argument) => {
          resolveExpression(argument, scope);
        });
        return;
      case "TableCallExpression":
        resolveExpression(expr.base, scope);
        resolveExpression(expr.arguments, scope);
        return;
      case "StringCallExpression":
        resolveExpression(expr.base, scope);
        resolveExpression(expr.argument, scope);
        return;
      case "IndexExpression":
        resolveExpression(expr.base, scope);
        resolveExpression(expr.index, scope);
        return;
      case "MemberExpression":
        resolveExpression(expr.base, scope);
        // フィールド名（`.identifier`）は変数参照ではないため解決しない
        return;
      case "FunctionDeclaration": {
        const inner = createScope("function", scope);
        functionScopes.set(expr, inner);
        expr.parameters.forEach((parameter) => {
          if (parameter.type === "Identifier") {
            declare(inner, parameter, "param");
          }
        });
        resolveBlock(expr.body, inner);
        return;
      }
      case "TableConstructorExpression":
        expr.fields.forEach((field) => {
          if (field.type === "TableKey") {
            resolveExpression(field.key, scope);
            resolveExpression(field.value, scope);
          } else if (field.type === "TableValue") {
            resolveExpression(field.value, scope);
          } else {
            // TableKeyString: キー名（`{ key = value }`のkey）は変数参照ではない
            resolveExpression(field.value, scope);
          }
        });
        return;
      default: {
        const exhaustive: never = expr;
        throw new TypeError(
          "Unknown expression type: `" + JSON.stringify(exhaustive) + "`",
        );
      }
    }
  }

  const chunkScope = createScope("chunk", null);
  resolveBlock(chunk.body, chunkScope);

  return {
    chunkScope,
    symbols: allSymbols,
    globals,
    symbolOf: (identifier) => identifierSymbols.get(identifier),
    isGlobalReference: (identifier) => globalReferenceNodes.has(identifier),
    scopeOfFunction: (fn) => functionScopes.get(fn),
  };
}
