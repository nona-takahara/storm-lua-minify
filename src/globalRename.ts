// #8a: 内部でのみ使用するグローバル識別子の短縮。
//
// グローバル名はモジュールをまたいで1つのランタイム束縛を共有する
// （Luaのグローバルは単一の_ENVテーブルを介して全ファイルで共有される）。
// そのため、ローカル変数のRenameパス（renamer.ts）とは異なり、あるモジュールの
// スコープ内だけで完結させず、リンクされた全モジュールを横断して1回だけ
// 判定・採番する。
//
// 「内部でのみ使用する」とみなす条件は、プログラム中のどこか（どのモジュールでも
// よい）で代入先として出現していること（resolver.tsのGlobalBinding.writes）。
// 一度も代入されていないグローバルは、エンジンや標準ライブラリなど外部から
// 供給される値を読むだけとみなし、安全側に倒してリネームしない。
//
// この「代入されていれば内部用」というヒューリスティックだけでは、
// エンジン側が特定の名前を探して呼び出す規約（コールバックエントリポイント）を
// 誤ってリネームしてしまう危険がある。そのようなコールバック名は
// `neverRename`（configのnever-rename-globalsまたはCLI指定由来）に
// 含めることで、代入の有無に関わらず常にリネーム対象から除外する。
import { ResolveResult } from "./resolver";
import { generateCandidate, isAvailable } from "./renamer";
import { RESERVED_MODULE_FUNCTION_NAMES } from "./linker";

/**
 * Returns names whose shared global binding is written by any linked module.
 * A module that only reads one of these names must not mistake it for a
 * read-only value supplied by the runtime environment.
 */
export function collectProgramWrittenGlobals(
  moduleResolve: ReadonlyMap<string, ResolveResult>,
): Set<string> {
  const written = new Set<string>();
  moduleResolve.forEach((resolved) => {
    resolved.globals.forEach((binding) => {
      if (binding.writes.length > 0) written.add(binding.name);
    });
  });
  return written;
}

export function classifyAndRenameGlobals(
  moduleResolve: ReadonlyMap<string, ResolveResult>,
  neverRename: ReadonlySet<string>,
  reserved: ReadonlySet<string>,
): Map<string, string> {
  const everWritten = collectProgramWrittenGlobals(moduleResolve);
  const totalReferenceCount = new Map<string, number>();

  moduleResolve.forEach((resolved) => {
    resolved.globals.forEach((binding) => {
      totalReferenceCount.set(
        binding.name,
        (totalReferenceCount.get(binding.name) ?? 0) +
          binding.references.length,
      );
    });
  });

  // require/dofileはPrintパスが名前文字列で再検出するため、通常は代入対象に
  // ならないが（そのため既にeverWrittenに入らない）、ユーザーコードが
  // `require = ...`のように再代入する非現実的なケースへの防御として明示的にも除外する。
  const qualifying = [...everWritten].filter(
    (name) =>
      !neverRename.has(name) && !RESERVED_MODULE_FUNCTION_NAMES.has(name),
  );

  const orderedNames = qualifying.sort(
    (a, b) =>
      (totalReferenceCount.get(b) ?? 0) - (totalReferenceCount.get(a) ?? 0),
  );

  const usedShortNames = new Set<string>(reserved);
  const globalRenames = new Map<string, string>();
  let counter = 0;
  orderedNames.forEach((name) => {
    let candidate: string;
    do {
      candidate = generateCandidate(counter++);
    } while (!isAvailable(candidate, usedShortNames));
    usedShortNames.add(candidate);
    globalRenames.set(name, candidate);
  });

  return globalRenames;
}
