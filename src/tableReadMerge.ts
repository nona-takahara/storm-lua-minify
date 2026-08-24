import Parser from "luaparse";
import { AstWalkVisitor, walkStatement } from "./astWalk";
import { copyNodeOrigin } from "./generatedNode";
import { SourceMetadata } from "./sourceMetadata";
import { TransformResult } from "./optimizerPass";
import { childStatementBodies } from "./controlFlow";
import { TableEffect, TableEffectAnalysis } from "./tableEffects";
import {
  OptimizationDiagnosticReason,
  OptimizationDiagnosticSink,
} from "./optimizerDiagnostics";
import { decodeLuaStringLiteral } from "./luaString";
import { RuntimeProfile } from "./runtimeEnvironment";

export interface TableReadMergeGroup {
  readonly body: Parser.Statement[];
  readonly statements: readonly Parser.LocalStatement[];
  readonly indexes: readonly number[];
  readonly reads: readonly TableEffect[];
  readonly estimatedByteSavings: number;
}

export interface TableReadMergePlan {
  readonly groups: readonly TableReadMergeGroup[];
}

export interface TableReadMergeOptions {
  readonly dirtyGranularity: "table" | "static-key";
  readonly canMoveStatement?: (statement: Parser.LocalStatement) => boolean;
  readonly maxMergeArity?: number;
  readonly maxMergeArityAt?: (statement: Parser.LocalStatement) => number;
  readonly diagnostics?: OptimizationDiagnosticSink;
  readonly moduleName?: string;
  readonly runtimeProfile?: RuntimeProfile;
}

interface Candidate {
  readonly statement: Parser.LocalStatement;
  readonly index: number;
  readonly read: TableEffect;
}

type CandidateDecision =
  | { readonly candidate: Candidate }
  | { readonly reason: OptimizationDiagnosticReason }
  | undefined;

// Lua 5.3のlocal上限200とregister上限255の差より小さく保つ。
// static table readは単純でも、全RHSを同時評価する巨大local文を生成しない。
const DEFAULT_MAX_MERGE_ARITY = 50;

export function planTableReadMerges(
  chunk: Parser.Chunk,
  tableEffects: TableEffectAnalysis,
  options: TableReadMergeOptions,
): TableReadMergePlan {
  const groups: TableReadMergeGroup[] = [];

  function processBlock(body: Parser.Statement[]): void {
    childBlocksOf(body).forEach(processBlock);
    const indexOf = new Map<Parser.Statement, number>();
    body.forEach((statement, index) => indexOf.set(statement, index));
    let run: Candidate[] = [];

    const record = (
      decision: "accepted" | "rejected",
      reason: OptimizationDiagnosticReason,
      candidateSize: number,
      estimatedByteSavings?: number,
      estimatedOpportunityBytes?: number,
      sourceRange?: readonly [number, number],
    ) =>
      options.diagnostics?.record({
        pass: "effect-aware-table-reads",
        moduleName: options.moduleName,
        runtimeProfile: options.runtimeProfile,
        decision,
        reason,
        candidateSize,
        estimatedByteSavings,
        estimatedOpportunityBytes,
        sourceRange,
      });
    const flush = (
      rejectionReason: OptimizationDiagnosticReason = "insufficient-group",
    ) => {
      let accepted = 0;
      const policyLimit = options.maxMergeArity ?? DEFAULT_MAX_MERGE_ARITY;
      for (let start = 0; start < run.length;) {
        const maxMergeArity = Math.min(
          policyLimit,
          options.maxMergeArityAt?.(run[start].statement) ?? policyLimit,
        );
        if (maxMergeArity < 2) {
          start++;
          continue;
        }
        const part = run.slice(start, start + maxMergeArity);
        start += part.length;
        if (part.length < 2) continue;
        if (
          !part.some(
            (candidate, offset) =>
              offset > 0 && candidate.index > part[offset - 1].index + 1,
          )
        ) {
          continue;
        }
        const estimatedByteSavings = 5 * (part.length - 1);
        groups.push({
          body,
          statements: part.map((candidate) => candidate.statement),
          indexes: part.map((candidate) => candidate.index),
          reads: part.map((candidate) => candidate.read),
          // N文を1文へまとめると、2文目以降ごとに`local `と`=`の重複から
          // 変数/init間のcommaを差し引いて5 bytesずつ減る。
          estimatedByteSavings,
        });
        accepted += part.length;
        record(
          "accepted",
          "profitable-group",
          part.length,
          estimatedByteSavings,
          undefined,
          rangeOf(part[0].statement),
        );
      }
      if (run.length > accepted) {
        const rejected = run.length - accepted;
        record(
          "rejected",
          run.length > policyLimit && rejected === 1
            ? "resource-budget"
            : rejectionReason,
          rejected,
          undefined,
          Math.max(0, 5 * (rejected - 1)),
          rangeOf(run[accepted]?.statement),
        );
      }
      run = [];
    };

    body.forEach((statement, index) => {
      if (isIntervening(statement)) return;
      const decision = candidateOf(statement, index, tableEffects, options);
      if (!decision) {
        flush("control-flow-barrier");
        return;
      }
      if ("reason" in decision) {
        flush("control-flow-barrier");
        record(
          "rejected",
          decision.reason,
          1,
          undefined,
          0,
          rangeOf(statement),
        );
        return;
      }
      const candidate = decision.candidate;

      const shadowed = shadowsInterveningReference(
        body,
        run[0]?.index ?? index,
        candidate,
      );
      const stability = tableEffects.stabilityBetween(
        candidate.read.table,
        candidate.read.baseSymbol,
        run[0]?.statement ?? statement,
        statement,
      );
      const dirtyReason = tableDirtyReasonBetween(
        candidate.read,
        run[0]?.index ?? index,
        index,
        indexOf,
        tableEffects,
        options.dirtyGranularity,
      );
      if (shadowed || !stability.stable || dirtyReason) {
        flush(
          shadowed
            ? "binding-shadow-hazard"
            : !stability.stable
              ? stability.reason
              : dirtyReason,
        );
      }
      run.push(candidate);
    });
    flush();
  }

  processBlock(chunk.body);
  return { groups };
}

export function applyTableReadMergePlan(
  plan: TableReadMergePlan,
  metadata?: SourceMetadata,
): TransformResult {
  [...plan.groups].reverse().forEach((group) => {
    const combined: Parser.LocalStatement = {
      type: "LocalStatement",
      variables: group.statements.map((statement) => statement.variables[0]),
      init: group.statements.map((statement) => statement.init[0]),
    };
    copyNodeOrigin(combined, group.statements[0]);
    metadata?.transferStatements(group.statements, combined);

    for (let offset = group.indexes.length - 1; offset >= 0; offset--) {
      const index = group.indexes[offset];
      if (offset === 0) {
        group.body.splice(index, 1, combined);
      } else {
        group.body.splice(index, 1);
      }
    }
  });
  return {
    changed: plan.groups.length > 0,
    invalidatesResolve: plan.groups.length > 0,
  };
}

function candidateOf(
  statement: Parser.Statement,
  index: number,
  analysis: TableEffectAnalysis,
  options: TableReadMergeOptions,
): CandidateDecision {
  if (statement.type !== "LocalStatement") return undefined;
  if (statement.variables.length !== 1 || statement.init.length !== 1) {
    return { reason: "unsupported-shape" };
  }
  const init = statement.init[0];
  if (init.type !== "MemberExpression" && init.type !== "IndexExpression") {
    return undefined;
  }
  if (options.canMoveStatement?.(statement) === false) {
    return { reason: "metadata-preserved" };
  }
  const read = analysis.effects.find(
    (effect) => effect.access === "read" && effect.expression === init,
  );
  if (!read) return { reason: "allocation-unknown" };
  if (read.staticKey === undefined) {
    if (
      init.type === "IndexExpression" &&
      init.index.type === "StringLiteral" &&
      !decodeLuaStringLiteral(init.index).ok
    ) {
      return { reason: "unsupported-string-key" };
    }
    return { reason: "dynamic-key" };
  }
  const escapeReasons = analysis.escapeReasonsOf(read.table);
  if (escapeReasons.length > 0) {
    return { reason: escapeReasonOf(escapeReasons[0]) };
  }
  return { candidate: { statement, index, read } };
}

function isIntervening(statement: Parser.Statement): boolean {
  return (
    statement.type === "AssignmentStatement" ||
    statement.type === "CallStatement"
  );
}

function tableDirtyReasonBetween(
  read: TableEffect,
  start: number,
  end: number,
  indexOf: ReadonlyMap<Parser.Statement, number>,
  tableEffects: TableEffectAnalysis,
  dirtyGranularity: TableReadMergeOptions["dirtyGranularity"],
): OptimizationDiagnosticReason | undefined {
  const inOpenInterval = (owner: Parser.Node): boolean => {
    const index = indexOf.get(owner as Parser.Statement);
    return index !== undefined && start < index && index < end;
  };
  const dirty = tableEffects.effectsOf(read.table).find((effect) => {
    if (effect.access !== "write" || !inOpenInterval(effect.owner))
      return false;
    if (dirtyGranularity === "table") return true;
    return (
      effect.staticKey === undefined || effect.staticKey === read.staticKey
    );
  });
  if (!dirty) return undefined;
  return dirtyGranularity === "static-key" && dirty.staticKey !== undefined
    ? "dirty-static-key"
    : "dirty-table";
}

function escapeReasonOf(
  reason: ReturnType<TableEffectAnalysis["escapeReasonsOf"]>[number],
): OptimizationDiagnosticReason {
  switch (reason) {
    case "alias":
      return "alias-escape";
    case "call":
      return "call-escape";
    case "return":
      return "return-escape";
    case "store":
      return "store-escape";
    case "capture":
      return "capture-escape";
    case "value-use":
      return "value-use-escape";
  }
}

function rangeOf(
  statement: Parser.Statement,
): readonly [number, number] | undefined {
  return (statement as { range?: [number, number] }).range;
}

function shadowsInterveningReference(
  body: Parser.Statement[],
  start: number,
  candidate: Candidate,
): boolean {
  const name = candidate.statement.variables[0].name;
  for (let index = start; index <= candidate.index; index++) {
    const names: string[] = [];
    const visitor: AstWalkVisitor = {
      onIdentifierReference: (identifier) => {
        names.push(identifier.name);
      },
      onBlock: (nested) => {
        nested.forEach((statement) => {
          walkStatement(statement, visitor);
        });
      },
    };
    walkStatement(body[index], visitor);
    if (names.includes(name)) return true;
  }
  return false;
}

function childBlocksOf(body: Parser.Statement[]): Parser.Statement[][] {
  return childStatementBodies(body);
}
