// #44の定数畳み込み(--fold-constants)を、本物のLua 5.3インタプリタと突き合わせる
// 差分テスト。
//
// このプロジェクトのCIにはLuaが入っていないため、実行環境にLua 5.3(または
// 整数/浮動小数点の区別がLua 5.3と同じLua 5.4)が見つからない場合は、
// 理由を添えてスキップする。ローカルで検証する場合は`lua5.3`/`lua5.4`/`lua`
// のいずれかをPATHに置くか、LUA53_BIN環境変数でインタプリタのパスを
// 指定すること。
//
// 浮動小数点`%`の精度不具合(`a - floor(a/b)*b`が極端な桁比で桁落ちする件、
// `10 % 1e-300`が0に丸まっていた)はfmod方式への書き換えで修正済み
// (constantFold.ts, `%`のfloat分岐)。
//
// 残っていた2件の印字処理の不具合(`--fold-constants`の有無に関わらず再現する、
// 畳み込みとは独立した既存の不具合)も、このPRで修正済み。
//   - Issue #52: `..`(連結)が`+ - * / // %`・単項演算子(`not # - ~`)・`^`の
//     直接のオペランドになるとき、印字処理が必要な丸括弧を落としていた
//     (ast2lua.tsのformatExpression、`^`/`..`の結合則決定と丸括弧要否の判定が
//     同じelse-ifチェーンに入っていたため、`^`と`..`だけ丸括弧の判定自体が
//     素通りしていた)。
//   - Issue #53: 16進整数リテラルが`a`〜`f`で終わり、直後に`..`が続くとき、
//     区切りの空白が抜けていた(ast2lua.tsのisNeedSeparator、識別子向けの
//     「直前が英字なら区切り不要」という判定に16進リテラルの末尾も
//     入り込んでいたため)。
//
// このテストは、不一致を「式そのもの」の固定リストではなく、issue52.tsの
// `matchesIssue52Pattern`(AST上で`..`式が優先順位の高い演算子の直接のオペランド
// になっているかを判定する)で分類する。ランダム式はシードを変えると変わるため、
// 固定リストでの判定は壊れやすい。#52は修正済みなのでこの分類に該当する不一致は
// 今後0件であるべきだが、分類ロジック自体は将来同種の不具合が入り込んだ場合の
// 切り分けに使えるため残している。
//   - 説明の有無に関わらず、不一致が1件でもあればテストを失敗させる
//     (現状は#52分の許容がなくなったので、mismatches全体を0件で判定する)。
import { test } from "vitest";
import assert from "node:assert/strict";
import { detectLua } from "./luaDetect";
import { REQUIRED_EXPRESSIONS, generateRandomExpressions } from "./expressions";
import { matchesIssue52Pattern } from "./issue52";
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

// シード442026・3000件の現状(2026-08-21、#52・#53の修正後)で実際に観測した件数。
// どちらも0であるべき値を、存在チェック(`> 0`)ではなく件数の一致として基準値に
// 置いているのは、将来どちらかの不具合が(部分的にでも)再発したときに、
// 「0件のままなので気づけない」を避けるため。数が動いたら、#52/#53(または
// それに似た新しい印字処理の不具合)の状態を確認してから更新すること。
const EXPECTED_ISSUE52_MISMATCHES = 0;
const EXPECTED_SEPARATOR_BUG_DEFECTS = 0;

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
      run.printerDefects
        .filter((d) => d.variant === "fold")
        .map((d) => d.index),
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
        `orig-${String(m.index)}`,
        false,
      );
      const foldRun = runStandalone(
        m.expr,
        luaBin,
        tmpRoot,
        `fold-${String(m.index)}`,
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
      `[differential/constantFold] Lua=${lua.version ?? "unknown"} bin=${luaBin} / ` +
        `試行 ${String(tried)}件 / 不一致(オリジナル vs --fold-constants) ${String(mismatches.length)}件 / ` +
        `参考:不一致(オリジナル vs 畳み込み無効) ${String(nofoldMismatches.length)}件 / ` +
        `既存の印字処理の不具合(畳み込みと無関係、除外済み) ${String(run.printerDefects.length)}件 / ` +
        `原因不明のハーネス異常 ${String(run.unexplainedFailures.length)}件`,
    );
    if (run.printerDefects.length > 0) {
      console.warn(
        "[differential/constantFold] printer defects (既存の区切り文字挿入バグ、fold/nofold両方で再現、#44とも#52とも別の不具合):\n" +
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

    // printerDefects(バッチ全体が構文エラーで比較不能になったケース)は、
    // 現時点で確認できている限りすべて「16進整数リテラルが`a`〜`f`で終わり、
    // 直後に`..`が続く」ときに区切りの空白が抜け、Luaの字句解析が
    // `malformed number`で失敗するという単一のパターン(Issue #53)に由来していた。
    // #53はこのPRで修正済みなので、以降このパターンで壊れることは無いはずだが、
    // 万一別の理由でバッチが壊れた場合に未知の問題として検知できるよう、
    // シグネチャでの絞り込み自体は残している。
    const unexpectedPrinterDefects = run.printerDefects.filter(
      (d) => !/malformed number/.test(d.stderr),
    );
    assert.deepEqual(
      unexpectedPrinterDefects,
      [],
      "既知だった16進リテラル+`..`の区切り文字バグ(Issue #53、修正済み)のシグネチャ" +
        "以外の理由でミニファイア出力が構文エラーになった。新しい印字処理の不具合の" +
        "可能性がある。",
    );
    // 件数そのものが動いたら気づけるようにする(#53は修正済みなので基準値は0。
    // 増えたら再発、というだけでなく、0のままでも比較不能ケースが別経路で
    // 混入していないかをこの一致判定自体が保証する)。
    assert.equal(
      run.printerDefects.length,
      EXPECTED_SEPARATOR_BUG_DEFECTS,
      `Issue #53(修正済み)のシグネチャによるprinterDefectsが` +
        `${String(EXPECTED_SEPARATOR_BUG_DEFECTS)}件から` +
        `${String(run.printerDefects.length)}件に変化した。再発した場合は#53の状態を` +
        `確認すること。`,
    );

    // 残る不一致を、Issue #52の条件(AST上で`..`式が優先順位の高い演算子の
    // 直接のオペランドになっている)で説明できるかどうかに分類する。#52は
    // このPRで修正済みなので、以降ここに分類される不一致は無いはずだが、
    // 万一#52相当の不具合が再発した場合に切り分けられるよう分類自体は残している。
    const explainedByIssue52 = mismatches.filter((m) =>
      matchesIssue52Pattern(m.expr),
    );
    const unexplainedMismatches = mismatches.filter(
      (m) => !matchesIssue52Pattern(m.expr),
    );

    assert.deepEqual(
      unexplainedMismatches.map((m) => ({
        index: m.index,
        expr: m.expr,
        kind: m.kind,
      })),
      [],
      `オリジナルと--fold-constants適用後でLuaの実行結果が一致せず、` +
        `Issue #52(https://github.com/nona-takahara/storm-lua-minify/issues/52、修正済み)` +
        `の条件でも説明できない式が${String(unexplainedMismatches.length)}件見つかった` +
        `(詳細はconsole.warn出力を参照)。#44の定数畳み込み自体か、新しい印字処理の` +
        `不具合の可能性が高い。`,
    );
    // #52として分類できる不一致の件数が、記録した基準値(修正済みなので0)から
    // 動いた場合も失敗させる。件数そのものを基準値として記録することで、
    // #52相当の不具合が部分的にでも再発した場合に気づけるようにしている。
    assert.equal(
      explainedByIssue52.length,
      EXPECTED_ISSUE52_MISMATCHES,
      `Issue #52として分類される不一致が${String(EXPECTED_ISSUE52_MISMATCHES)}件から` +
        `${String(explainedByIssue52.length)}件に変化した。#52相当の不具合が再発した` +
        `可能性がある。`,
    );
  },
);
