import Parser from "luaparse";
import { walkBlockDeep, walkExpression, walkStatement } from "./astWalk";
import { Callable } from "./callGraph";
import { generateCandidate, isAvailable } from "./renamer";
import { Symbol } from "./resolver";
import { SourceMetadata } from "./sourceMetadata";
import { WholeProgramObjectAnalysis } from "./wholeProgramObjects";
import {
  FieldRenameReason,
  WholeProgramFieldRenameDiagnostic,
  WholeProgramFieldRenamePlan,
} from "./wholeProgramFieldRenames";

/**
 * Name-based field shortening for programs that own every key they define.
 *
 * Unlike the object-identity planner this one never tries to prove which table an access
 * reaches. It instead decides per spelling: a field name is shortened everywhere when the
 * program defines it, no value that the program does not own can be reached through it, and
 * the spelling never appears as a string. The decision is only valid under the
 * `assumeClosedFieldNames` assumption, so the planner is opt-in and reports every refusal.
 */

const IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Globals whose values are produced or consumed by the host rather than by the program. */
const EXTERNAL_GLOBALS = new Set([
  "_ENV",
  "_G",
  "debug",
  "g_savedata",
  // Stormworks addon API
  "async",
  "input",
  "map",
  "matrix",
  "output",
  "property",
  "screen",
  "server",
]);

/** Lua standard globals. Their results are scalars or values the program already owns. */
const STANDARD_GLOBALS = new Set([
  "_VERSION",
  "assert",
  "collectgarbage",
  "coroutine",
  "dofile",
  "error",
  "getmetatable",
  "ipairs",
  "load",
  "loadfile",
  "math",
  "next",
  "os",
  "pairs",
  "pcall",
  "print",
  "rawequal",
  "rawget",
  "rawlen",
  "rawset",
  "require",
  "select",
  "setmetatable",
  "string",
  "table",
  "tonumber",
  "tostring",
  "type",
  "utf8",
  "xpcall",
]);

/**
 * Member names of the Lua 5.3 standard library, string methods, and the field names that the
 * Stormworks API is known to return or accept. A program that defines one of these spellings
 * keeps it, because the program and the runtime then share the key.
 */
const RUNTIME_FIELD_NAMES = new Set([
  // string / utf8
  ...(
    "byte char dump find format gmatch gsub len lower match rep reverse sub upper " +
    "pack packsize unpack charpattern codepoint codes offset"
  ).split(" "),
  // table / math / os / coroutine / debug
  ...(
    "concat insert move remove sort abs acos asin atan ceil cos deg exp floor fmod huge " +
    "log max maxinteger min mininteger modf pi rad random randomseed sin sqrt tan " +
    "tointeger type ult clock date difftime time create isyieldable resume running " +
    "status wrap yield traceback getinfo sethook gethook"
  ).split(" "),
  // io objects are not available in Stormworks but keep the spellings stable
  ..."close flush lines read seek setvbuf write open popen tmpfile".split(" "),
  // Stormworks API results and arguments
  ...(
    "id name steam_id admin auth x y z pos voxel rotation components signs seats " +
    "buttons dials tanks batteries hoppers guns rope_hooks sliders indicators value " +
    "on_value tile_x tile_y fog rain wind snow fire charge fluid ammo capacity " +
    "is_success success is_loaded is_local is_static is_dead hp is_incapacitated " +
    "is_simulating vehicle_id object_id peer_id ui_id tooltip text display"
  ).split(" "),
]);

const RESERVED_METATABLE_PREFIX = "__";

type NamePlanReason = FieldRenameReason;

interface NameSite {
  readonly node: Parser.Identifier;
  readonly moduleName: string;
  readonly definition: boolean;
  readonly statement: Parser.Statement | undefined;
}

interface NameEntry {
  readonly name: string;
  readonly sites: NameSite[];
  readonly reasons: Set<NamePlanReason>;
  stringForm: boolean;
}

export interface NameBasedFieldRenameOptions {
  /** Field names that are read or written by code outside the linked program. */
  readonly neverRenameFields?: ReadonlySet<string>;
}

function sourceRangeOf(node: object): readonly [number, number] | undefined {
  return (node as { range?: readonly [number, number] }).range;
}

function stringContent(literal: Parser.StringLiteral): string | undefined {
  const raw = literal.raw;
  const quote = raw.at(0);
  if ((quote !== '"' && quote !== "'") || raw.at(-1) !== quote)
    return undefined;
  const body = raw.slice(1, -1);
  return body.includes("\\") ? undefined : body;
}

function staticKey(expression: Parser.Expression): string | undefined {
  return expression.type === "StringLiteral"
    ? stringContent(expression)
    : undefined;
}

function rootOf(expression: Parser.Expression): Parser.Expression {
  let current = expression;
  while (
    current.type === "MemberExpression" ||
    current.type === "IndexExpression"
  )
    current = current.base;
  return current;
}

/** Name of the last member step on a path, e.g. `players` for `self.players[i]`. */
function innermostFieldName(expression: Parser.Expression): string | undefined {
  let current = expression;
  while (current.type === "IndexExpression") {
    const key = staticKey(current.index);
    if (key !== undefined) return key;
    current = current.base;
  }
  return current.type === "MemberExpression"
    ? current.identifier.name
    : undefined;
}

/**
 * The expression that supplies the `index`th target of a multiple assignment. Surplus targets
 * receive values only from a trailing call or vararg, which expands to several values.
 */
function initializerOf(
  init: readonly Parser.Expression[],
  index: number,
): Parser.Expression | undefined {
  const direct = init.at(index);
  if (direct) return direct;
  const last = init.at(-1);
  return last &&
    (last.type === "CallExpression" ||
      last.type === "TableCallExpression" ||
      last.type === "StringCallExpression" ||
      last.type === "VarargLiteral")
    ? last
    : undefined;
}

export function planNameBasedFieldRenames(
  objects: WholeProgramObjectAnalysis,
  entryModule: string,
  metadataOf: (moduleName: string) => SourceMetadata,
  options: NameBasedFieldRenameOptions = {},
): WholeProgramFieldRenamePlan {
  type Module = (typeof objects.modules)[number];
  const entries = new Map<string, NameEntry>();
  const entryOf = (name: string): NameEntry => {
    let entry = entries.get(name);
    if (!entry) {
      entry = { name, sites: [], reasons: new Set(), stringForm: false };
      entries.set(name, entry);
    }
    return entry;
  };
  const poison = (name: string, reason: NamePlanReason) =>
    entryOf(name).reasons.add(reason);

  const statementOfNode = new WeakMap<object, Parser.Statement>();
  const stringLiterals = new Set<string>();
  const stringFormNodes = new WeakSet<Parser.StringLiteral>();
  const writtenGlobals = new Set<string>();
  const callablesByName = new Map<string, Callable[]>();

  objects.modules.forEach((module) => {
    module.resolved.globals.forEach((binding, name) => {
      if (binding.writes.length > 0) writtenGlobals.add(name);
    });
    module.analysis.callGraph.functions.forEach((callable) => {
      const identifier = callable.declaration.identifier;
      const name =
        identifier?.type === "MemberExpression"
          ? identifier.identifier.name
          : identifier?.type === "Identifier"
            ? identifier.name
            : callable.symbol?.name;
      if (name === undefined) return;
      const list = callablesByName.get(name) ?? [];
      list.push(callable);
      callablesByName.set(name, list);
    });
  });
  const callSiteByNode = new Map<
    object,
    (typeof objects.modules)[number]["analysis"]["callGraph"]["calls"][number]
  >();
  objects.modules.forEach((module) => {
    module.analysis.callGraph.calls.forEach((call) =>
      callSiteByNode.set(call.call, call),
    );
  });

  const definitionNodes = new WeakSet();
  const addSite = (
    module: (typeof objects.modules)[number],
    node: Parser.Identifier,
    definition: boolean,
    expression: Parser.Expression | Parser.Statement,
  ) => {
    entryOf(node.name).sites.push({
      node,
      moduleName: module.name,
      definition,
      statement: statementOfNode.get(expression),
    });
  };

  // Pass 1: classify every syntactic field spelling and every string literal.
  objects.modules.forEach((module) => {
    const indexBlock = (body: readonly Parser.Statement[]) => {
      body.forEach((statement) => {
        statementOfNode.set(statement, statement);
        walkBlockDeep([statement], {
          // A nested block is indexed after its parent, so the innermost statement wins.
          onExpression: (expression) => {
            statementOfNode.set(expression, statement);
          },
        });
      });
    };
    indexBlock(module.chunk.body);
    walkBlockDeep(module.chunk.body, {
      onBlock: indexBlock,
      onStatement: (statement) => {
        if (
          statement.type === "FunctionDeclaration" &&
          statement.identifier?.type === "MemberExpression"
        )
          definitionNodes.add(statement.identifier);
        if (statement.type === "AssignmentStatement")
          statement.variables.forEach((variable) => {
            if (variable.type === "MemberExpression")
              definitionNodes.add(variable);
            else if (variable.type === "IndexExpression")
              definitionNodes.add(variable);
          });
      },
      onExpression: (expression) => {
        if (expression.type === "StringLiteral") {
          const content = stringContent(expression);
          stringLiterals.add(content ?? expression.raw);
          return;
        }
        if (expression.type === "MemberExpression") {
          addSite(
            module,
            expression.identifier,
            definitionNodes.has(expression),
            expression,
          );
          return;
        }
        if (expression.type === "IndexExpression") {
          const key = staticKey(expression.index);
          if (key !== undefined) {
            stringFormNodes.add(expression.index as Parser.StringLiteral);
            entryOf(key).stringForm = true;
          }
          return;
        }
        if (expression.type === "TableConstructorExpression") {
          expression.fields.forEach((field) => {
            if (field.type === "TableKeyString")
              addSite(module, field.key, true, expression);
            else if (field.type === "TableKey") {
              const key = staticKey(field.key);
              if (key !== undefined) {
                stringFormNodes.add(field.key as Parser.StringLiteral);
                entryOf(key).stringForm = true;
              }
            }
          });
        }
      },
    });
  });

  // A table that the program indexes with a computed key is a lookup table: its keys are data,
  // so a key spelled as an identifier (`{ stop = f }` read as `handlers[name]`) must keep its name.
  const dynamicSymbols = new Set<Symbol>();
  const dynamicFieldNames = new Set<string>();
  const constructorOwners: {
    constructor: Parser.TableConstructorExpression;
    symbol?: Symbol;
    field?: string;
  }[] = [];
  const memberWrites: { module: Module; target: Parser.Expression }[] = [];
  objects.modules.forEach((module) => {
    walkBlockDeep(module.chunk.body, {
      onStatement: (statement) => {
        if (statement.type === "LocalStatement")
          statement.variables.forEach((variable, index) => {
            const init = statement.init.at(index);
            if (init?.type === "TableConstructorExpression")
              constructorOwners.push({
                constructor: init,
                symbol: module.resolved.symbolOf(variable),
              });
          });
        if (statement.type === "AssignmentStatement")
          statement.variables.forEach((variable, index) => {
            const init = statement.init.at(index);
            if (init?.type === "TableConstructorExpression")
              constructorOwners.push({
                constructor: init,
                symbol:
                  variable.type === "Identifier"
                    ? module.resolved.symbolOf(variable)
                    : undefined,
                field: innermostFieldName(variable),
              });
            if (
              variable.type === "MemberExpression" ||
              variable.type === "IndexExpression"
            )
              memberWrites.push({ module, target: variable });
          });
      },
      onExpression: (expression) => {
        if (expression.type === "TableConstructorExpression")
          expression.fields.forEach((field) => {
            if (
              field.type === "TableKeyString" &&
              field.value.type === "TableConstructorExpression"
            )
              constructorOwners.push({
                constructor: field.value,
                field: field.key.name,
              });
          });
        if (
          expression.type !== "IndexExpression" ||
          staticKey(expression.index) !== undefined ||
          expression.index.type === "NumericLiteral"
        )
          return;
        const base = expression.base;
        if (base.type === "Identifier") {
          const symbol = module.resolved.symbolOf(base);
          if (symbol) dynamicSymbols.add(symbol);
        } else {
          const name = innermostFieldName(base);
          if (name !== undefined) dynamicFieldNames.add(name);
        }
      },
    });
  });
  const isLookupTable = (owner: { symbol?: Symbol; field?: string }): boolean =>
    (owner.symbol !== undefined && dynamicSymbols.has(owner.symbol)) ||
    (owner.field !== undefined && dynamicFieldNames.has(owner.field));
  constructorOwners.forEach((owner) => {
    if (!isLookupTable(owner)) return;
    owner.constructor.fields.forEach((field) => {
      if (field.type === "TableKeyString")
        poison(field.key.name, "dynamic-key");
    });
  });
  memberWrites.forEach(({ module, target }) => {
    if (target.type !== "MemberExpression") return;
    const base = target.base;
    const owner =
      base.type === "Identifier"
        ? { symbol: module.resolved.symbolOf(base) }
        : { field: innermostFieldName(base) };
    if (isLookupTable(owner)) poison(target.identifier.name, "dynamic-key");
  });

  // Strings that are not field spellings of their own accord keep the name.
  // A static index key counts as a string form: both spellings must stay equal.
  objects.modules.forEach((module) => {
    walkBlockDeep(module.chunk.body, {
      onExpression: (expression) => {
        if (expression.type !== "StringLiteral") return;
        if (stringFormNodes.has(expression)) return;
        const content = stringContent(expression);
        if (content !== undefined && entries.has(content))
          poison(content, "string-key");
      },
    });
  });
  entries.forEach((entry) => {
    if (entry.stringForm) entry.reasons.add("string-key");
  });

  // Pass 2: find values the program does not own, by name-level taint.
  const taintedSymbols = new Set<Symbol>();
  // Symbols that may hold an external table itself, not only a value read out of one.
  const directSymbols = new Set<Symbol>();
  // Symbols tainted by something other than a caller's argument. A function's return value
  // follows only these, so one external argument cannot taint every caller of an identity-like
  // function such as `create_instance(target, prototype)`.
  const intrinsicSymbols = new Set<Symbol>();
  let intrinsicMode = false;
  const taintedFieldNames = new Set<string>();
  const taintedGlobals = new Set<string>();
  const taintedReturns = new Set<Callable>();
  // Parameter positions a function hands back unchanged (`return target`). The result is
  // external exactly when that argument is.
  const returnedParameters = new Map<Callable, Set<number>>();
  const escapedSymbols = new Set<Symbol>();
  const escapedFieldNames = new Set<string>();
  let changed = true;
  const mark = <T>(set: Set<T>, value: T | undefined) => {
    if (value === undefined || set.has(value)) return;
    set.add(value);
    changed = true;
  };

  const isTainted = (
    module: Module,
    expression: Parser.Expression,
  ): boolean => {
    switch (expression.type) {
      case "Identifier": {
        const symbol = module.resolved.symbolOf(expression);
        if (symbol)
          return (intrinsicMode ? intrinsicSymbols : taintedSymbols).has(
            symbol,
          );
        return (
          EXTERNAL_GLOBALS.has(expression.name) ||
          taintedGlobals.has(expression.name) ||
          (!STANDARD_GLOBALS.has(expression.name) &&
            !writtenGlobals.has(expression.name))
        );
      }
      case "MemberExpression":
        return (
          isTainted(module, expression.base) ||
          taintedFieldNames.has(expression.identifier.name)
        );
      case "IndexExpression": {
        const key = staticKey(expression.index);
        return (
          isTainted(module, expression.base) ||
          (key !== undefined && taintedFieldNames.has(key))
        );
      }
      case "CallExpression":
      case "TableCallExpression":
      case "StringCallExpression": {
        if (isTainted(module, expression.base)) return true;
        const site = callSiteByNode.get(expression);
        if (!site) return false;
        const args =
          expression.type === "CallExpression"
            ? expression.arguments
            : [
                expression.type === "TableCallExpression"
                  ? expression.arguments
                  : expression.argument,
              ];
        const offset =
          expression.type === "CallExpression" &&
          expression.base.type === "MemberExpression" &&
          expression.base.indexer === ":"
            ? 1
            : 0;
        return [...site.targets].some(
          (target) =>
            taintedReturns.has(target) ||
            [...(returnedParameters.get(target) ?? [])].some((position) => {
              const arg = args.at(position - offset);
              return arg !== undefined && isTainted(module, arg);
            }),
        );
      }
      case "LogicalExpression":
        return (
          isTainted(module, expression.left) ||
          isTainted(module, expression.right)
        );
      default:
        return false;
    }
  };
  const containsTainted = (module: Module, expression: Parser.Expression) => {
    let found = false;
    walkExpression(expression, {
      onExpression: (inner) => {
        if (!found && isTainted(module, inner)) found = true;
      },
    });
    return found;
  };

  // A value read out of an external table (`dial.value`) is usually a scalar. Only a value
  // that is itself an external table may taint a field name, or the name would conflate
  // every unrelated object that happens to use the same spelling.
  const isDirect = (module: Module, expression: Parser.Expression): boolean => {
    switch (expression.type) {
      case "MemberExpression":
      case "IndexExpression":
        return false;
      case "Identifier": {
        const symbol = module.resolved.symbolOf(expression);
        return symbol ? directSymbols.has(symbol) : true;
      }
      case "LogicalExpression":
        return (
          (isTainted(module, expression.left) &&
            isDirect(module, expression.left)) ||
          (isTainted(module, expression.right) &&
            isDirect(module, expression.right))
        );
      default:
        return true;
    }
  };
  const isIntrinsicTainted = (
    module: Module,
    expression: Parser.Expression,
  ): boolean => {
    intrinsicMode = true;
    try {
      return isTainted(module, expression);
    } finally {
      intrinsicMode = false;
    }
  };
  const markSymbol = (
    symbol: Symbol | undefined,
    direct: boolean,
    intrinsic: boolean,
  ) => {
    mark(taintedSymbols, symbol);
    if (direct) mark(directSymbols, symbol);
    if (intrinsic) mark(intrinsicSymbols, symbol);
  };

  const taintTarget = (
    module: Module,
    target: Parser.Expression,
    direct: boolean,
    intrinsic: boolean,
  ) => {
    if (target.type === "Identifier") {
      const symbol = module.resolved.symbolOf(target);
      if (symbol) markSymbol(symbol, direct, intrinsic);
      else mark(taintedGlobals, target.name);
      return;
    }
    if (!direct) return;
    if (target.type === "MemberExpression") {
      mark(taintedFieldNames, target.identifier.name);
      return;
    }
    if (target.type === "IndexExpression") {
      const base = target.base;
      const name = innermostFieldName(base);
      if (name !== undefined) mark(taintedFieldNames, name);
      else if (base.type === "Identifier")
        taintTarget(module, base, direct, intrinsic);
    }
  };

  const escapeValue = (module: Module, value: Parser.Expression) => {
    const markKeys = (constructor: Parser.TableConstructorExpression) => {
      constructor.fields.forEach((field) => {
        if (field.type === "TableKeyString") {
          mark(escapedFieldNames, field.key.name);
          poison(field.key.name, "external-value");
        } else if (field.type === "TableKey") {
          const key = staticKey(field.key);
          if (key !== undefined) poison(key, "external-value");
        }
        if (field.value.type === "TableConstructorExpression")
          markKeys(field.value);
      });
    };
    if (value.type === "TableConstructorExpression") markKeys(value);
    else if (value.type === "Identifier") {
      const symbol = module.resolved.symbolOf(value);
      if (symbol) mark(escapedSymbols, symbol);
    }
  };

  const propagateFunction = (
    module: Module,
    body: readonly Parser.Statement[],
    owner: Callable | undefined,
  ) => {
    const skipped = new WeakSet();
    const visit = (statements: readonly Parser.Statement[]) => {
      statements.forEach((statement) => {
        walkStatement(statement, {
          onFunction: (fn) => skipped.add(fn.body),
          onBlock: (nested) => {
            if (!skipped.has(nested)) visit(nested);
          },
          onExpression: (expression) => {
            if (
              expression.type !== "CallExpression" &&
              expression.type !== "TableCallExpression" &&
              expression.type !== "StringCallExpression"
            )
              return;
            const args =
              expression.type === "CallExpression"
                ? expression.arguments
                : [
                    expression.type === "TableCallExpression"
                      ? expression.arguments
                      : expression.argument,
                  ];
            const calleeExternal = isTainted(module, expression.base);
            if (calleeExternal)
              args.forEach((arg) => {
                escapeValue(module, arg);
              });
            const method =
              expression.type === "CallExpression" &&
              expression.base.type === "MemberExpression" &&
              expression.base.indexer === ":";
            const site = callSiteByNode.get(expression);
            const calleeName =
              expression.base.type === "MemberExpression"
                ? expression.base.identifier.name
                : expression.base.type === "Identifier"
                  ? expression.base.name
                  : undefined;
            const targets = new Set<Callable>(site?.targets ?? []);
            if (!site || site.hasUnknownTarget) {
              // An unresolved call reaches a program function only by spelling. A spelling
              // shared by several functions (`new`, `process`) says nothing, so only a name
              // with one definition is followed.
              const sameName = calleeName
                ? (callablesByName.get(calleeName) ?? [])
                : [];
              if (sameName.length === 1) targets.add(sameName[0]);
            }
            args.forEach((arg, index) => {
              if (!isTainted(module, arg)) return;
              targets.forEach((target) => {
                markSymbol(
                  target.parameters[index + (method ? 1 : 0)],
                  isDirect(module, arg),
                  false,
                );
              });
              if (
                expression.base.type === "MemberExpression" &&
                ["insert", "rawset"].includes(
                  expression.base.identifier.name,
                ) &&
                args[0] &&
                index > 0
              )
                taintTarget(
                  module,
                  args[0],
                  isDirect(module, arg),
                  isIntrinsicTainted(module, arg),
                );
            });
          },
        });
        switch (statement.type) {
          case "LocalStatement":
            statement.variables.forEach((variable, index) => {
              const init = initializerOf(statement.init, index);
              if (init && isTainted(module, init))
                markSymbol(
                  module.resolved.symbolOf(variable),
                  isDirect(module, init),
                  isIntrinsicTainted(module, init),
                );
            });
            break;
          case "AssignmentStatement":
            statement.variables.forEach((variable, index) => {
              const init = initializerOf(statement.init, index);
              if (!init) return;
              if (isTainted(module, init))
                taintTarget(
                  module,
                  variable,
                  isDirect(module, init),
                  isIntrinsicTainted(module, init),
                );
              if (isTainted(module, variable)) escapeValue(module, init);
              if (
                variable.type === "MemberExpression" ||
                variable.type === "IndexExpression"
              ) {
                const root = rootOf(variable);
                const rootSymbol =
                  root.type === "Identifier"
                    ? module.resolved.symbolOf(root)
                    : undefined;
                if (rootSymbol && escapedSymbols.has(rootSymbol)) {
                  const name =
                    variable.type === "MemberExpression"
                      ? variable.identifier.name
                      : staticKey(variable.index);
                  if (name !== undefined) poison(name, "external-value");
                }
                const innerName = innermostFieldName(variable);
                if (innerName !== undefined && escapedFieldNames.has(innerName))
                  escapeValue(module, init);
              }
              if (
                variable.type === "Identifier" &&
                init.type === "TableConstructorExpression"
              ) {
                const symbol = module.resolved.symbolOf(variable);
                if (symbol && escapedSymbols.has(symbol))
                  escapeValue(module, init);
              }
            });
            break;
          case "ForGenericStatement":
            if (statement.iterators.some((it) => containsTainted(module, it)))
              statement.variables.forEach((variable) => {
                markSymbol(
                  module.resolved.symbolOf(variable),
                  true,
                  statement.iterators.some((it) => {
                    intrinsicMode = true;
                    try {
                      return containsTainted(module, it);
                    } finally {
                      intrinsicMode = false;
                    }
                  }),
                );
              });
            break;
          case "ReturnStatement":
            if (owner)
              statement.arguments.forEach((arg) => {
                if (arg.type !== "Identifier") return;
                const position = owner.parameters.indexOf(
                  module.resolved.symbolOf(arg) as Symbol,
                );
                if (position < 0) return;
                const positions = returnedParameters.get(owner) ?? new Set();
                if (!positions.has(position)) {
                  positions.add(position);
                  returnedParameters.set(owner, positions);
                  changed = true;
                }
              });
            if (
              owner &&
              statement.arguments.some((arg) => isIntrinsicTainted(module, arg))
            )
              mark(taintedReturns, owner);
            break;
          default:
            break;
        }
        if (statement.type === "LocalStatement" && statement.init.length > 0) {
          statement.variables.forEach((variable, index) => {
            const init = statement.init.at(index);
            const symbol = module.resolved.symbolOf(variable);
            if (
              init?.type === "TableConstructorExpression" &&
              symbol &&
              escapedSymbols.has(symbol)
            )
              escapeValue(module, init);
          });
        }
      });
    };
    visit(body);
  };

  let iterations = 0;
  while (changed && iterations++ < 100) {
    changed = false;
    objects.modules.forEach((module) => {
      propagateFunction(module, module.chunk.body, undefined);
      module.analysis.callGraph.functions.forEach((callable) => {
        propagateFunction(module, callable.declaration.body, callable);
      });
    });
  }

  // Everything reached through an external value keeps its spelling.
  objects.modules.forEach((module) => {
    walkBlockDeep(module.chunk.body, {
      onExpression: (expression) => {
        if (expression.type === "MemberExpression") {
          if (isTainted(module, expression.base))
            poison(expression.identifier.name, "external-value");
          return;
        }
        if (expression.type === "IndexExpression") {
          const key = staticKey(expression.index);
          if (key !== undefined && isTainted(module, expression.base))
            poison(key, "external-value");
        }
      },
    });
  });

  // Pass 3: explicit contracts and the remaining refusal reasons.
  const never = options.neverRenameFields ?? new Set<string>();
  entries.forEach((entry) => {
    if (never.has(entry.name) || RUNTIME_FIELD_NAMES.has(entry.name))
      entry.reasons.add("external-contract");
    if (entry.name.startsWith(RESERVED_METATABLE_PREFIX))
      entry.reasons.add("reserved-key");
    if (!entry.sites.some((site) => site.definition))
      entry.reasons.add("unowned-field");
    entry.sites.forEach((site) => {
      if (
        site.statement &&
        metadataOf(site.moduleName).annotationsOf(site.statement).keepName
      )
        entry.reasons.add("keep-name");
    });
    if (!IDENTIFIER_PATTERN.test(entry.name)) entry.reasons.add("dynamic-key");
  });

  // Pass 4: assign the shortest names that no existing spelling can collide with.
  const occupied = new Set<string>([...entries.keys(), ...stringLiterals]);
  const candidates = [...entries.values()]
    .filter((entry) => entry.reasons.size === 0 && entry.sites.length > 0)
    .sort(
      (left, right) =>
        right.sites.length - left.sites.length ||
        right.name.length - left.name.length ||
        left.name.localeCompare(right.name),
    );
  const assigned = new Map<string, string>();
  let counter = 0;
  candidates.forEach((entry) => {
    let candidate = generateCandidate(counter++);
    while (!isAvailable(candidate, occupied))
      candidate = generateCandidate(counter++);
    if (candidate.length >= entry.name.length) {
      entry.reasons.add("nonpositive-cost");
      counter--;
      return;
    }
    assigned.set(entry.name, candidate);
  });

  const renameByNode = new WeakMap<
    Parser.Identifier | Parser.StringLiteral,
    string
  >();
  const originalByNode = new WeakMap<
    Parser.Identifier | Parser.StringLiteral,
    string
  >();
  const diagnostics: WholeProgramFieldRenameDiagnostic[] = [];
  entries.forEach((entry) => {
    const first = entry.sites.at(0);
    const range = first ? sourceRangeOf(first.node) : undefined;
    const moduleName = first?.moduleName ?? entryModule;
    diagnostics.push({
      moduleName,
      field: entry.name,
      reason: "field-candidate",
      accepted: true,
      sourceRange: range,
    });
    [...entry.reasons].sort().forEach((reason) =>
      diagnostics.push({
        moduleName,
        field: entry.name,
        reason: reason,
        accepted: false,
        sourceRange: range,
      }),
    );
    const name = assigned.get(entry.name);
    if (!name) return;
    entry.sites.forEach((site) => {
      renameByNode.set(site.node, name);
      originalByNode.set(site.node, entry.name);
    });
    diagnostics.push({
      moduleName,
      field: entry.name,
      reason: "field-renamed",
      accepted: true,
      sourceRange: range,
    });
  });

  return {
    generation: objects.generation,
    candidateFields: entries.size,
    equivalenceClasses: entries.size,
    keyTransfers: 0,
    shortenedFields: assigned.size,
    reusedKeys: 0,
    diagnostics: diagnostics.sort(
      (left, right) =>
        left.moduleName.localeCompare(right.moduleName) ||
        (left.field ?? "").localeCompare(right.field ?? "") ||
        left.reason.localeCompare(right.reason),
    ),
    nameOf: (node) => renameByNode.get(node),
    originalNameOf: (node) => originalByNode.get(node),
  };
}
