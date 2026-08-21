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
// 残る不一致は、`ast2lua.ts`の印字処理の既存の丸括弧省略バグ
// (Issue #52: https://github.com/nona-takahara/storm-lua-minify/issues/52)
// で説明できるものだけになった。`..`(連結)はLuaでは`+ - * / // %`・単項演算子
// (`not # - ~`)・`^`より優先順位が低いが、`..`式がこれらの直接のオペランドとして
// 現れるとき、印字処理が必要な丸括弧を落とし、Luaの構文解析上のグルーピングが
// 変わってしまう。`--fold-constants`の有無に関わらず再現する、畳み込みとは
// 独立した既存の不具合だが、畳み込みがASTを差し替える過程で、元の括弧を守って
// いた構造が失われて顕在化するケースもある。
//
// このテストは、不一致を「式そのもの」の固定リストではなく、issue52.tsの
// `matchesIssue52Pattern`(AST上で`..`式が優先順位の高い演算子の直接のオペランド
// になっているかを判定する)で分類する。ランダム式はシードを変えると変わるため、
// 固定リストでの判定は壊れやすい。
//   - #52で説明できない不一致が1件でもあれば、それは#44(定数畳み込み)か、
//     #52とは別の新しい印字処理の不具合であり、テストを失敗させる。
//   - #52で説明できる不一致の件数が、固定シードでの基準値(現状24件)から
//     動いた場合もテストを失敗させる。「0件になったら気づく」という存在
//     チェックだけでは、#52が単項演算子まわりだけ直るような部分的な修正を
//     見逃す(該当件数は0にならず、それでも減っている)。件数そのものを
//     基準にすることで増減どちらの変化も検知する。
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

// シード442026・3000件の現状(2026-08-21、fmod修正後)で実際に観測した件数。
// 式そのものの固定リストではなく件数で止めているのは、判定条件
// (matchesIssue52Pattern/malformed number)が「部分的に」古くなるケース
// ―― 例えば#52が単項演算子まわりだけ直り、二項演算子まわりは直っていない
// ―― を捉えるため。この場合、該当件数は0にはならず「explainedByIssue52.length
// > 0」のような存在チェックでは検知できないが、件数が24から動けば検知できる。
// 数を変えるときは、#52(または未起票の区切り文字バグ)の状態を確認してから
// 更新すること。
const EXPECTED_ISSUE52_MISMATCHES = 24;
const EXPECTED_SEPARATOR_BUG_DEFECTS = 13;

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
    // `malformed number`で失敗するという単一のパターンに由来する。これは
    // Issue #52(丸括弧省略)とは別の不具合で、まだ起票していない。この
    // パターン以外の理由でバッチが壊れた場合は、未知の問題として検知する。
    const unexpectedPrinterDefects = run.printerDefects.filter(
      (d) => !/malformed number/.test(d.stderr),
    );
    assert.deepEqual(
      unexpectedPrinterDefects,
      [],
      "既知の16進リテラル+`..`の区切り文字バグ(未起票、#52とは別)以外の理由で" +
        "ミニファイア出力が構文エラーになった。新しい印字処理の不具合の可能性がある。",
    );
    // 件数そのものが動いたら、区切り文字バグが直った(あるいは条件が変わった)
    // ことに気づけるようにする。0件になっても、増えても失敗させる。
    assert.equal(
      run.printerDefects.length,
      EXPECTED_SEPARATOR_BUG_DEFECTS,
      `既知の区切り文字バグ(未起票、malformed numberシグネチャ)による` +
        `printerDefectsが${String(EXPECTED_SEPARATOR_BUG_DEFECTS)}件から` +
        `${String(run.printerDefects.length)}件に変化した。直った場合は` +
        `EXPECTED_SEPARATOR_BUG_DEFECTSを更新し、増えた場合は新規の混入を疑うこと。`,
    );

    // 残る不一致を、Issue #52の条件(AST上で`..`式が優先順位の高い演算子の
    // 直接のオペランドになっている)で説明できるかどうかに分類する。
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
        `Issue #52(https://github.com/nona-takahara/storm-lua-minify/issues/52)` +
        `の条件でも説明できない式が${String(unexplainedMismatches.length)}件見つかった` +
        `(詳細はconsole.warn出力を参照)。#44の定数畳み込み自体か、#52とは別の` +
        `印字処理の不具合の可能性が高い。`,
    );
    // #52として許容している不一致の件数が、記録した基準値から動いた場合も
    // 失敗させる。「0件になったら気づく」という存在チェックだけでは、#52が
    // 部分的に直った場合(該当件数が24件から例えば6件に減っただけ)を見逃す。
    // 件数そのものをこの固定シード・固定件数に対する基準値として記録することで、
    // 増減どちらの変化も検知できるようにしている。
    assert.equal(
      explainedByIssue52.length,
      EXPECTED_ISSUE52_MISMATCHES,
      `Issue #52として許容している不一致が${String(EXPECTED_ISSUE52_MISMATCHES)}件から` +
        `${String(explainedByIssue52.length)}件に変化した。#52が(部分的にでも)修正` +
        `されたか、matchesIssue52Patternの判定条件が古くなった可能性がある。#52の状態を` +
        `確認し、直っているならEXPECTED_ISSUE52_MISMATCHESを更新するか、issue52.tsに` +
        `よる許容ロジック自体を外すこと。`,
    );
  },
);
