// #44の定数畳み込み(--fold-constants)を、本物のLua 5.3インタプリタと突き合わせる
// 差分テスト。
//
// このプロジェクトのCIにはLuaが入っていないため、実行環境にLua 5.3(または
// 整数/浮動小数点の区別がLua 5.3と同じLua 5.4)が見つからない場合は、
// 理由を添えてスキップする。ローカルで検証する場合は`lua5.3`/`lua5.4`/`lua`
// のいずれかをPATHに置くか、LUA53_BIN環境変数でインタプリタのパスを
// 指定すること。
//
// Lua 5.3.6が使える環境でこのテストを実行すると、現時点(2026-08-21)では
// 失敗する。これはこのテストのバグではなく、検証によって実際に見つかった
// 2件の不具合を、そのまま隠さず報告しているため。
//   1. `constantFold.ts`の浮動小数点`%`の実装(`a - floor(a/b)*b`)は、
//      両辺の絶対値の比が極端(例: `10 % 1e-300`)なとき、中間の掛け戻しで
//      桁落ちし、Luaの実際の`fmod`ベースの実装と異なる値(0)に丸まる。
//      例: `-(((32 and 4) ~ (10 % 1e-300)))` はオリジナルでは`10 % 1e-300`が
//      非ゼロの微小値になり`~`が「整数として表現できない」エラーになるが、
//      畳み込み後は0として畳み込まれ`~`が通ってしまい、誤った値`-4`を返す。
//   2. `ast2lua.ts`の印字処理には、`..`(連結、Luaでは`+ - * / // %`はもちろん
//      比較・ビット演算より優先順位が低い)が、より優先順位の高い演算子の
//      オペランドとして現れるときに必要な丸括弧を省略してしまう不具合がある。
//      これは`--fold-constants`の有無に関わらず再現する既存の不具合だが、
//      畳み込みがASTを差し替える過程で、元の括弧を守っていた構造が失われ、
//      畳み込み時にだけ顕在化するケースもある(例: 上記のうち1件)。
// 詳細はこのテストの実行時ログ(console.warnの出力)に、不一致ごとの式・
// 期待値・実際の値が出力される。
import { test } from "vitest";
import assert from "node:assert/strict";
import { detectLua } from "./luaDetect";
import { REQUIRED_EXPRESSIONS, generateRandomExpressions } from "./expressions";
import {
  compareCase,
  makeTmpRoot,
  runCasesRobust,
  runStandalone,
  Mismatch,
} from "./runDifferential";

const lua = detectLua();
// スキップ時の理由をレポーター種別によらず出力に残すためのフォールバック。
console.warn(`[differential/constantFold] Lua検出結果: ${lua.reason}`);

// ランダム式は再現性のため固定シード。件数は要求(数千件)を満たす3000件。
const RANDOM_SEED = 442026;
const RANDOM_COUNT = 3000;
const BATCH_SIZE = 200;

test(
  "定数畳み込み(--fold-constants)は本物のLua 5.3系と、値・math.typeによる整数/浮動小数点の区別・実行時エラーが完全一致する",
  { timeout: 180_000 },
  (ctx) => {
    if (!lua.available) {
      ctx.skip(lua.reason);
      return;
    }
    const luaBin = lua.bin as string;

    const allExprs = [
      ...REQUIRED_EXPRESSIONS,
      ...generateRandomExpressions(RANDOM_COUNT, RANDOM_SEED),
    ];
    const cases = allExprs.map((expr, i) => ({ index: i, expr }));
    const tried = cases.length;

    const tmpRoot = makeTmpRoot();
    const run = runCasesRobust(cases, luaBin, tmpRoot, BATCH_SIZE);

    // printerDefects(既存のミニファイア印字処理の不具合。畳み込みとは無関係で
    // fold/nofold両方で再現する)に該当するインデックスは、畳み込みの正誤判定
    // からは除外する(既に個別の不具合として記録済みのため)。
    const foldDefectIdx = new Set(
      run.printerDefects.filter((d) => d.variant === "fold").map((d) => d.index),
    );
    const nofoldDefectIdx = new Set(
      run.printerDefects
        .filter((d) => d.variant === "nofold")
        .map((d) => d.index),
    );

    const mismatches: Mismatch[] = [];
    // --fold-constantsを外した(畳み込み無効の)ミニファイとの比較。オリジナルとの
    // 不一致がfoldのせいなのか、renameなど既存の他パスのせいなのかを切り分ける
    // ための参考情報であり、合否判定には使わない。
    const nofoldMismatches: Mismatch[] = [];

    for (const { index, expr } of cases) {
      const o = run.origResults.get(index);
      if (!foldDefectIdx.has(index)) {
        const f = run.foldResults.get(index);
        const m = compareCase(expr, index, o, f);
        if (m) mismatches.push(m);
      }
      if (!nofoldDefectIdx.has(index)) {
        const nf = run.nofoldResults.get(index);
        const nm = compareCase(expr, index, o, nf);
        if (nm) nofoldMismatches.push(nm);
      }
    }

    // 不一致が出た式は、バッチ化(pcall+関数でのラップ)自体が原因でないことを
    // 確認するため、要求仕様どおりの最小形で単独再実行する。
    const confirmations = mismatches.map((m) => {
      const origRun = runStandalone(
        m.expr,
        luaBin,
        tmpRoot,
        `orig-${m.index}`,
        false,
      );
      const foldRun = runStandalone(
        m.expr,
        luaBin,
        tmpRoot,
        `fold-${m.index}`,
        true,
      );
      return {
        ...m,
        standalone: {
          origStdout: origRun.stdout.trim(),
          foldStdout: foldRun.stdout.trim(),
          reproducedStandalone: origRun.stdout.trim() !== foldRun.stdout.trim(),
        },
      };
    });

    console.warn(
      `[differential/constantFold] Lua=${lua.version} bin=${luaBin} / ` +
        `試行 ${tried}件 / 不一致(オリジナル vs --fold-constants) ${mismatches.length}件 / ` +
        `参考:不一致(オリジナル vs 畳み込み無効) ${nofoldMismatches.length}件 / ` +
        `既存の印字処理の不具合(畳み込みと無関係、除外済み) ${run.printerDefects.length}件 / ` +
        `原因不明のハーネス異常 ${run.unexplainedFailures.length}件`,
    );
    if (run.printerDefects.length > 0) {
      console.warn(
        "[differential/constantFold] printer defects (既存の区切り文字挿入バグ、fold/nofold両方で再現、#44とは無関係):\n" +
          run.printerDefects.map((d) => JSON.stringify(d)).join("\n"),
      );
    }
    if (run.unexplainedFailures.length > 0) {
      console.warn(
        "[differential/constantFold] unexplained harness failures:\n" +
          run.unexplainedFailures.join("\n"),
      );
    }
    if (confirmations.length > 0) {
      console.warn(
        "[differential/constantFold] mismatches:\n" +
          confirmations.map((m) => JSON.stringify(m, null, 2)).join("\n"),
      );
    }

    assert.deepEqual(
      run.unexplainedFailures,
      [],
      "生成した式が原因不明でオリジナル実行に失敗した(ハーネス自体の異常)",
    );
    assert.deepEqual(
      mismatches.map((m) => ({ index: m.index, expr: m.expr, kind: m.kind })),
      [],
      `オリジナルと--fold-constants適用後でLuaの実行結果が一致しない式が${mismatches.length}件見つかった(詳細はconsole.warn出力を参照)`,
    );
  },
);
