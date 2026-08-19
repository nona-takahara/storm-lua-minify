import Parser, { Comment } from "luaparse";

export interface StormAnnotations {
  readonly keep: boolean;
  readonly keepName: boolean;
  readonly exported: boolean;
}

const NONE: StormAnnotations = {
  keep: false,
  keepName: false,
  exported: false,
};

function rangeOf(node: object): [number, number] | undefined {
  return (node as { range?: [number, number] }).range;
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

function collectStatements(body: Parser.Statement[]): Parser.Statement[] {
  const statements: Parser.Statement[] = [];
  const visit = (block: Parser.Statement[]) => {
    block.forEach((statement) => {
      statements.push(statement);
      statementChildren(statement).forEach(visit);
    });
  };
  visit(body);
  return statements.sort(
    (a, b) => (rangeOf(a)?.[0] ?? 0) - (rangeOf(b)?.[0] ?? 0),
  );
}

function hasBlankLine(text: string): boolean {
  return /\r?\n[\t ]*\r?\n/.test(text);
}

function parseAnnotations(comments: readonly Comment[]): StormAnnotations {
  let keep = false;
  let keepName = false;
  let exported = false;
  comments.forEach((comment) => {
    const matches = comment.raw.matchAll(/--@storm\s+([^\r\n]*)/g);
    for (const match of matches) {
      const directive = match[1].trim();
      if (directive === "keep") {
        keep = true;
      } else if (directive === "keep-name") {
        keepName = true;
      } else if (directive === "export") {
        exported = true;
        keep = true;
        keepName = true;
      } else {
        throw new Error(`Unknown storm annotation: ${directive || "(empty)"}`);
      }
    }
  });
  return { keep, keepName, exported };
}

export function isPreservedComment(comment: Comment): boolean {
  return comment.raw.includes("--#") || comment.raw.includes("[[#");
}

/** Source comments and annotations associated with statement nodes by range. */
export class SourceMetadata {
  private readonly before = new WeakMap<Parser.Statement, Comment[]>();
  private readonly detachedBefore = new WeakMap<Parser.Statement, Comment[]>();
  private readonly trailing = new WeakMap<Parser.Statement, Comment[]>();
  private readonly annotations = new WeakMap<
    Parser.Statement,
    StormAnnotations
  >();
  private readonly afterModule: Comment[] = [];
  private readonly statementOfIdentifier = new WeakMap<
    Parser.Identifier,
    Parser.Statement
  >();

  constructor(
    chunk: Parser.Chunk & { comments?: Comment[] },
    sourceText: string,
  ) {
    const statements = collectStatements(chunk.body);
    statements.forEach((statement) => {
      if (statement.type === "LocalStatement") {
        statement.variables.forEach((identifier) =>
          this.statementOfIdentifier.set(identifier, statement),
        );
      } else if (
        statement.type === "FunctionDeclaration" &&
        statement.identifier?.type === "Identifier"
      ) {
        this.statementOfIdentifier.set(statement.identifier, statement);
      } else if (statement.type === "AssignmentStatement") {
        statement.variables.forEach((variable) => {
          if (variable.type === "Identifier") {
            this.statementOfIdentifier.set(variable, statement);
          }
        });
      }
    });
    const comments = [...(chunk.comments ?? [])].sort(
      (a, b) => (rangeOf(a)?.[0] ?? 0) - (rangeOf(b)?.[0] ?? 0),
    );

    let index = 0;
    while (index < comments.length) {
      const group: Comment[] = [comments[index++]];
      while (index < comments.length) {
        const previousEnd = rangeOf(group[group.length - 1])?.[1];
        const nextStart = rangeOf(comments[index])?.[0];
        if (previousEnd === undefined || nextStart === undefined) break;
        const gap = sourceText.slice(previousEnd, nextStart);
        if (/^\s*$/.test(gap) && !hasBlankLine(gap)) {
          group.push(comments[index++]);
        } else {
          break;
        }
      }

      const first = group[0];
      const last = group[group.length - 1];
      const groupAnnotations = parseAnnotations(group);
      const preceding = [...statements]
        .reverse()
        .find(
          (statement) =>
            (rangeOf(statement)?.[1] ?? Infinity) <=
            (rangeOf(first)?.[0] ?? -1),
        );
      if (
        preceding?.loc?.end.line !== undefined &&
        preceding.loc.end.line === first.loc?.start.line
      ) {
        this.trailing.set(preceding, [
          ...(this.trailing.get(preceding) ?? []),
          ...group,
        ]);
        continue;
      }

      const following = statements.find(
        (statement) =>
          (rangeOf(statement)?.[0] ?? -1) >= (rangeOf(last)?.[1] ?? Infinity),
      );
      if (following) {
        const gap = sourceText.slice(
          rangeOf(last)?.[1] ?? 0,
          rangeOf(following)?.[0] ?? 0,
        );
        if (/^\s*$/.test(gap) && !hasBlankLine(gap)) {
          this.before.set(following, [
            ...(this.before.get(following) ?? []),
            ...group,
          ]);
          if (
            groupAnnotations.keep ||
            groupAnnotations.keepName ||
            groupAnnotations.exported
          ) {
            this.annotations.set(following, groupAnnotations);
          }
        } else {
          this.detachedBefore.set(following, [
            ...(this.detachedBefore.get(following) ?? []),
            ...group,
          ]);
        }
      } else {
        this.afterModule.push(...group);
      }
    }
  }

  annotationsOf(statement: Parser.Statement): StormAnnotations {
    return this.annotations.get(statement) ?? NONE;
  }

  annotationsOfIdentifier(identifier: Parser.Identifier): StormAnnotations {
    const statement = this.statementOfIdentifier.get(identifier);
    return statement ? this.annotationsOf(statement) : NONE;
  }

  beforeOf(statement: Parser.Statement): readonly Comment[] {
    return [
      ...(this.detachedBefore.get(statement) ?? []),
      ...(this.before.get(statement) ?? []),
    ];
  }

  trailingOf(statement: Parser.Statement): readonly Comment[] {
    return this.trailing.get(statement) ?? [];
  }

  afterModuleComments(): readonly Comment[] {
    return this.afterModule;
  }

  transferStatements(
    sources: readonly Parser.Statement[],
    target: Parser.Statement,
  ): void {
    const before = sources.flatMap((statement) => [
      ...(this.detachedBefore.get(statement) ?? []),
      ...(this.before.get(statement) ?? []),
    ]);
    const trailing = sources.flatMap(
      (statement) => this.trailing.get(statement) ?? [],
    );
    if (before.length) this.before.set(target, before);
    if (trailing.length) this.trailing.set(target, trailing);
    const annotations = sources.map((statement) =>
      this.annotationsOf(statement),
    );
    const combined = {
      keep: annotations.some((value) => value.keep),
      keepName: annotations.some((value) => value.keepName),
      exported: annotations.some((value) => value.exported),
    };
    if (combined.keep || combined.keepName || combined.exported) {
      this.annotations.set(target, combined);
    }
  }

  removeStatement(
    statement: Parser.Statement,
    nextStatement?: Parser.Statement,
  ): void {
    const detached = this.detachedBefore.get(statement) ?? [];
    if (detached.length === 0) return;
    if (nextStatement) {
      this.detachedBefore.set(nextStatement, [
        ...detached,
        ...(this.detachedBefore.get(nextStatement) ?? []),
      ]);
    } else {
      this.afterModule.push(...detached);
    }
  }
}
