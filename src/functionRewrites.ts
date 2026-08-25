import Parser from "luaparse";
import { CallGraphAnalysis } from "./callGraph";
import { walkExpression } from "./astWalk";
import { InterproceduralAnalysis } from "./interproceduralAnalysis";
import { ResolveResult } from "./resolver";
import { SourceMetadata } from "./sourceMetadata";

export interface FunctionRewriteResult {
  readonly changed: boolean;
  readonly prunedParameters: number;
}

export interface InlineRewriteResult {
  readonly changed: boolean;
  readonly inlinedFunctions: number;
}

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
): FunctionRewriteResult {
  let prunedParameters = 0;

  callGraph.functions.forEach((callable) => {
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
    prunedParameters += declaration.parameters.length - retained;
    declaration.parameters = declaration.parameters.slice(0, retained) as (
      Parser.Identifier | Parser.VarargLiteral
    )[];
  });

  return {
    changed: prunedParameters > 0,
    prunedParameters,
  };
}

function overwriteExpression(
  target: Parser.Expression,
  replacement: Parser.Expression,
): void {
  Object.keys(target).forEach((key) => {
    delete (target as unknown as Record<string, unknown>)[key];
  });
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
  return closed && expression.type !== "VarargLiteral";
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
