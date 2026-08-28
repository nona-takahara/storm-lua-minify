import Parser from "luaparse";
import { CallGraphAnalysis } from "./callGraph";
import { walkExpression, walkStatement } from "./astWalk";
import { InterproceduralAnalysis } from "./interproceduralAnalysis";
import { ResolveResult, Scope, Symbol } from "./resolver";
import { SourceMetadata } from "./sourceMetadata";
import { copyNodeOrigin } from "./generatedNode";

export interface FunctionRewriteResult {
  readonly changed: boolean;
  readonly prunedParameters: number;
  readonly prunedMethodParameters: number;
}

export interface InlineRewriteResult {
  readonly changed: boolean;
  readonly inlinedFunctions: number;
}

export interface StatementInlineRewriteResult {
  readonly changed: boolean;
  readonly inlinedFunctions: number;
}

export interface BoundStatementInlineOptions {
  readonly maxIntroducedLocalsAt: (statement: Parser.Statement) => number;
}

type PrimitiveLiteral =
  | Parser.StringLiteral
  | Parser.NumericLiteral
  | Parser.BooleanLiteral
  | Parser.NilLiteral;

/**
 * Remove only the trailing, identifier parameters proven unused by Resolve.
 *
 * Call arguments deliberately remain untouched: Lua evaluates surplus actuals in
 * their original order and then discards them, which preserves their effects,
 * errors, and multiple-value adjustment. A vararg tail is therefore a hard
 * boundary rather than something this rewrite tries to reason around.
 */
export function pruneTrailingUnusedParameters(
  callGraph: CallGraphAnalysis,
  metadata: SourceMetadata,
  canRewrite: (
    callable: CallGraphAnalysis["functions"][number],
  ) => boolean = () => true,
): FunctionRewriteResult {
  let prunedParameters = 0;
  let prunedMethodParameters = 0;

  callGraph.functions.forEach((callable) => {
    if (!canRewrite(callable)) return;
    const declaration = callable.declaration;
    if (metadata.annotationsOf(declaration).keep) return;

    let retained = declaration.parameters.length;
    while (retained > 0) {
      const parameter = declaration.parameters[retained - 1];
      if (parameter.type !== "Identifier") break;
      const symbol = callable.parameters.find(
        (candidate) => candidate.declaration === parameter,
      );
      if (!symbol || symbol.references.length > 0) break;
      retained--;
    }

    if (retained === declaration.parameters.length) return;
    const removed = declaration.parameters.length - retained;
    prunedParameters += removed;
    if (
      declaration.identifier?.type === "MemberExpression" &&
      declaration.identifier.indexer === ":"
    )
      prunedMethodParameters += removed;
    declaration.parameters = declaration.parameters.slice(0, retained);
  });

  return {
    changed: prunedParameters > 0,
    prunedParameters,
    prunedMethodParameters,
  };
}

function overwriteExpression(
  target: Parser.Expression,
  replacement: Parser.Expression,
): void {
  // Visitors dispatch exclusively on `type`; fields from the former node are
  // inert after this assignment and do not need an unsafe dynamic deletion.
  Object.assign(target, replacement);
}

function isClosedInlineExpression(
  expression: Parser.Expression,
  resolved: ResolveResult,
): boolean {
  let closed = true;
  walkExpression(expression, {
    onIdentifierReference: (identifier) => {
      if (resolved.symbolOf(identifier)) closed = false;
    },
    onFunction: () => {
      closed = false;
    },
  });
  return closed;
}

function primitiveLiteral(
  expression: Parser.Expression | undefined,
): PrimitiveLiteral | undefined {
  if (!expression) return { type: "NilLiteral", value: null, raw: "nil" };
  switch (expression.type) {
    case "StringLiteral":
    case "NumericLiteral":
    case "BooleanLiteral":
    case "NilLiteral":
      return expression;
    default:
      return undefined;
  }
}

function substituteParameters(
  expression: Parser.Expression,
  replacements: ReadonlyMap<string, PrimitiveLiteral>,
): Parser.Expression {
  const clone = structuredClone(expression);
  const substitute = (
    original: Parser.Expression,
    copied: Parser.Expression,
  ): void => {
    if (original.type !== copied.type)
      throw new Error("Cloned expression changed node type");
    switch (original.type) {
      case "Identifier": {
        const replacement = replacements.get(original.name);
        if (replacement)
          overwriteExpression(copied, structuredClone(replacement));
        return;
      }
      case "StringLiteral":
      case "NumericLiteral":
      case "BooleanLiteral":
      case "NilLiteral":
      case "VarargLiteral":
        return;
      case "LogicalExpression":
      case "BinaryExpression": {
        const binary = copied as Parser.BinaryExpression;
        substitute(original.left, binary.left);
        substitute(original.right, binary.right);
        return;
      }
      case "UnaryExpression":
        substitute(
          original.argument,
          (copied as Parser.UnaryExpression).argument,
        );
        return;
      case "CallExpression": {
        const call = copied as Parser.CallExpression;
        substitute(original.base, call.base);
        original.arguments.forEach((argument, index) => {
          substitute(argument, call.arguments[index]);
        });
        return;
      }
      case "TableCallExpression": {
        const call = copied as Parser.TableCallExpression;
        substitute(original.base, call.base);
        substitute(original.arguments, call.arguments);
        return;
      }
      case "StringCallExpression": {
        const call = copied as Parser.StringCallExpression;
        substitute(original.base, call.base);
        substitute(original.argument, call.argument);
        return;
      }
      case "IndexExpression": {
        const index = copied as Parser.IndexExpression;
        substitute(original.base, index.base);
        substitute(original.index, index.index);
        return;
      }
      case "MemberExpression":
        substitute(original.base, (copied as Parser.MemberExpression).base);
        return;
      case "TableConstructorExpression": {
        const table = copied as Parser.TableConstructorExpression;
        original.fields.forEach((field, index) => {
          const copiedField = table.fields[index];
          if (field.type === "TableKey") {
            if (copiedField.type !== "TableKey")
              throw new Error("Cloned table field changed node type");
            substitute(field.key, copiedField.key);
          }
          substitute(field.value, copiedField.value);
        });
        return;
      }
      case "FunctionDeclaration":
        throw new Error("Nested functions are not substitutable");
    }
  };
  substitute(expression, clone);
  return clone;
}

function onlyParametersOrGlobals(
  expression: Parser.Expression,
  resolved: ResolveResult,
  parameterNames: ReadonlySet<string>,
): boolean {
  let safe = true;
  walkExpression(expression, {
    onIdentifierReference: (identifier) => {
      const symbol = resolved.symbolOf(identifier);
      if (symbol && !parameterNames.has(symbol.name)) safe = false;
    },
    onFunction: () => {
      safe = false;
    },
  });
  return safe;
}

/**
 * Inline the first deliberately narrow class whose binding proof is complete:
 * a zero-argument, single-use local function returning one closed expression.
 * Closed means every identifier is global; local/upvalue references wait for
 * symbol-level alpha conversion instead of being guessed from their spelling.
 */
export function inlineClosedSingleUseFunctions(
  analysis: InterproceduralAnalysis,
  resolved: ResolveResult,
  metadata: SourceMetadata,
): InlineRewriteResult {
  let inlinedFunctions = 0;

  analysis.callGraph.functions.forEach((callable) => {
    const declaration = callable.declaration;
    const symbol = callable.symbol;
    if (
      !symbol ||
      !declaration.isLocal ||
      declaration.parameters.length !== 0 ||
      declaration.body.length !== 1 ||
      symbol.references.length !== 1 ||
      metadata.annotationsOf(declaration).keep
    )
      return;

    const returned = declaration.body[0];
    if (returned.type !== "ReturnStatement" || returned.arguments.length !== 1)
      return;
    const expression = returned.arguments[0];
    if (!isClosedInlineExpression(expression, resolved)) return;

    const site = analysis.callGraph.calls.find(
      (candidate) =>
        !candidate.hasUnknownTarget &&
        candidate.targets.size === 1 &&
        candidate.targets.has(callable) &&
        candidate.call.type === "CallExpression" &&
        candidate.call.arguments.length === 0 &&
        candidate.call.base === symbol.references[0],
    );
    if (!site) return;

    // structuredClone retains loc/range on every copied node, so the inlined
    // expression maps to the function body/return origin rather than call-site text.
    overwriteExpression(site.call, structuredClone(expression));
    inlinedFunctions++;
  });

  return { changed: inlinedFunctions > 0, inlinedFunctions };
}

/** Inline a single-return function when every actual is an immutable literal. */
export function inlineLiteralArgumentFunctions(
  analysis: InterproceduralAnalysis,
  resolved: ResolveResult,
  metadata: SourceMetadata,
): InlineRewriteResult {
  let inlinedFunctions = 0;

  analysis.callGraph.functions.forEach((callable) => {
    const declaration = callable.declaration;
    const symbol = callable.symbol;
    if (
      !symbol ||
      !declaration.isLocal ||
      declaration.parameters.length === 0 ||
      declaration.parameters.some(
        (parameter) => parameter.type !== "Identifier",
      ) ||
      declaration.body.length !== 1 ||
      symbol.references.length !== 1 ||
      metadata.annotationsOf(declaration).keep
    )
      return;
    const returned = declaration.body[0];
    if (returned.type !== "ReturnStatement" || returned.arguments.length !== 1)
      return;

    const site = analysis.callGraph.calls.find(
      (candidate) =>
        !candidate.hasUnknownTarget &&
        candidate.targets.size === 1 &&
        candidate.targets.has(callable) &&
        candidate.call.type === "CallExpression" &&
        candidate.call.arguments.length <= declaration.parameters.length &&
        candidate.call.base === symbol.references[0],
    );
    if (!site || site.call.type !== "CallExpression") return;

    const replacements = new Map<string, PrimitiveLiteral>();
    for (let index = 0; index < declaration.parameters.length; index++) {
      const parameter = declaration.parameters[index];
      if (parameter.type !== "Identifier") return;
      const actual = primitiveLiteral(site.call.arguments[index]);
      if (!actual) return;
      replacements.set(parameter.name, actual);
    }
    if (
      !onlyParametersOrGlobals(
        returned.arguments[0],
        resolved,
        new Set(replacements.keys()),
      )
    )
      return;

    overwriteExpression(
      site.call,
      substituteParameters(returned.arguments[0], replacements),
    );
    inlinedFunctions++;
  });

  return { changed: inlinedFunctions > 0, inlinedFunctions };
}

function statementChildren(statement: Parser.Statement): Parser.Statement[][] {
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

function replaceStatement(
  body: Parser.Statement[],
  target: Parser.Statement,
  replacements: Parser.Statement[],
): boolean {
  const index = body.indexOf(target);
  if (index >= 0) {
    body.splice(index, 1, ...replacements);
    return true;
  }
  return body.some((statement) =>
    statementChildren(statement).some((child) =>
      replaceStatement(child, target, replacements),
    ),
  );
}

function isClosedInlineStatement(
  statement: Parser.Statement,
  resolved: ResolveResult,
): boolean {
  let closed = true;
  const inspect = (expression: Parser.Expression) => {
    if (!isClosedInlineExpression(expression, resolved)) closed = false;
  };
  switch (statement.type) {
    case "AssignmentStatement":
      statement.variables.forEach(inspect);
      statement.init.forEach(inspect);
      return closed;
    case "CallStatement":
      inspect(statement.expression);
      return closed;
    default:
      return false;
  }
}

function hasFunctionScopeAncestor(
  symbolScope: Scope,
  functionScope: Scope,
): boolean {
  for (let scope: Scope | null = symbolScope; scope; scope = scope.parent) {
    if (scope === functionScope) return true;
  }
  return false;
}

function bodyUsesOnlyOwnedBindings(
  body: readonly Parser.Statement[],
  resolved: ResolveResult,
  functionScope: Scope,
  allowReturns = false,
): boolean {
  let safe = true;
  const visitBlock = (statements: readonly Parser.Statement[]): void => {
    statements.forEach((statement) => {
      if (statement.type === "FunctionDeclaration") {
        safe = false;
        return;
      }
      if (statement.type === "ReturnStatement" && !allowReturns) {
        safe = false;
        return;
      }
      walkStatementForOwnedBindings(statement);
    });
  };
  const walkStatementForOwnedBindings = (statement: Parser.Statement): void => {
    walkStatement(statement, {
      onIdentifierReference: (identifier) => {
        const symbol = resolved.symbolOf(identifier);
        if (symbol && !hasFunctionScopeAncestor(symbol.scope, functionScope))
          safe = false;
      },
      onFunction: () => {
        safe = false;
      },
      onBlock: visitBlock,
    });
  };
  visitBlock(body);
  return safe;
}

function ownedLocalCount(
  resolved: ResolveResult,
  functionScope: Scope,
): number {
  return resolved.symbols.filter(
    (symbol) =>
      symbol.kind !== "label" &&
      hasFunctionScopeAncestor(symbol.scope, functionScope),
  ).length;
}

/**
 * Rename copied callee-owned bindings by resolved symbol identity. This keeps
 * declarations and references paired even when the call site has same-spelled
 * locals, and avoids treating field names as lexical bindings.
 */
function alphaConvertOwnedCopies(
  originals: readonly unknown[],
  copies: readonly unknown[],
  resolved: ResolveResult,
  functionScope: Scope,
): void {
  const owned = new Set(
    resolved.symbols.filter((symbol) =>
      hasFunctionScopeAncestor(symbol.scope, functionScope),
    ),
  );
  const unavailable = new Set([
    ...resolved.symbols.map((symbol) => symbol.name),
    ...resolved.globals.keys(),
  ]);
  const replacementNames = new Map<Symbol, string>();
  let nextName = 0;

  const nameOf = (symbol: Symbol): string => {
    const existing = replacementNames.get(symbol);
    if (existing !== undefined) return existing;
    let candidate: string;
    do {
      candidate = `__stormInline${String(nextName++)}`;
    } while (unavailable.has(candidate));
    unavailable.add(candidate);
    replacementNames.set(symbol, candidate);
    return candidate;
  };

  const visitPair = (original: unknown, copy: unknown): void => {
    if (
      !original ||
      !copy ||
      typeof original !== "object" ||
      typeof copy !== "object"
    )
      return;
    if (Array.isArray(original)) {
      if (!Array.isArray(copy)) return;
      original.forEach((value, index) => {
        visitPair(value, copy[index]);
      });
      return;
    }
    if ((original as Parser.Node).type === "Identifier") {
      if ((copy as Parser.Node).type !== "Identifier") return;
      const symbol = resolved.symbolOf(original as Parser.Identifier);
      if (symbol && owned.has(symbol))
        (copy as Parser.Identifier).name = nameOf(symbol);
      return;
    }
    Object.keys(original).forEach((key) => {
      visitPair(
        (original as Record<string, unknown>)[key],
        (copy as Record<string, unknown>)[key],
      );
    });
  };

  visitPair(originals, copies);
}

/** Inline a straight-line, closed function body at a statement call site. */
export function inlineClosedStatementFunctions(
  chunk: Parser.Chunk,
  analysis: InterproceduralAnalysis,
  resolved: ResolveResult,
  metadata: SourceMetadata,
): StatementInlineRewriteResult {
  let inlinedFunctions = 0;

  analysis.callGraph.functions.forEach((callable) => {
    const declaration = callable.declaration;
    const symbol = callable.symbol;
    if (
      !symbol ||
      !declaration.isLocal ||
      declaration.parameters.length !== 0 ||
      symbol.references.length !== 1 ||
      metadata.annotationsOf(declaration).keep
    )
      return;

    const executable = [...declaration.body];
    const tail = executable.at(-1);
    if (tail?.type === "ReturnStatement" && tail.arguments.length === 0)
      executable.pop();
    if (
      executable.length === 0 ||
      executable.some(
        (statement) =>
          metadata.annotationsOf(statement).keep ||
          !isClosedInlineStatement(statement, resolved),
      )
    )
      return;

    const site = analysis.callGraph.calls.find(
      (candidate) =>
        candidate.owner.type === "CallStatement" &&
        candidate.owner.expression === candidate.call &&
        !candidate.hasUnknownTarget &&
        candidate.targets.size === 1 &&
        candidate.targets.has(callable) &&
        candidate.call.type === "CallExpression" &&
        candidate.call.arguments.length === 0 &&
        candidate.call.base === symbol.references[0],
    );
    if (!site) return;

    const replacements = executable.map((statement) =>
      structuredClone(statement),
    );
    if (!replaceStatement(chunk.body, site.owner, replacements)) return;
    metadata.replaceStatement(site.owner, replacements);
    executable.forEach((source, index) => {
      metadata.transferStatements([source], replacements[index]);
    });
    inlinedFunctions++;
  });

  return { changed: inlinedFunctions > 0, inlinedFunctions };
}

/**
 * Inline a non-returning statement function behind a lexical block and a
 * parameter-binding local. The binding statement is the semantic boundary:
 * arbitrary actuals keep Lua's original left-to-right evaluation and tuple
 * adjustment before the copied body starts.
 */
export function inlineBoundStatementFunctions(
  chunk: Parser.Chunk,
  analysis: InterproceduralAnalysis,
  resolved: ResolveResult,
  metadata: SourceMetadata,
  options: BoundStatementInlineOptions,
): StatementInlineRewriteResult {
  let inlinedFunctions = 0;

  analysis.callGraph.functions.forEach((callable) => {
    const declaration = callable.declaration;
    const symbol = callable.symbol;
    const functionScope = resolved.scopeOfFunction(declaration);
    if (
      !symbol ||
      !functionScope ||
      !declaration.isLocal ||
      declaration.parameters.length === 0 ||
      declaration.parameters.some(
        (parameter) => parameter.type !== "Identifier",
      ) ||
      symbol.references.length !== 1 ||
      metadata.annotationsOf(declaration).keep
    )
      return;

    const executable = [...declaration.body];
    const tail = executable.at(-1);
    if (tail?.type === "ReturnStatement" && tail.arguments.length === 0)
      executable.pop();
    if (
      executable.length === 0 ||
      executable.some((statement) => metadata.annotationsOf(statement).keep) ||
      !bodyUsesOnlyOwnedBindings(executable, resolved, functionScope)
    )
      return;

    const site = analysis.callGraph.calls.find(
      (candidate) =>
        candidate.owner.type === "CallStatement" &&
        candidate.owner.expression === candidate.call &&
        !candidate.hasUnknownTarget &&
        candidate.targets.size === 1 &&
        candidate.targets.has(callable) &&
        candidate.call.type === "CallExpression" &&
        candidate.call.base === symbol.references[0],
    );
    if (!site || site.call.type !== "CallExpression") return;
    if (
      declaration.parameters.length > options.maxIntroducedLocalsAt(site.owner)
    )
      return;

    const binding: Parser.LocalStatement = {
      type: "LocalStatement",
      variables: declaration.parameters.map((parameter) =>
        structuredClone(parameter as Parser.Identifier),
      ),
      init: site.call.arguments.map((argument) => structuredClone(argument)),
    };
    copyNodeOrigin(binding, site.owner);
    const copiedBody = executable.map((statement) =>
      structuredClone(statement),
    );
    alphaConvertOwnedCopies(
      [...declaration.parameters, ...executable],
      [...binding.variables, ...copiedBody],
      resolved,
      functionScope,
    );
    const replacement: Parser.DoStatement = {
      type: "DoStatement",
      body: [binding, ...copiedBody],
    };
    copyNodeOrigin(replacement, site.owner);
    if (!replaceStatement(chunk.body, site.owner, [replacement])) return;
    metadata.replaceStatement(site.owner, [replacement]);
    executable.forEach((source, index) => {
      metadata.transferStatements([source], copiedBody[index]);
    });
    inlinedFunctions++;
  });

  return { changed: inlinedFunctions > 0, inlinedFunctions };
}

/**
 * Inline a function into `return f(...)`. Every copied callee return now exits
 * the caller, which is equivalent specifically because the call occupied the
 * caller's entire return tuple. A synthetic empty return preserves fallthrough.
 */
export function inlineTailCallFunctions(
  chunk: Parser.Chunk,
  analysis: InterproceduralAnalysis,
  resolved: ResolveResult,
  metadata: SourceMetadata,
  options: BoundStatementInlineOptions,
): StatementInlineRewriteResult {
  let inlinedFunctions = 0;

  analysis.callGraph.functions.forEach((callable) => {
    const declaration = callable.declaration;
    const symbol = callable.symbol;
    const functionScope = resolved.scopeOfFunction(declaration);
    if (
      !symbol ||
      !functionScope ||
      !declaration.isLocal ||
      declaration.parameters.some(
        (parameter) => parameter.type !== "Identifier",
      ) ||
      declaration.body.length === 0 ||
      symbol.references.length !== 1 ||
      metadata.annotationsOf(declaration).keep ||
      !bodyUsesOnlyOwnedBindings(
        declaration.body,
        resolved,
        functionScope,
        true,
      )
    )
      return;

    const site = analysis.callGraph.calls.find(
      (candidate) =>
        candidate.owner.type === "ReturnStatement" &&
        candidate.owner.arguments.length === 1 &&
        candidate.owner.arguments[0] === candidate.call &&
        !candidate.hasUnknownTarget &&
        candidate.targets.size === 1 &&
        candidate.targets.has(callable) &&
        candidate.call.type === "CallExpression" &&
        candidate.call.base === symbol.references[0],
    );
    if (!site || site.call.type !== "CallExpression") return;
    const surplusActuals = Math.max(
      0,
      site.call.arguments.length - declaration.parameters.length,
    );
    if (
      ownedLocalCount(resolved, functionScope) + surplusActuals >
      options.maxIntroducedLocalsAt(site.owner)
    )
      return;

    const body: Parser.Statement[] = [];
    let copiedParameters: Parser.Identifier[] = [];
    if (site.call.arguments.length > 0) {
      copiedParameters = declaration.parameters.map((parameter) =>
        structuredClone(parameter as Parser.Identifier),
      );
      const unavailable = new Set([
        ...resolved.symbols.map((candidate) => candidate.name),
        ...resolved.globals.keys(),
      ]);
      while (copiedParameters.length < site.call.arguments.length) {
        let index = copiedParameters.length;
        let name = `__stormDiscard${String(index)}`;
        while (unavailable.has(name)) {
          index++;
          name = `__stormDiscard${String(index)}`;
        }
        unavailable.add(name);
        copiedParameters.push({ type: "Identifier", name });
      }
      const binding: Parser.LocalStatement = {
        type: "LocalStatement",
        variables: copiedParameters,
        init: site.call.arguments.map((argument) => structuredClone(argument)),
      };
      copyNodeOrigin(binding, site.owner);
      body.push(binding);
    }
    const copiedBody = declaration.body.map((statement) =>
      structuredClone(statement),
    );
    alphaConvertOwnedCopies(
      [...declaration.parameters, ...declaration.body],
      [
        ...copiedParameters.slice(0, declaration.parameters.length),
        ...copiedBody,
      ],
      resolved,
      functionScope,
    );
    body.push(...copiedBody);
    if (declaration.body.at(-1)?.type !== "ReturnStatement") {
      const fallthrough: Parser.ReturnStatement = {
        type: "ReturnStatement",
        arguments: [],
      };
      copyNodeOrigin(fallthrough, site.owner);
      body.push(fallthrough);
    }
    const replacement: Parser.DoStatement = { type: "DoStatement", body };
    copyNodeOrigin(replacement, site.owner);
    if (!replaceStatement(chunk.body, site.owner, [replacement])) return;
    metadata.replaceStatement(site.owner, [replacement]);
    declaration.body.forEach((source, index) => {
      metadata.transferStatements([source], copiedBody[index]);
    });
    inlinedFunctions++;
  });

  return { changed: inlinedFunctions > 0, inlinedFunctions };
}
