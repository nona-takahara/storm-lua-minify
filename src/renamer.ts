// Renameパス（#20）: Resolveパス（#19）が構築したシンボルテーブルをもとに、
// シンボル単位で短縮識別子を割り当てる。printer（ast2lua.ts）は出力時の
// その場リネームを行わず、このパスが決めた名前を参照するだけになる。
//
// CFG livenessから干渉グラフを作り、同時に生きないlocalへ同じ色を割り当てる。
// resolverのscope関係による字句衝突辺と、割当名による再Resolve検証を併用し、
// shadowingやcaptureで参照先が変わらないことを保証する。
//
// 予約語・"self"・呼び出し側が指定する予約名（グローバル参照やStormworks APIなど）
// は、どのシンボルにも割り当てられない。
import Parser from "luaparse";
import { Scope, Symbol, ResolveResult, resolveScopes } from "./resolver";
import { IDENTIFIER_PARTS, isKeyword } from "./ast2lua";
import { analyzeControlFlow } from "./controlFlow";
import { analyzeOptimizerFacts, OptimizerFacts } from "./optimizerFacts";
import {
  analyzeSymbolLiveness,
  SymbolLivenessAnalysis,
} from "./symbolLiveness";

export interface RenameResult {
  // identifierがResolveパスで解決済みのローカルシンボルに対応する場合、
  // 割り当てられた短縮名を返す。グローバル参照やフィールド名など対応する
  // シンボルが無い場合はundefinedを返す（呼び出し側は元の名前を使う）。
  nameOf(identifier: Parser.Identifier): string | undefined;
  // このモジュールが実際に割り当てた短縮名の集合。requireの展開先が
  // 呼び出し元と同じLuaスコープに直接展開される場合（dofile等、関数で
  // 包まれない展開）があるため、他モジュールの割当と衝突しないよう
  // 呼び出し側（Minifier）はこれを後続モジュールの予約名に積み増す。
  readonly usedNames: ReadonlySet<string>;
}

export function isAvailable(
  id: string,
  reserved: ReadonlySet<string>,
): boolean {
  return id !== "self" && !isKeyword(id) && !reserved.has(id);
}

// 0始まりのカウンタから短縮名候補を生成する（バイジェクティブ基数記数法）。
// 通常の位取り記数法と違い同じ文字列を2つのカウンタ値が指すことがないため、
// カウンタを増やし続けるだけで重複なく識別子候補を列挙できる。
export function generateCandidate(counter: number): string {
  const l = IDENTIFIER_PARTS.length;
  let num = counter + 1;
  let id = "";
  while (num > 0) {
    const rem = (num - 1) % l;
    id = IDENTIFIER_PARTS[rem] + id;
    num = Math.floor((num - 1) / l);
  }
  return id;
}

export interface RenameOptions {
  /** Allow same-scope lifetime reuse when local lifetime is not observable. */
  readonly allowLocalNameReuse?: boolean;
  /** Reuse the exact optimizer generation already built by the scheduler. */
  readonly analysis?: {
    readonly facts: OptimizerFacts;
    readonly liveness: SymbolLivenessAnalysis;
  };
}

export function assignRenames(
  chunk: Parser.Chunk,
  resolveResult: ResolveResult,
  reserved: ReadonlySet<string>,
  // #8a: プログラム全体を横断して決定されたグローバル識別子の短縮名。
  // 全モジュールに対して同じマップを渡すことで、モジュールをまたいで
  // 共有される1つのランタイム束縛に一貫した短縮名を割り当てられる。
  globalRenames?: ReadonlyMap<string, string>,
  keepNames: ReadonlySet<Symbol> = new Set(),
  options: RenameOptions = {},
): RenameResult {
  const unavailableNames = new Set(reserved);
  keepNames.forEach((symbol) => unavailableNames.add(symbol.name));
  const variables = resolveResult.symbols.filter(
    (symbol) =>
      symbol.kind !== "label" &&
      symbol.name !== "self" &&
      !keepNames.has(symbol),
  );
  const variableGraph = buildVariableInterference(
    chunk,
    resolveResult,
    variables,
    options.allowLocalNameReuse === true,
    options.analysis,
  );
  const variableColors = colorGraph(variableGraph);
  const variableNames = assignColorNames(variableColors, unavailableNames);

  // Labels have a separate Lua namespace. Color them independently so a label
  // and a local may share a short spelling, while usedNames still reserves the
  // spelling against labels from subsequently spliced modules.
  const labels = resolveResult.symbols.filter(
    (symbol) =>
      symbol.kind === "label" &&
      symbol.name !== "self" &&
      !keepNames.has(symbol),
  );
  const labelNames = assignColorNames(
    colorGraph(buildLexicalGraph(labels, false)),
    unavailableNames,
  );
  const nameOfSymbol = new Map([...variableNames, ...labelNames]);
  validateBindings(chunk, resolveResult, nameOfSymbol, globalRenames);
  const usedNames = new Set(nameOfSymbol.values());

  return {
    nameOf: (identifier) => {
      // メソッド定義の暗黙のselfパラメータは慣習的な名前のため常に維持する
      // （呼び出し側から見える名前ではないため短縮しても安全ではあるが、
      // 可読性のために元の名前のままにする）。
      if (identifier.name === "self") {
        return undefined;
      }
      const symbol = resolveResult.symbolOf(identifier);
      if (symbol) {
        return nameOfSymbol.get(symbol);
      }
      // フィールド名（`.foo`）はここに来るが、これらはisGlobalReferenceが
      // falseになるため名前文字列がたまたま一致しても誤ってリネームしない。
      if (globalRenames && resolveResult.isGlobalReference(identifier)) {
        return globalRenames.get(identifier.name);
      }
      return undefined;
    },
    usedNames,
  };
}

type InterferenceGraph = ReadonlyMap<Symbol, ReadonlySet<Symbol>>;

function buildVariableInterference(
  chunk: Parser.Chunk,
  resolved: ResolveResult,
  symbols: readonly Symbol[],
  allowLocalNameReuse: boolean,
  analysis: RenameOptions["analysis"],
): InterferenceGraph {
  const graph = mutableGraph(symbols);
  const facts = analysis?.facts ?? analyzeOptimizerFacts(chunk, resolved);
  const liveness =
    analysis?.liveness ??
    analyzeSymbolLiveness(analyzeControlFlow(chunk, resolved), facts);
  if (facts.generation !== liveness.controlFlow.version)
    throw new Error("Identifier coloring requires one AST generation");

  liveness.controlFlow.nodes.forEach((node) => {
    addClique(graph, liveness.liveIn(node));
    addClique(graph, liveness.liveOut(node));
    liveness.defs(node).forEach((definition) => {
      liveness.liveOut(node).forEach((live) => {
        addEdge(graph, definition, live);
      });
    });
  });

  // Parameters, generic-for variables, and multi-local declarations bind as a
  // group. Giving two members one spelling would make only the last binding
  // addressable after reparsing even if one member happens to be unused.
  const declarationsByOwner = new Map<Parser.Statement, Symbol[]>();
  symbols.forEach((symbol) => {
    const declaration = facts
      .operationsOfSymbol(symbol)
      .find(
        (operation) =>
          operation.kind === "declare" &&
          operation.origin === symbol.declaration,
      );
    if (!declaration) return;
    const group = declarationsByOwner.get(declaration.owner) ?? [];
    group.push(symbol);
    declarationsByOwner.set(declaration.owner, group);
  });
  declarationsByOwner.forEach((group) => {
    addClique(graph, group);
  });

  // A captured binding can be shadowed inside the closure by any same-scope
  // declaration whose emitted spelling matches it (notably `local function`).
  // Extending this lexical interference across the whole declaring scope is
  // conservative, deterministic, and leaves ordinary non-captured locals free
  // to reuse names according to liveness.
  symbols.forEach((symbol) => {
    const captured = facts
      .operationsOfSymbol(symbol)
      .some(
        (operation) =>
          "location" in operation && operation.location.kind === "upvalue",
      );
    if (!captured) return;
    symbols.forEach((other) => {
      if (other.scope === symbol.scope) addEdge(graph, symbol, other);
    });
  });

  addLexicalEdges(graph, symbols, allowLocalNameReuse);
  return graph;
}

function buildLexicalGraph(
  symbols: readonly Symbol[],
  allowSameScopeReuse: boolean,
): InterferenceGraph {
  const graph = mutableGraph(symbols);
  addLexicalEdges(graph, symbols, allowSameScopeReuse);
  return graph;
}

function mutableGraph(symbols: readonly Symbol[]): Map<Symbol, Set<Symbol>> {
  return new Map(symbols.map((symbol) => [symbol, new Set<Symbol>()]));
}

function addLexicalEdges(
  graph: Map<Symbol, Set<Symbol>>,
  symbols: readonly Symbol[],
  allowSameScopeReuse: boolean,
): void {
  for (let left = 0; left < symbols.length; left++) {
    for (let right = left + 1; right < symbols.length; right++) {
      const first = symbols[left];
      const last = symbols[right];
      if (
        isAncestor(first.scope, last.scope) ||
        isAncestor(last.scope, first.scope) ||
        (!allowSameScopeReuse && first.scope === last.scope)
      )
        addEdge(graph, first, last);
    }
  }
}

function isAncestor(ancestor: Scope, descendant: Scope): boolean {
  if (ancestor === descendant) return false;
  for (let current = descendant.parent; current; current = current.parent)
    if (current === ancestor) return true;
  return false;
}

function addClique(
  graph: Map<Symbol, Set<Symbol>>,
  symbols: ReadonlySet<Symbol> | readonly Symbol[],
): void {
  const present = [...symbols].filter((symbol) => graph.has(symbol));
  for (let left = 0; left < present.length; left++)
    for (let right = left + 1; right < present.length; right++)
      addEdge(graph, present[left], present[right]);
}

function addEdge(
  graph: Map<Symbol, Set<Symbol>>,
  first: Symbol,
  last: Symbol,
): void {
  if (first === last || !graph.has(first) || !graph.has(last)) return;
  graph.get(first)?.add(last);
  graph.get(last)?.add(first);
}

/** Deterministic weighted DSATUR coloring. */
function colorGraph(graph: InterferenceGraph): Map<Symbol, number> {
  const colors = new Map<Symbol, number>();
  while (colors.size < graph.size) {
    const remaining = [...graph.keys()].filter((symbol) => !colors.has(symbol));
    remaining.sort((left, right) => {
      const saturationDifference =
        saturation(graph, colors, right) - saturation(graph, colors, left);
      if (saturationDifference !== 0) return saturationDifference;
      const weightDifference = weightOf(right) - weightOf(left);
      if (weightDifference !== 0) return weightDifference;
      const degreeDifference =
        (graph.get(right)?.size ?? 0) - (graph.get(left)?.size ?? 0);
      return degreeDifference !== 0 ? degreeDifference : left.id - right.id;
    });
    const symbol = remaining[0];
    const unavailable = new Set(
      [...(graph.get(symbol) ?? [])].flatMap((neighbor) => {
        const color = colors.get(neighbor);
        return color === undefined ? [] : [color];
      }),
    );
    let color = 0;
    while (unavailable.has(color)) color++;
    colors.set(symbol, color);
  }
  return colors;
}

function saturation(
  graph: InterferenceGraph,
  colors: ReadonlyMap<Symbol, number>,
  symbol: Symbol,
): number {
  return new Set(
    [...(graph.get(symbol) ?? [])].flatMap((neighbor) => {
      const color = colors.get(neighbor);
      return color === undefined ? [] : [color];
    }),
  ).size;
}

function weightOf(symbol: Symbol): number {
  return symbol.references.length + 1;
}

function assignColorNames(
  colors: ReadonlyMap<Symbol, number>,
  reserved: ReadonlySet<string>,
): Map<Symbol, string> {
  const unavailable = new Set(reserved);
  const weightByColor = new Map<number, number>();
  const firstSymbolByColor = new Map<number, number>();
  colors.forEach((color, symbol) => {
    weightByColor.set(
      color,
      (weightByColor.get(color) ?? 0) + weightOf(symbol),
    );
    firstSymbolByColor.set(
      color,
      Math.min(firstSymbolByColor.get(color) ?? symbol.id, symbol.id),
    );
  });
  const orderedColors = [...weightByColor.keys()].sort(
    (left, right) =>
      (weightByColor.get(right) ?? 0) - (weightByColor.get(left) ?? 0) ||
      (firstSymbolByColor.get(left) ?? 0) -
        (firstSymbolByColor.get(right) ?? 0),
  );
  const nameByColor = new Map<number, string>();
  let counter = 0;
  orderedColors.forEach((color) => {
    let candidate: string;
    do candidate = generateCandidate(counter++);
    while (!isAvailable(candidate, unavailable));
    unavailable.add(candidate);
    nameByColor.set(color, candidate);
  });

  // Every candidate is an identifier token and keywords are excluded, so the
  // separator cost around each occurrence is invariant across candidates.
  // Occurrence count therefore gives the exact candidate-dependent byte cost.
  const result = new Map<Symbol, string>();
  colors.forEach((color, symbol) => {
    const name = nameByColor.get(color);
    if (name === undefined) throw new Error("Colored symbol has no name");
    result.set(symbol, name);
  });
  return result;
}

function validateBindings(
  chunk: Parser.Chunk,
  original: ResolveResult,
  names: ReadonlyMap<Symbol, string>,
  globalRenames: ReadonlyMap<string, string> | undefined,
): void {
  const recolored = resolveScopes(chunk, {
    identifierName: (identifier) => {
      const symbol = original.symbolOf(identifier);
      if (symbol) return names.get(symbol) ?? identifier.name;
      return original.isGlobalReference(identifier)
        ? (globalRenames?.get(identifier.name) ?? identifier.name)
        : identifier.name;
    },
  });
  original.symbols.forEach((symbol) => {
    [symbol.declaration, ...symbol.references].forEach((identifier) => {
      if (recolored.symbolOf(identifier)?.declaration !== symbol.declaration)
        throw new Error(
          `Identifier coloring changed binding for symbol ${String(symbol.id)}`,
        );
    });
  });
  original.globals.forEach((binding) => {
    binding.references.forEach((identifier) => {
      if (!recolored.isGlobalReference(identifier))
        throw new Error(`Identifier coloring captured global ${binding.name}`);
    });
  });
}
