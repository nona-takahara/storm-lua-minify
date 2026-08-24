import Parser from "luaparse";
import { walkExpression } from "./astWalk";
import { GlobalBinding, ResolveResult, Symbol } from "./resolver";

export type BindingReference =
  | { readonly kind: "symbol"; readonly symbol: Symbol }
  | { readonly kind: "global"; readonly binding: GlobalBinding };

export interface BindingEffect {
  readonly kind: "binding";
  readonly access: "declare" | "read" | "write";
  readonly binding: BindingReference;
  readonly identifier: Parser.Identifier;
  // owner内のfactsは全順序を表さない。Luaが評価順を規定しない部分を、
  // plannerが配列順だけで並べ替え可能と判断しないための境界である。
  readonly owner: Parser.Node;
}

export interface EffectAnalysis {
  readonly effects: readonly BindingEffect[];
  effectsOf(owner: Parser.Node): readonly BindingEffect[];
  accessesOf(symbol: Symbol): readonly BindingEffect[];
}

/**
 * 名前解決済みASTから、bindingに対する構文上の一次事実だけを収集する。
 * escape/dirty等の推論は、変換ごとに必要な保守性が異なるため後段で行う。
 */
export function analyzeBindingEffects(
  chunk: Parser.Chunk,
  resolved: ResolveResult,
): EffectAnalysis {
  const effects: BindingEffect[] = [];
  const byOwner = new WeakMap<Parser.Node, BindingEffect[]>();
  const bySymbol = new Map<Symbol, BindingEffect[]>();

  function bindingOf(identifier: Parser.Identifier): BindingReference {
    const symbol = resolved.symbolOf(identifier);
    if (symbol) return { kind: "symbol", symbol };
    if (resolved.isGlobalReference(identifier)) {
      const binding = resolved.globals.get(identifier.name);
      if (binding) return { kind: "global", binding };
    }
    throw new TypeError(
      "Identifier is neither a binding nor a global reference",
    );
  }

  function record(
    access: BindingEffect["access"],
    identifier: Parser.Identifier,
    owner: Parser.Node,
  ): void {
    const binding = bindingOf(identifier);
    const effect: BindingEffect = {
      kind: "binding",
      access,
      binding,
      identifier,
      owner,
    };
    effects.push(effect);
    const ownerEffects = byOwner.get(owner) ?? [];
    ownerEffects.push(effect);
    byOwner.set(owner, ownerEffects);
    if (binding.kind === "symbol") {
      const symbolEffects = bySymbol.get(binding.symbol) ?? [];
      symbolEffects.push(effect);
      bySymbol.set(binding.symbol, symbolEffects);
    }
  }

  function analyzeFunction(fn: Parser.FunctionDeclaration): void {
    fn.parameters.forEach((parameter) => {
      if (parameter.type === "Identifier") {
        record("declare", parameter, fn);
      }
    });
    analyzeBlock(fn.body);
  }

  function recordReads(
    expression: Parser.Expression,
    owner: Parser.Node,
  ): void {
    walkExpression(expression, {
      onIdentifierReference: (identifier) => {
        record("read", identifier, owner);
      },
      onFunction: analyzeFunction,
    });
  }

  function analyzeStatement(statement: Parser.Statement): void {
    switch (statement.type) {
      case "LocalStatement":
        statement.init.forEach((expression) => {
          recordReads(expression, statement);
        });
        statement.variables.forEach((variable) => {
          record("declare", variable, statement);
        });
        return;
      case "AssignmentStatement":
        statement.init.forEach((expression) => {
          recordReads(expression, statement);
        });
        statement.variables.forEach((variable) => {
          if (variable.type === "Identifier") {
            record("write", variable, statement);
          } else {
            // base/indexの評価はheap writeとは別のbinding readである。
            recordReads(variable, statement);
          }
        });
        return;
      case "CallStatement":
        recordReads(statement.expression, statement);
        return;
      case "DoStatement":
        analyzeBlock(statement.body);
        return;
      case "WhileStatement":
        recordReads(statement.condition, statement);
        analyzeBlock(statement.body);
        return;
      case "RepeatStatement":
        analyzeBlock(statement.body);
        recordReads(statement.condition, statement);
        return;
      case "IfStatement":
        statement.clauses.forEach((clause) => {
          if (clause.type !== "ElseClause") {
            recordReads(clause.condition, statement);
          }
          analyzeBlock(clause.body);
        });
        return;
      case "ForNumericStatement":
        recordReads(statement.start, statement);
        recordReads(statement.end, statement);
        if (statement.step) recordReads(statement.step, statement);
        record("declare", statement.variable, statement);
        analyzeBlock(statement.body);
        return;
      case "ForGenericStatement":
        statement.iterators.forEach((iterator) => {
          recordReads(iterator, statement);
        });
        statement.variables.forEach((variable) => {
          record("declare", variable, statement);
        });
        analyzeBlock(statement.body);
        return;
      case "FunctionDeclaration":
        if (statement.identifier) {
          if (statement.identifier.type === "Identifier") {
            record(
              statement.isLocal ? "declare" : "write",
              statement.identifier,
              statement,
            );
          } else {
            recordReads(statement.identifier, statement);
          }
        }
        analyzeFunction(statement);
        return;
      case "ReturnStatement":
        statement.arguments.forEach((argument) => {
          recordReads(argument, statement);
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

  function analyzeBlock(body: Parser.Statement[]): void {
    body.forEach(analyzeStatement);
  }

  analyzeBlock(chunk.body);
  return {
    effects,
    effectsOf: (owner) => byOwner.get(owner) ?? [],
    accessesOf: (symbol) => bySymbol.get(symbol) ?? [],
  };
}
