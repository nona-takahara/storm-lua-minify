import Parser from "luaparse";
import { AstWalkVisitor, walkStatement } from "./astWalk";
import { EffectAnalysis } from "./effectAnalysis";
import { copyNodeOrigin } from "./generatedNode";
import { SourceMetadata } from "./sourceMetadata";
import { TransformResult } from "./optimizerPass";
import { TableEffect, TableEffectAnalysis } from "./tableEffects";

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
}

interface Candidate {
  readonly statement: Parser.LocalStatement;
  readonly index: number;
  readonly read: TableEffect;
}

// Lua 5.3のlocal上限200とregister上限255の差より小さく保つ。
// static table readは単純でも、全RHSを同時評価する巨大local文を生成しない。
const MAX_MERGE_ARITY = 50;

export function planTableReadMerges(
  chunk: Parser.Chunk,
  bindingEffects: EffectAnalysis,
  tableEffects: TableEffectAnalysis,
  options: TableReadMergeOptions,
): TableReadMergePlan {
  const groups: TableReadMergeGroup[] = [];

  function processBlock(body: Parser.Statement[]): void {
    childBlocksOf(body).forEach(processBlock);
    const indexOf = new Map<Parser.Statement, number>();
    body.forEach((statement, index) => indexOf.set(statement, index));
    let run: Candidate[] = [];

    const flush = () => {
      for (let start = 0; start < run.length; start += MAX_MERGE_ARITY) {
        const part = run.slice(start, start + MAX_MERGE_ARITY);
        if (part.length < 2) continue;
        if (
          !part.some(
            (candidate, offset) =>
              offset > 0 && candidate.index > part[offset - 1].index + 1,
          )
        ) {
          continue;
        }
        groups.push({
          body,
          statements: part.map((candidate) => candidate.statement),
          indexes: part.map((candidate) => candidate.index),
          reads: part.map((candidate) => candidate.read),
          // N文を1文へまとめると、2文目以降ごとに`local `と`=`の重複から
          // 変数/init間のcommaを差し引いて5 bytesずつ減る。
          estimatedByteSavings: 5 * (part.length - 1),
        });
      }
      run = [];
    };

    body.forEach((statement, index) => {
      if (isIntervening(statement)) return;
      const candidate = candidateOf(
        statement,
        index,
        bindingEffects,
        tableEffects,
        options,
      );
      if (!candidate) {
        flush();
        return;
      }

      if (
        shadowsInterveningReference(body, run[0]?.index ?? index, candidate) ||
        tableIsDirtyBetween(
          candidate.read,
          run[0]?.index ?? index,
          index,
          indexOf,
          bindingEffects,
          tableEffects,
          options.dirtyGranularity,
        )
      ) {
        flush();
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
  bindingEffects: EffectAnalysis,
  analysis: TableEffectAnalysis,
  options: TableReadMergeOptions,
): Candidate | undefined {
  if (
    statement.type !== "LocalStatement" ||
    statement.variables.length !== 1 ||
    statement.init.length !== 1 ||
    (statement.init[0].type !== "MemberExpression" &&
      statement.init[0].type !== "IndexExpression")
  ) {
    return undefined;
  }
  if (options.canMoveStatement?.(statement) === false) return undefined;
  const read = analysis.effects.find(
    (effect) =>
      effect.access === "read" &&
      effect.expression === statement.init[0] &&
      effect.staticKey !== undefined &&
      analysis.isNonescaping(effect.table) &&
      // Symbolの現在値をallocationへ結び付けるpoints-to/CFGはまだ無い。
      // 一度でも再代入されれば、以後のaccessを元fresh tableとはみなさない。
      !bindingEffects
        .accessesOf(effect.table.symbol)
        .some((binding) => binding.access === "write"),
  );
  return read ? { statement, index, read } : undefined;
}

function isIntervening(statement: Parser.Statement): boolean {
  return (
    statement.type === "AssignmentStatement" ||
    statement.type === "CallStatement"
  );
}

function tableIsDirtyBetween(
  read: TableEffect,
  start: number,
  end: number,
  indexOf: ReadonlyMap<Parser.Statement, number>,
  bindingEffects: EffectAnalysis,
  tableEffects: TableEffectAnalysis,
  dirtyGranularity: TableReadMergeOptions["dirtyGranularity"],
): boolean {
  const inOpenInterval = (owner: Parser.Node): boolean => {
    const index = indexOf.get(owner as Parser.Statement);
    return index !== undefined && start < index && index < end;
  };
  const bindingWrite = bindingEffects
    .accessesOf(read.table.symbol)
    .some(
      (effect) => effect.access === "write" && inOpenInterval(effect.owner),
    );
  if (bindingWrite) return true;

  return tableEffects.effectsOf(read.table).some((effect) => {
    if (effect.access !== "write" || !inOpenInterval(effect.owner))
      return false;
    if (dirtyGranularity === "table") return true;
    return (
      effect.staticKey === undefined || effect.staticKey === read.staticKey
    );
  });
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
  const children: Parser.Statement[][] = [];
  body.forEach((statement) => {
    walkStatement(statement, {
      onBlock: (nested) => children.push(nested),
    });
  });
  return children;
}
