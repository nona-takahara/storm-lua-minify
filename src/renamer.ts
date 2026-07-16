// Renameパス（#20）: Resolveパス（#19）が構築したシンボルテーブルをもとに、
// シンボル単位で短縮識別子を割り当てる。printer（ast2lua.ts）は出力時の
// その場リネームを行わず、このパスが決めた名前を参照するだけになる。
//
// 割当は2段階で行う。
//   1. スロット割当: スコープ木を辿り、各シンボルに整数のスロットを割り当てる。
//      兄弟スコープ同士（親子関係にないスコープ同士）は生存区間が重ならないため、
//      同じスロットを再利用できる（圧縮率の向上）。同一スコープ内のシンボル同士・
//      祖先スコープのシンボルとは必ず異なるスロットになるため、シンボルの生存
//      スコープ内で名前が衝突することはない。
//   2. 名前割当: スロットごとの参照回数（頻度）を集計し、頻度の高いスロットから
//      順に短い名前を割り当てる。頻度の高いシンボルほど短い名前になるため、
//      同じスロット数でも出力サイズが最小化される。
//
// 予約語・"self"・呼び出し側が指定する予約名（グローバル参照やStormworks APIなど）
// は、どのシンボルにも割り当てられない。
import Parser from "luaparse";
import { Scope, Symbol, ResolveResult } from "./resolver";
import { IDENTIFIER_PARTS, isKeyword } from "./ast2lua";

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

function isAvailable(id: string, reserved: ReadonlySet<string>): boolean {
  return id !== "self" && !isKeyword(id) && !reserved.has(id);
}

// 0始まりのカウンタから短縮名候補を生成する（バイジェクティブ基数記数法）。
// 通常の位取り記数法と違い同じ文字列を2つのカウンタ値が指すことがないため、
// カウンタを増やし続けるだけで重複なく識別子候補を列挙できる。
function generateCandidate(counter: number): string {
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

/**
 * スコープ木のDFSでシンボルごとにスロット番号を割り当てる。
 * `active`は祖先スコープ（自分を含む）で既に使われているスロットの集合。
 * 兄弟スコープには同じ`active`のコピーが渡されるため、互いの割当は影響しない。
 */
function assignSlots(
  scope: Scope,
  active: ReadonlySet<number>,
): Map<Symbol, number> {
  const slotOf = new Map<Symbol, number>();
  const used = new Set(active);

  scope.symbols.forEach((symbol) => {
    let slot = 0;
    while (used.has(slot)) {
      slot++;
    }
    slotOf.set(symbol, slot);
    used.add(slot);
  });

  scope.children.forEach((child) => {
    assignSlots(child, used).forEach((slot, symbol) => {
      slotOf.set(symbol, slot);
    });
  });

  return slotOf;
}

export function assignRenames(
  resolveResult: ResolveResult,
  reserved: ReadonlySet<string>,
): RenameResult {
  const slotOf = assignSlots(resolveResult.chunkScope, new Set());

  // スロットの通算参照回数（宣言自体も1回として数える）を集計する。
  const weightOfSlot = new Map<number, number>();
  resolveResult.symbols.forEach((symbol) => {
    const slot = slotOf.get(symbol);
    if (slot === undefined) {
      return;
    }
    const weight = symbol.references.length + 1;
    weightOfSlot.set(slot, (weightOfSlot.get(slot) ?? 0) + weight);
  });

  const orderedSlots = [...weightOfSlot.keys()].sort(
    (a, b) => (weightOfSlot.get(b) ?? 0) - (weightOfSlot.get(a) ?? 0),
  );

  const nameOfSlot = new Map<number, string>();
  let counter = 0;
  orderedSlots.forEach((slot) => {
    let candidate: string;
    do {
      candidate = generateCandidate(counter++);
    } while (!isAvailable(candidate, reserved));
    nameOfSlot.set(slot, candidate);
  });

  const nameOfSymbol = new Map<Symbol, string>();
  slotOf.forEach((slot, symbol) => {
    const name = nameOfSlot.get(slot);
    if (name !== undefined) {
      nameOfSymbol.set(symbol, name);
    }
  });

  return {
    nameOf: (identifier) => {
      // メソッド定義の暗黙のselfパラメータは慣習的な名前のため常に維持する
      // （呼び出し側から見える名前ではないため短縮しても安全ではあるが、
      // 可読性のために元の名前のままにする）。
      if (identifier.name === "self") {
        return undefined;
      }
      const symbol = resolveResult.symbolOf(identifier);
      return symbol ? nameOfSymbol.get(symbol) : undefined;
    },
    usedNames: new Set(nameOfSlot.values()),
  };
}
