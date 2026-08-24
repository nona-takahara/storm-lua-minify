import Parser from "luaparse";
import { walkStatement } from "./astWalk";
import { copyNodeOrigin, identifierWithOrigin } from "./generatedNode";
import { staticStringArgument } from "./linker";
import {
  OptimizationDiagnosticReason,
  OptimizationDiagnosticSink,
} from "./optimizerDiagnostics";
import { OptimizerFacts, OptimizerOperation } from "./optimizerFacts";
import { TransformResult } from "./optimizerPass";
import { ResolveResult, Symbol } from "./resolver";
import { RuntimeProfile } from "./runtimeEnvironment";
import { SourceMetadata } from "./sourceMetadata";
import { StatementDataflowAnalysis } from "./statementDataflow";
import { TableEffect, TableEffectAnalysis } from "./tableEffects";
import { decodeLuaStringLiteral } from "./luaString";

export interface ScheduledLocalGroup {
  readonly body: Parser.Statement[];
  readonly statements: readonly Parser.LocalStatement[];
  readonly indexes: readonly number[];
  readonly symbols: readonly Symbol[];
  readonly mode: "merge-initializers" | "split-initializers";
  readonly byteSavings: number;
}

export interface StatementSchedule {
  readonly generation: number;
  readonly localGroups: readonly ScheduledLocalGroup[];
  readonly tableGroups: readonly ScheduledTableGroup[];
}

export interface ScheduledTableGroup {
  readonly body: Parser.Statement[];
  readonly statements: readonly Parser.LocalStatement[];
  readonly indexes: readonly number[];
  readonly reads: readonly TableEffect[];
  readonly byteSavings: number;
}

export interface StatementSchedulerOptions {
  readonly facts: OptimizerFacts;
  readonly dataflow: StatementDataflowAnalysis;
  readonly outputNameLengthOf: (symbol: Symbol) => number | undefined;
  readonly preserveRequireSplice: boolean;
  readonly enableLocalPacking?: boolean;
  readonly enableLexicalLocalMerge?: boolean;
  readonly tableEffects?: TableEffectAnalysis;
  readonly dirtyGranularity?: "table" | "static-key";
  readonly allowObservableTableValueChanges?: boolean;
  readonly maxTableMergeArity?: number;
  readonly maxTableMergeArityAt?: (statement: Parser.LocalStatement) => number;
  readonly canMoveTableRead?: (statement: Parser.LocalStatement) => boolean;
  readonly maxHoistedLocalsAt?: (statement: Parser.LocalStatement) => number;
  readonly canChangeLocalLifetime?: (
    statement: Parser.LocalStatement,
  ) => boolean;
  readonly diagnostics?: OptimizationDiagnosticSink;
  readonly moduleName?: string;
  readonly runtimeProfile?: RuntimeProfile;
}

interface Candidate {
  readonly statement: Parser.LocalStatement;
  readonly index: number;
  readonly symbol: Symbol;
}

/**
 * Plans source-order rewrites from shared CFG/facts. Initializers are split when a declaration crosses
 * another statement; only the lexical binding point moves, never an evaluation.
 */
export function planStatementSchedule(
  chunk: Parser.Chunk,
  resolved: ResolveResult,
  options: StatementSchedulerOptions,
): StatementSchedule {
  if (
    options.facts.generation !== options.dataflow.generation ||
    options.facts.generation !== options.dataflow.controlFlow.version
  )
    throw new Error("Statement scheduler requires one AST generation");
  const localGroups: ScheduledLocalGroup[] = [];
  const tableGroups: ScheduledTableGroup[] = [];
  const tableStatements = new WeakSet<Parser.LocalStatement>();
  const scheduledLocals = new WeakSet<Parser.LocalStatement>();

  if (options.tableEffects) {
    planTableGroups(chunk.body, options, tableGroups, tableStatements);
  }

  const processBody = (body: Parser.Statement[]): void => {
    body.forEach((statement) => {
      childBodies(statement).forEach(processBody);
    });
    let run: Candidate[] = [];

    const record = (
      decision: "accepted" | "rejected",
      reason: OptimizationDiagnosticReason,
      candidateSize: number,
      byteSavings?: number,
      sourceRange?: readonly [number, number],
    ): void =>
      options.diagnostics?.record({
        pass: "statement-scheduler",
        moduleName: options.moduleName,
        runtimeProfile: options.runtimeProfile,
        decision,
        reason,
        candidateSize,
        estimatedByteSavings: byteSavings,
        estimatedOpportunityBytes:
          decision === "rejected"
            ? Math.max(0, 5 * (candidateSize - 1))
            : undefined,
        sourceRange,
      });

    const flush = (
      reason: OptimizationDiagnosticReason = "insufficient-group",
    ): void => {
      if (run.length < 2) {
        if (run.length === 1)
          record("rejected", reason, 1, undefined, rangeOf(run[0].statement));
        run = [];
        return;
      }
      const lengths = run.map((candidate) =>
        options.outputNameLengthOf(candidate.symbol),
      );
      if (!lengths.every((length): length is number => length !== undefined)) {
        record(
          "rejected",
          "output-name-unknown",
          run.length,
          undefined,
          rangeOf(run[0].statement),
        );
        run = [];
        return;
      }
      const adjacent = run.every(
        (candidate, index) =>
          index === 0 || candidate.index === run[index - 1].index + 1,
      );
      const initializerDependency = run.some((candidate, index) => {
        if (index === 0) return false;
        const prior = new Set(run.slice(0, index).map((item) => item.symbol));
        return options.facts
          .operationsOf(candidate.statement)
          .some(
            (operation) =>
              operation.kind === "read" &&
              symbolOf(operation) !== undefined &&
              prior.has(symbolOf(operation) as Symbol),
          );
      });
      const mode =
        adjacent && !initializerDependency
          ? "merge-initializers"
          : "split-initializers";
      const byteSavings =
        mode === "merge-initializers"
          ? 5 * (run.length - 1)
          : lengths.slice(1).reduce((sum, length) => sum + 5 - length, 0);
      const maxHoisted =
        options.maxHoistedLocalsAt?.(run[0].statement) ?? Infinity;
      if (mode === "split-initializers" && run.length - 1 > maxHoisted) {
        record(
          "rejected",
          "resource-budget",
          run.length,
          undefined,
          rangeOf(run[0].statement),
        );
      } else if (byteSavings <= 0) {
        record(
          "rejected",
          "nonpositive-cost",
          run.length,
          undefined,
          rangeOf(run[0].statement),
        );
      } else {
        localGroups.push({
          body,
          statements: run.map((candidate) => candidate.statement),
          indexes: run.map((candidate) => candidate.index),
          symbols: run.map((candidate) => candidate.symbol),
          mode,
          byteSavings,
        });
        run.forEach((candidate) => scheduledLocals.add(candidate.statement));
        record(
          "accepted",
          "profitable-group",
          run.length,
          byteSavings,
          rangeOf(run[0].statement),
        );
      }
      run = [];
    };

    body.forEach((statement, index) => {
      if (isHardBoundary(statement)) {
        flush("control-flow-barrier");
        return;
      }
      if (statement.type !== "LocalStatement") return;
      if (tableStatements.has(statement) || scheduledLocals.has(statement)) {
        flush();
        return;
      }
      const candidate = candidateOf(statement, index, resolved, options);
      if ("reason" in candidate) {
        flush(candidate.reason);
        record("rejected", candidate.reason, 1, undefined, rangeOf(statement));
        return;
      }
      const start = run[0]?.index ?? index;
      if (
        options.dataflow.controlFlow.unknownEdges.some(
          (edge) =>
            edge.from.unit ===
            options.dataflow.controlFlow.pointOf(statement)?.unit,
        )
      ) {
        flush("unknown-control-flow");
        record(
          "rejected",
          "unknown-control-flow",
          1,
          undefined,
          rangeOf(statement),
        );
        return;
      }
      if (
        widensOverNameReference(
          body,
          start,
          index,
          candidate.symbol.name,
          options.facts,
        ) ||
        run.some((prior) => prior.symbol.name === candidate.symbol.name)
      ) {
        flush("binding-shadow-hazard");
      }
      if (
        run.length > 0 &&
        options.canChangeLocalLifetime?.(statement) === false
      ) {
        flush("metadata-preserved");
      }
      run.push(candidate);
    });
    flush();
  };

  if (options.enableLexicalLocalMerge !== false) {
    planLexicalLocalGroups(
      chunk.body,
      resolved,
      options,
      localGroups,
      tableStatements,
      scheduledLocals,
    );
  }
  // Preserve the cheapest structural rewrite first. Non-adjacent packing can
  // otherwise claim an adjacent run and replace its five-byte `local` removal
  // with initializer assignments that only become profitable in isolation.
  if (options.enableLocalPacking !== false) processBody(chunk.body);
  return { generation: options.facts.generation, localGroups, tableGroups };
}

export function applyStatementSchedule(
  schedule: StatementSchedule,
  metadata?: SourceMetadata,
): TransformResult {
  const actions = [
    ...schedule.localGroups.map((group) => ({ kind: "local" as const, group })),
    ...schedule.tableGroups.map((group) => ({ kind: "table" as const, group })),
  ].sort((left, right) => {
    if (left.group.body !== right.group.body) return 0;
    return right.group.indexes[0] - left.group.indexes[0];
  });
  actions.forEach((action) => {
    if (action.kind === "table") {
      const group = action.group;
      const combined: Parser.LocalStatement = {
        type: "LocalStatement",
        variables: group.statements.map((statement) => statement.variables[0]),
        init: group.statements.map((statement) => statement.init[0]),
      };
      copyNodeOrigin(combined, group.statements[0]);
      metadata?.transferStatements(group.statements, combined);
      for (let offset = group.indexes.length - 1; offset >= 0; offset--) {
        const index = group.indexes[offset];
        group.body.splice(index, 1, ...(offset === 0 ? [combined] : []));
      }
      return;
    }
    const group = action.group;
    const combined: Parser.LocalStatement = {
      type: "LocalStatement",
      variables: group.statements.flatMap((statement) => statement.variables),
      init:
        group.mode === "merge-initializers"
          ? combineInitializerValues(group.statements)
          : [group.statements[0].init[0]],
    };
    copyNodeOrigin(combined, group.statements[0]);
    if (group.mode === "merge-initializers") {
      metadata?.transferStatements(group.statements, combined);
      for (let offset = group.indexes.length - 1; offset >= 0; offset--) {
        const index = group.indexes[offset];
        group.body.splice(index, 1, ...(offset === 0 ? [combined] : []));
      }
      return;
    }
    const assignments = group.statements.slice(1).map((statement) => {
      const assignment: Parser.AssignmentStatement = {
        type: "AssignmentStatement",
        variables: [identifierWithOrigin(statement.variables[0])],
        init: [statement.init[0]],
      };
      copyNodeOrigin(assignment, statement);
      return assignment;
    });
    for (let offset = group.indexes.length - 1; offset >= 0; offset--) {
      const index = group.indexes[offset];
      const source = group.statements[offset];
      const replacements =
        offset === 0 ? [combined] : [assignments[offset - 1]];
      metadata?.replaceStatement(source, replacements);
      group.body.splice(index, 1, ...replacements);
    }
  });
  const changed = actions.length > 0;
  return {
    changed,
    invalidatesResolve: changed,
  };
}

function planLexicalLocalGroups(
  body: Parser.Statement[],
  resolved: ResolveResult,
  options: StatementSchedulerOptions,
  groups: ScheduledLocalGroup[],
  tableStatements: WeakSet<Parser.LocalStatement>,
  scheduled: WeakSet<Parser.LocalStatement>,
): void {
  body.forEach((statement) => {
    childBodies(statement).forEach((child) => {
      planLexicalLocalGroups(
        child,
        resolved,
        options,
        groups,
        tableStatements,
        scheduled,
      );
    });
  });
  let run: Parser.LocalStatement[] = [];
  let runStart = 0;
  const flush = (): void => {
    if (run.length >= 2) {
      const symbols = run.flatMap((statement) =>
        statement.variables.flatMap((variable) => {
          const symbol = resolved.symbolOf(variable);
          return symbol ? [symbol] : [];
        }),
      );
      const padding = paddingCountOf(run);
      const byteSavings = 5 * (run.length - 1) - 4 * padding;
      if (
        symbols.length ===
          run.reduce((sum, statement) => sum + statement.variables.length, 0) &&
        byteSavings > 0
      ) {
        const indexes = run.map((_, offset) => runStart + offset);
        groups.push({
          body,
          statements: run,
          indexes,
          symbols,
          mode: "merge-initializers",
          byteSavings,
        });
        run.forEach((statement) => scheduled.add(statement));
      }
    }
    run = [];
  };
  body.forEach((statement, index) => {
    if (
      statement.type !== "LocalStatement" ||
      tableStatements.has(statement) ||
      scheduled.has(statement) ||
      (options.preserveRequireSplice &&
        statement.init.length === 1 &&
        isRequireCall(statement.init[0]))
    ) {
      flush();
      return;
    }
    if (run.length > 0) {
      const previous = run[run.length - 1];
      if (
        !classifyNonTerminal(previous).safe ||
        initializerReferencesPrior(statement, run, resolved, options.facts)
      )
        flush();
    }
    if (run.length === 0) runStart = index;
    run.push(statement);
  });
  flush();
}

function initializerReferencesPrior(
  candidate: Parser.LocalStatement,
  prior: readonly Parser.LocalStatement[],
  resolved: ResolveResult,
  facts: OptimizerFacts,
): boolean {
  const declarations = new Set(
    prior.flatMap((statement) =>
      statement.variables.flatMap((variable) => {
        const symbol = resolved.symbolOf(variable);
        return symbol ? [symbol] : [];
      }),
    ),
  );
  return facts
    .operationsWithin(candidate)
    .some(
      (operation) =>
        operation.kind === "read" &&
        symbolOf(operation) !== undefined &&
        declarations.has(symbolOf(operation) as Symbol),
    );
}

function classifyNonTerminal(statement: Parser.LocalStatement): {
  readonly safe: boolean;
  readonly needsPadding: boolean;
} {
  if (statement.variables.length === statement.init.length) {
    return { safe: true, needsPadding: false };
  }
  if (statement.variables.length > statement.init.length) {
    const last = statement.init.at(-1);
    return last && isExpandable(last)
      ? { safe: false, needsPadding: false }
      : { safe: true, needsPadding: true };
  }
  return { safe: false, needsPadding: false };
}

function isExpandable(expression: Parser.Expression): boolean {
  return (
    expression.type === "CallExpression" ||
    expression.type === "TableCallExpression" ||
    expression.type === "StringCallExpression" ||
    expression.type === "VarargLiteral"
  );
}

function paddingCountOf(statements: readonly Parser.LocalStatement[]): number {
  return statements.slice(0, -1).reduce((sum, statement) => {
    const classification = classifyNonTerminal(statement);
    return (
      sum +
      (classification.safe && classification.needsPadding
        ? statement.variables.length - statement.init.length
        : 0)
    );
  }, 0);
}

function combineInitializerValues(
  statements: readonly Parser.LocalStatement[],
): Parser.Expression[] {
  const init: Parser.Expression[] = [];
  statements.forEach((statement, index) => {
    init.push(...statement.init);
    if (index < statements.length - 1) {
      const classification = classifyNonTerminal(statement);
      if (classification.safe && classification.needsPadding) {
        const count = statement.variables.length - statement.init.length;
        for (let padding = 0; padding < count; padding++) {
          init.push({ type: "NilLiteral", value: null, raw: "nil" });
        }
      }
    }
  });
  while (init.at(-1)?.type === "NilLiteral") init.pop();
  return init;
}

interface TableCandidate {
  readonly statement: Parser.LocalStatement;
  readonly index: number;
  readonly read: TableEffect;
}

function planTableGroups(
  body: Parser.Statement[],
  options: StatementSchedulerOptions,
  groups: ScheduledTableGroup[],
  claimed: WeakSet<Parser.LocalStatement>,
): void {
  body.forEach((statement) => {
    childBodies(statement).forEach((child) => {
      planTableGroups(child, options, groups, claimed);
    });
  });
  const analysis = options.tableEffects;
  if (!analysis) return;
  const indexOf = new Map(body.map((statement, index) => [statement, index]));
  let run: TableCandidate[] = [];
  const flush = (
    rejectionReason: OptimizationDiagnosticReason = "insufficient-group",
  ): void => {
    const policyLimit = options.maxTableMergeArity ?? 50;
    let accepted = 0;
    for (let start = 0; start < run.length;) {
      const limit = Math.min(
        policyLimit,
        options.maxTableMergeArityAt?.(run[start].statement) ?? policyLimit,
      );
      const part = run.slice(start, start + limit);
      start += Math.max(1, part.length);
      if (part.length < 2) continue;
      const byteSavings = 5 * (part.length - 1);
      groups.push({
        body,
        statements: part.map((candidate) => candidate.statement),
        indexes: part.map((candidate) => candidate.index),
        reads: part.map((candidate) => candidate.read),
        byteSavings,
      });
      part.forEach((candidate) => claimed.add(candidate.statement));
      accepted += part.length;
      options.diagnostics?.record({
        pass: "statement-scheduler",
        moduleName: options.moduleName,
        runtimeProfile: options.runtimeProfile,
        decision: "accepted",
        reason: "profitable-group",
        candidateSize: part.length,
        estimatedByteSavings: byteSavings,
        sourceRange: rangeOf(part[0].statement),
      });
    }
    if (run.length > accepted)
      options.diagnostics?.record({
        pass: "statement-scheduler",
        moduleName: options.moduleName,
        runtimeProfile: options.runtimeProfile,
        decision: "rejected",
        reason: rejectionReason,
        candidateSize: run.length - accepted,
        estimatedOpportunityBytes: Math.max(0, 5 * (run.length - accepted - 1)),
        sourceRange: rangeOf(run[accepted]?.statement ?? run[0].statement),
      });
    run = [];
  };
  body.forEach((statement, index) => {
    if (
      statement.type === "IfStatement" ||
      statement.type === "WhileStatement" ||
      statement.type === "RepeatStatement" ||
      statement.type === "ForNumericStatement" ||
      statement.type === "ForGenericStatement" ||
      isHardBoundary(statement)
    ) {
      flush();
      return;
    }
    if (
      statement.type === "AssignmentStatement" ||
      statement.type === "CallStatement"
    )
      return;
    const decision = tableCandidateOf(statement, index, analysis, options);
    if (!("candidate" in decision)) {
      flush();
      if (decision.reason)
        options.diagnostics?.record({
          pass: "statement-scheduler",
          moduleName: options.moduleName,
          runtimeProfile: options.runtimeProfile,
          decision: "rejected",
          reason: decision.reason,
          candidateSize: 1,
          estimatedOpportunityBytes: 0,
          sourceRange: rangeOf(statement),
        });
      return;
    }
    const candidate = decision.candidate;
    const point = options.dataflow.controlFlow.pointOf(statement);
    if (
      point &&
      options.dataflow.controlFlow.unknownEdges.some(
        (edge) => edge.from.unit === point.unit,
      )
    ) {
      flush("unknown-control-flow");
      options.diagnostics?.record({
        pass: "statement-scheduler",
        moduleName: options.moduleName,
        runtimeProfile: options.runtimeProfile,
        decision: "rejected",
        reason: "unknown-control-flow",
        candidateSize: 1,
        estimatedOpportunityBytes: 0,
        sourceRange: rangeOf(statement),
      });
      return;
    }
    if (run.length > 0) {
      const first = run[0];
      const stability = analysis.stabilityBetween(
        candidate.read.table,
        candidate.read.baseSymbol,
        first.statement,
        candidate.statement,
      );
      const dirty = tableDirtyReasonBetween(
        candidate.read,
        first.index,
        index,
        indexOf,
        analysis,
        options.dirtyGranularity ?? "static-key",
      );
      const shadow = shadowsInterveningReference(
        body,
        first.index,
        candidate,
        analysis,
      );
      const dependency = body
        .slice(first.index + 1, index)
        .flatMap((obstacle) =>
          options.dataflow.dependenciesBetween(obstacle, statement),
        )
        .find(
          (edge) =>
            edge.kind !== "error-order" &&
            edge.kind !== "metamethod-order" &&
            edge.kind !== "scope-order" &&
            !(
              options.allowObservableTableValueChanges &&
              (edge.kind === "read-after-write" ||
                edge.kind === "write-after-read")
            ),
        );
      if (shadow) flush("binding-shadow-hazard");
      else if (dependency) flush(dependencyReason(dependency.kind));
      else if (!options.allowObservableTableValueChanges && !stability.stable) {
        flush(stability.reason);
      } else if (!options.allowObservableTableValueChanges && dirty)
        flush(dirty);
    }
    run.push(candidate);
  });
  flush();
}

function tableCandidateOf(
  statement: Parser.Statement,
  index: number,
  analysis: TableEffectAnalysis,
  options: StatementSchedulerOptions,
):
  | { readonly candidate: TableCandidate }
  | { readonly reason?: OptimizationDiagnosticReason } {
  if (statement.type !== "LocalStatement") return {};
  if (statement.variables.length !== 1 || statement.init.length !== 1) {
    return { reason: "unsupported-shape" };
  }
  const init = statement.init[0];
  if (init.type !== "MemberExpression" && init.type !== "IndexExpression")
    return {};
  if (options.canMoveTableRead?.(statement) === false)
    return { reason: "metadata-preserved" };
  const read = analysis.effects.find(
    (effect) => effect.access === "read" && effect.expression === init,
  );
  if (!read) return { reason: "allocation-unknown" };
  if (read.staticKey === undefined) {
    return {
      reason:
        init.type === "IndexExpression" &&
        init.index.type === "StringLiteral" &&
        !decodeLuaStringLiteral(init.index).ok
          ? "unsupported-string-key"
          : "dynamic-key",
    };
  }
  const escape = analysis.escapeReasonsOf(read.table).at(0);
  if (escape) return { reason: escapeReasonOf(escape) };
  return { candidate: { statement, index, read } };
}

function tableDirtyReasonBetween(
  read: TableEffect,
  start: number,
  end: number,
  indexOf: ReadonlyMap<Parser.Statement, number>,
  analysis: TableEffectAnalysis,
  granularity: "table" | "static-key",
): OptimizationDiagnosticReason | undefined {
  const dirty = analysis.effectsOf(read.table).find((effect) => {
    const index = indexOf.get(effect.owner);
    if (
      effect.access !== "write" ||
      index === undefined ||
      index <= start ||
      index >= end
    )
      return false;
    return (
      granularity === "table" ||
      effect.staticKey === undefined ||
      effect.staticKey === read.staticKey
    );
  });
  if (!dirty) return undefined;
  return granularity === "static-key" && dirty.staticKey !== undefined
    ? "dirty-static-key"
    : "dirty-table";
}

function shadowsInterveningReference(
  body: readonly Parser.Statement[],
  start: number,
  candidate: TableCandidate,
  analysis: TableEffectAnalysis,
): boolean {
  const name = candidate.statement.variables[0].name;
  for (let index = start; index <= candidate.index; index++) {
    if (
      analysis.facts
        .operationsWithin(body[index])
        .some(
          (operation) =>
            (operation.kind === "read" || operation.kind === "write") &&
            nameOf(operation) === name,
        )
    )
      return true;
  }
  return false;
}

function escapeReasonOf(
  reason: ReturnType<TableEffectAnalysis["escapeReasonsOf"]>[number],
): OptimizationDiagnosticReason {
  return `${reason === "value-use" ? "value-use" : reason}-escape` as OptimizationDiagnosticReason;
}

function dependencyReason(
  kind: import("./statementDataflow").DependenceKind,
): OptimizationDiagnosticReason {
  return `dependency-${kind}` as OptimizationDiagnosticReason;
}

function candidateOf(
  statement: Parser.LocalStatement,
  index: number,
  resolved: ResolveResult,
  options: StatementSchedulerOptions,
): Candidate | { readonly reason: OptimizationDiagnosticReason } {
  if (statement.variables.length !== 1 || statement.init.length !== 1) {
    return { reason: "unsupported-shape" };
  }
  if (options.preserveRequireSplice && isRequireCall(statement.init[0])) {
    return { reason: "require-splice" };
  }
  const symbol = resolved.symbolOf(statement.variables[0]);
  return symbol?.kind === "local"
    ? { statement, index, symbol }
    : { reason: "unsupported-shape" };
}

function widensOverNameReference(
  body: readonly Parser.Statement[],
  start: number,
  end: number,
  name: string,
  facts: OptimizerFacts,
): boolean {
  for (let index = start; index < end; index++) {
    if (
      facts
        .operationsWithin(body[index])
        .some((operation) => nameOf(operation) === name)
    ) {
      return true;
    }
  }
  return false;
}

function symbolOf(operation: OptimizerOperation): Symbol | undefined {
  if (!("location" in operation)) return undefined;
  const location = operation.location;
  return location.kind === "local" ||
    location.kind === "parameter" ||
    location.kind === "upvalue"
    ? location.symbol
    : undefined;
}

function nameOf(operation: OptimizerOperation): string | undefined {
  if (!("location" in operation)) return undefined;
  const location = operation.location;
  if (
    location.kind === "local" ||
    location.kind === "parameter" ||
    location.kind === "upvalue"
  ) {
    return location.symbol.name;
  }
  return location.kind === "global" ? location.binding.name : undefined;
}

function isHardBoundary(statement: Parser.Statement): boolean {
  return (
    statement.type === "ReturnStatement" ||
    statement.type === "BreakStatement" ||
    statement.type === "GotoStatement" ||
    statement.type === "LabelStatement" ||
    statement.type === "FunctionDeclaration"
  );
}

function childBodies(statement: Parser.Statement): Parser.Statement[][] {
  const bodies: Parser.Statement[][] = [];
  switch (statement.type) {
    case "DoStatement":
    case "WhileStatement":
    case "RepeatStatement":
    case "ForNumericStatement":
    case "ForGenericStatement":
      bodies.push(statement.body);
      break;
    case "FunctionDeclaration":
      bodies.push(statement.body);
      break;
    case "IfStatement":
      bodies.push(...statement.clauses.map((clause) => clause.body));
      break;
  }
  walkStatement(statement, {
    onFunction: (fn) => {
      if (!bodies.includes(fn.body)) bodies.push(fn.body);
    },
  });
  return bodies;
}

function isRequireCall(expression: Parser.Expression): boolean {
  if (expression.type === "CallExpression") {
    return (
      expression.base.type === "Identifier" &&
      expression.base.name === "require" &&
      expression.arguments.length > 0 &&
      staticStringArgument(expression.arguments[0]) !== undefined
    );
  }
  return (
    expression.type === "StringCallExpression" &&
    expression.base.type === "Identifier" &&
    expression.base.name === "require" &&
    staticStringArgument(expression.argument) !== undefined
  );
}

function rangeOf(
  statement: Parser.Statement,
): readonly [number, number] | undefined {
  return (statement as { range?: [number, number] }).range;
}
