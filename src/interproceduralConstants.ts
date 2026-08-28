import Parser from "luaparse";
import { InterproceduralAnalysis } from "./interproceduralAnalysis";
import { OptimizerValueAtom } from "./optimizerValueDomain";

/**
 * Replace a direct, pure, single-return call with its proven scalar result.
 *
 * This is intentionally narrower than #76 inlining. It accepts only a one-statement return body,
 * no actual arguments, a non-recursive target, and a literal no longer than the shortest possible
 * renamed `a()` call. Thus evaluation can be removed without alpha conversion and without relying
 * on later function DCE to make the local rewrite profitable.
 */
export function propagateInterproceduralConstants(
  chunk: Parser.Chunk,
  analysis: InterproceduralAnalysis,
): boolean {
  let changed = false;

  const replacementOf = (
    expression: Parser.Expression,
  ): Parser.Expression | undefined => {
    if (
      expression.type !== "CallExpression" ||
      expression.arguments.length !== 0 ||
      expression.base.type !== "Identifier"
    )
      return undefined;
    const call = analysis.callGraph.callSiteOf(expression);
    if (!call || call.hasUnknownTarget || call.targets.size !== 1)
      return undefined;
    const target = [...call.targets][0];
    if (
      analysis.callGraph.sccs.some(
        (scc) => scc.recursive && scc.functions.includes(target),
      ) ||
      target.declaration.body.length !== 1 ||
      target.declaration.body[0].type !== "ReturnStatement"
    )
      return undefined;
    const summary = analysis.summaryOf(target);
    if (
      summary.effects.length > 0 ||
      summary.escapes.length > 0 ||
      summary.externalEffects.length > 0 ||
      summary.mayError ||
      summary.mayInvokeMetamethod ||
      summary.returns.prefix.length !== 1 ||
      summary.returns.tail.kind !== "none"
    )
      return undefined;
    const value = summary.returns.prefix[0];
    if (value.unknownReasons.length > 0 || value.atoms.length !== 1)
      return undefined;
    const replacement = literalOf(value.atoms[0], expression);
    if (!replacement || printedLength(replacement) > 3) return undefined;
    return replacement;
  };

  const rewriteBlock = (body: Parser.Statement[]): void => {
    body.forEach((statement) => {
      if (
        (statement.type === "LocalStatement" ||
          statement.type === "AssignmentStatement") &&
        statement.variables.length === 1 &&
        statement.init.length === 1
      ) {
        const replacement = replacementOf(statement.init[0]);
        if (replacement) {
          statement.init[0] = replacement;
          changed = true;
        }
      }
      switch (statement.type) {
        case "DoStatement":
        case "WhileStatement":
        case "RepeatStatement":
        case "FunctionDeclaration":
        case "ForNumericStatement":
        case "ForGenericStatement":
          rewriteBlock(statement.body);
          return;
        case "IfStatement":
          statement.clauses.forEach((clause) => {
            rewriteBlock(clause.body);
          });
          return;
        default:
          return;
      }
    });
  };
  rewriteBlock(chunk.body);
  return changed;
}

function literalOf(
  atom: OptimizerValueAtom,
  source: Parser.Expression,
): Parser.Expression | undefined {
  const metadata = {
    ...(source.loc ? { loc: source.loc } : {}),
    ...("range" in source
      ? { range: (source as { range?: [number, number] }).range }
      : {}),
  };
  switch (atom.kind) {
    case "nil":
      return { type: "NilLiteral", value: null, raw: "nil", ...metadata };
    case "boolean":
      return {
        type: "BooleanLiteral",
        value: atom.value,
        raw: atom.value ? "true" : "false",
        ...metadata,
      };
    case "number":
      return {
        type: "NumericLiteral",
        value: Number(atom.raw),
        raw: atom.raw,
        ...metadata,
      };
    case "string": {
      const raw = JSON.stringify(atom.value);
      return { type: "StringLiteral", value: atom.value, raw, ...metadata };
    }
    default:
      return undefined;
  }
}

function printedLength(expression: Parser.Expression): number {
  switch (expression.type) {
    case "NilLiteral":
    case "BooleanLiteral":
    case "NumericLiteral":
    case "StringLiteral":
      return expression.raw.length;
    default:
      return Infinity;
  }
}
