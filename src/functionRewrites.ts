import Parser from "luaparse";
import { CallGraphAnalysis } from "./callGraph";
import { SourceMetadata } from "./sourceMetadata";

export interface FunctionRewriteResult {
  readonly changed: boolean;
  readonly prunedParameters: number;
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
