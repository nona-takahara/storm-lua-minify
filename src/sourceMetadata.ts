import Parser, { Comment } from "luaparse";

export interface StormAnnotations {
  readonly keep: boolean;
  readonly keepName: boolean;
  readonly exported: boolean;
}

export type EmmyLuaDirective =
  | {
      readonly kind: "class";
      readonly name: string;
      readonly base?: string;
      readonly comment: Comment;
    }
  | {
      readonly kind: "field";
      readonly name: string;
      readonly valueType: string;
      readonly comment: Comment;
    }
  | {
      readonly kind: "param";
      readonly name: string;
      readonly valueType: string;
      readonly comment: Comment;
    }
  | {
      readonly kind: "return" | "type";
      readonly valueType: string;
      readonly comment: Comment;
    }
  | {
      readonly kind: "alias";
      readonly name: string;
      readonly valueType: string;
      readonly comment: Comment;
    }
  | {
      readonly kind: "enum";
      readonly name: string;
      readonly comment: Comment;
    }
  | {
      readonly kind: "other";
      readonly directive: string;
      readonly value: string;
      readonly comment: Comment;
    };

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

function parseEmmyLua(comments: readonly Comment[]): EmmyLuaDirective[] {
  const directives: EmmyLuaDirective[] = [];
  comments.forEach((comment) => {
    for (const match of comment.raw.matchAll(/---@([\w-]+)\s*([^\r\n]*)/g)) {
      const directive = match[1];
      const value = match[2].trim();
      if (directive === "class") {
        const parsed = /^([^\s:]+)(?:\s*:\s*([^\s]+))?/.exec(value);
        if (parsed)
          directives.push({
            kind: "class",
            name: parsed[1],
            ...(parsed[2] ? { base: parsed[2] } : {}),
            comment,
          });
      } else if (directive === "field") {
        const parsed =
          /^(?:(?:public|protected|private|package)\s+)?(?:\([^)]*\)\s*)?([^\s]+)\s+(.+)$/.exec(
            value,
          );
        if (parsed)
          directives.push({
            kind: "field",
            name: parsed[1],
            valueType: parsed[2].trim(),
            comment,
          });
      } else if (directive === "param") {
        const parsed = /^(\S+)\s+(.+)$/.exec(value);
        if (parsed)
          directives.push({
            kind: "param",
            name: parsed[1],
            valueType: parsed[2].trim(),
            comment,
          });
      } else if (directive === "return" || directive === "type") {
        if (value)
          directives.push({ kind: directive, valueType: value, comment });
      } else if (directive === "alias") {
        const parsed = /^(\S+)\s+(.+)$/.exec(value);
        if (parsed)
          directives.push({
            kind: "alias",
            name: parsed[1],
            valueType: parsed[2].trim(),
            comment,
          });
      } else if (directive === "enum") {
        const name = value.split(/\s+/)[0];
        if (name) directives.push({ kind: "enum", name, comment });
      } else {
        directives.push({ kind: "other", directive, value, comment });
      }
    }
  });
  return directives;
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
  private readonly emmyLua = new WeakMap<
    Parser.Statement,
    readonly EmmyLuaDirective[]
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
      const groupEmmyLua = parseEmmyLua(group);
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
          if (groupEmmyLua.length > 0)
            this.emmyLua.set(following, groupEmmyLua);
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

  emmyLuaOf(statement: Parser.Statement): readonly EmmyLuaDirective[] {
    return this.emmyLua.get(statement) ?? [];
  }

  emmyLuaOfIdentifier(
    identifier: Parser.Identifier,
  ): readonly EmmyLuaDirective[] {
    const statement = this.statementOfIdentifier.get(identifier);
    return statement ? this.emmyLuaOf(statement) : [];
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
    const emmyLua = sources.flatMap((statement) => this.emmyLuaOf(statement));
    if (emmyLua.length > 0) this.emmyLua.set(target, emmyLua);
  }

  /**
   * 1つの文を複数文へ置換するとき、文境界に属する情報を外側の境界へ移す。
   * leading/detachedは最初、trailingは最後へ置くことで、置換後もコメントの
   * 前後関係を変えない。アノテーションは変換判断に使った後も、後続パスが
   * 同じ保護指定を観測できるよう全置換文へ引き継ぐ。
   */
  replaceStatement(
    source: Parser.Statement,
    replacements: readonly Parser.Statement[],
  ): void {
    if (replacements.length === 0) return;
    const first = replacements[0];
    const last = replacements[replacements.length - 1];

    const detached = this.detachedBefore.get(source);
    const before = this.before.get(source);
    const trailing = this.trailing.get(source);
    if (detached?.length) this.detachedBefore.set(first, detached);
    if (before?.length) this.before.set(first, before);
    if (trailing?.length) this.trailing.set(last, trailing);

    const annotations = this.annotations.get(source);
    if (annotations) {
      replacements.forEach((statement) =>
        this.annotations.set(statement, annotations),
      );
    }
    const emmyLua = this.emmyLua.get(source);
    if (emmyLua) {
      replacements.forEach((statement) => this.emmyLua.set(statement, emmyLua));
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
