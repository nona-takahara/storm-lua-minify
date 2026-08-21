// #44の定数畳み込み(--fold-constants)を、本物のLua 5.3インタプリタと突き合わせて
// 検証するための差分テストハーネス本体。
//
// 各テスト式Eについて、
//   local v = E
//   print(type(v), math.type(v), tostring(v))
// を実行した結果(オリジナル)と、Minifierを--fold-constants相当のモードで
// 通した後の結果(畳み込み後)を比較する。値だけでなくmath.typeによる
// 整数/浮動小数点の区別、実行時エラーの一致まで見る。
//
// 効率のため、多数の式を1つのLuaファイルにまとめてバッチ実行する。各式は
// pcallで包んだ無名関数の中で独立に評価するため、あるケースがエラーに
// なっても後続のケースの実行は続く(バッチ内の1件のエラーで全件を失わない)。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { Minifier, MinifierMode } from "../../src/minifier";
import { LUAPARSE_SETTINGS } from "../lib/helpers";

export interface CaseResult {
  index: number;
  status: "OK" | "ERR";
  type?: string;
  mathType?: string;
  toStr?: string;
  exact?: string; // floatのときだけ%.17gでの正確な桁表現。それ以外は""。
  errMsg?: string;
}

export interface BatchExecResult {
  results: Map<number, CaseResult>;
  stdout: string;
  stderr: string;
  exitStatus: number | null;
}

// floatはtostringが%.14gで丸めるため、最後のビットのずれ(V8のMath.powと
// LuaのCライブラリpowの違いなど)を見落とす。%.17gは倍精度を一意に復元できる
// 桁数なので、これを一致の根拠にする。
function buildBatchSource(cases: { index: number; expr: string }[]): string {
  const lines: string[] = [];
  for (const { index, expr } of cases) {
    lines.push(
      `do local __ok,__t,__mt,__ts,__ex = pcall(function()`,
      `  local v = ${expr}`,
      `  local t = type(v)`,
      `  local mt = math.type(v)`,
      `  if mt == nil then mt = "nil" end`,
      `  local ts = tostring(v)`,
      `  local ex = ""`,
      `  if mt == "float" then ex = string.format("%.17g", v) end`,
      `  return t, mt, ts, ex`,
      `end)`,
      `if __ok then print("R", ${index}, "OK", __t, __mt, __ts, __ex)`,
      `else print("R", ${index}, "ERR", tostring(__t)) end`,
      `end`,
    );
  }
  return lines.join("\n") + "\n";
}

function parseOutput(stdout: string): Map<number, CaseResult> {
  const map = new Map<number, CaseResult>();
  for (const line of stdout.split("\n")) {
    if (!line.startsWith("R\t")) continue;
    const parts = line.split("\t");
    const index = Number(parts[1]);
    const status = parts[2];
    if (status === "OK") {
      map.set(index, {
        index,
        status: "OK",
        type: parts[3],
        mathType: parts[4],
        toStr: parts[5],
        exact: parts[6] ?? "",
      });
    } else if (status === "ERR") {
      // エラーメッセージにタブが含まれる可能性は想定していないが、
      // 念のため残り全部を結合して1フィールドとして扱う。
      map.set(index, { index, status: "ERR", errMsg: parts.slice(3).join("\t") });
    }
  }
  return map;
}

function execLua(luaBin: string, dir: string): BatchExecResult {
  const res = spawnSync(luaBin, ["batch.lua"], {
    cwd: dir,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return {
    results: parseOutput(res.stdout || ""),
    stdout: res.stdout || "",
    stderr: res.stderr || "",
    exitStatus: res.status,
  };
}

function minifyFile(entryPath: string, mode: MinifierMode): string {
  const minifier = new Minifier(entryPath, LUAPARSE_SETTINGS, mode);
  const sourceNode = minifier.parse();
  const { code } = sourceNode.toStringWithSourceMap({ file: "batch.min.lua" });
  return code;
}

// 実行時エラーメッセージの正規化。2種類の揺れを取り除く:
//  1. 位置情報プレフィックス "chunkname:line: "。オリジナルと畳み込み後で
//     行数・チャンク名が変わりうる(畳み込みで文が結合されるため)。
//  2. 変数名の注釈 " (local 'v')" 等。リネームや定数伝搬で変数名自体が
//     変わる/消えるため、注釈込みで比較すると畳み込みと無関係な不一致に見える。
function normalizeErr(msg: string): string {
  let s = msg.replace(/^[^\s:]+:\d+:\s*/, "");
  s = s.replace(
    /\s*\((?:local|global|upvalue|field|constant|method)\s+'[^']*'\)\s*$/,
    "",
  );
  return s.trim();
}

export interface Mismatch {
  index: number;
  expr: string;
  kind: string;
  orig?: CaseResult;
  other?: CaseResult;
}

// oを基準(オリジナル実行結果)としてotherと比較する。一致すればundefined。
export function compareCase(
  expr: string,
  index: number,
  o: CaseResult | undefined,
  other: CaseResult | undefined,
): Mismatch | undefined {
  if (!o) return { index, expr, kind: "オリジナル側の結果が欠落", orig: o, other };
  if (!other)
    return { index, expr, kind: "比較対象側の結果が欠落", orig: o, other };
  if (o.status !== other.status)
    return {
      index,
      expr,
      kind: `ステータス不一致 (${o.status} vs ${other.status})`,
      orig: o,
      other,
    };
  if (o.status === "ERR") {
    const no = normalizeErr(o.errMsg || "");
    const nf = normalizeErr(other.errMsg || "");
    if (no !== nf) {
      return { index, expr, kind: "エラーメッセージ不一致", orig: o, other };
    }
    return undefined;
  }
  if (o.type !== other.type)
    return { index, expr, kind: "type()不一致", orig: o, other };
  if (o.mathType !== other.mathType)
    return { index, expr, kind: "math.type()不一致", orig: o, other };
  if (o.mathType === "float") {
    if (o.exact !== other.exact) {
      return {
        index,
        expr,
        kind: "float値不一致(%.17gで検出、tostringの14桁では見えない可能性)",
        orig: o,
        other,
      };
    }
  } else if (o.toStr !== other.toStr) {
    return { index, expr, kind: "tostring()不一致", orig: o, other };
  }
  return undefined;
}

export interface BatchRunOutcome {
  origDir: string;
  foldDir: string;
  nofoldDir: string;
  orig: BatchExecResult;
  fold: BatchExecResult;
  nofold: BatchExecResult;
  foldCode: string;
  nofoldCode: string;
  source: string;
}

// 1バッチ分(複数の式)を実行する。オリジナル / --fold-constants相当 / 畳み込み
// 無効(アトリビューション用)の3系統をLuaで実行し、結果を返す。
export function runBatch(
  cases: { index: number; expr: string }[],
  luaBin: string,
  tmpRoot: string,
  batchId: number,
): BatchRunOutcome {
  const base = path.join(tmpRoot, `b${batchId}`);
  const origDir = path.join(base, "orig");
  const foldDir = path.join(base, "fold");
  const nofoldDir = path.join(base, "nofold");
  fs.mkdirSync(origDir, { recursive: true });
  fs.mkdirSync(foldDir, { recursive: true });
  fs.mkdirSync(nofoldDir, { recursive: true });

  const source = buildBatchSource(cases);
  const origFile = path.join(origDir, "batch.lua");
  fs.writeFileSync(origFile, source, "utf8");

  const foldCode = minifyFile(origFile, {
    moduleLikeLua: false,
    foldConstants: true,
  });
  fs.writeFileSync(path.join(foldDir, "batch.lua"), foldCode, "utf8");

  const nofoldCode = minifyFile(origFile, {
    moduleLikeLua: false,
    foldConstants: false,
  });
  fs.writeFileSync(path.join(nofoldDir, "batch.lua"), nofoldCode, "utf8");

  return {
    origDir,
    foldDir,
    nofoldDir,
    orig: execLua(luaBin, origDir),
    fold: execLua(luaBin, foldDir),
    nofold: execLua(luaBin, nofoldDir),
    foldCode,
    nofoldCode,
    source,
  };
}

// ============================================================
// バッチ実行の頑健化(二分探索での問題ケース分離)
// ============================================================
//
// バッチの一部の式が、既存のミニファイア側の印字処理(区切り文字挿入)の
// バグ(#44の定数畳み込みとは無関係)を踏んで構文的に壊れたLuaを生成する
// ことがある(例: 16進整数リテラルが`a`〜`f`で終わり、直後が`..`のとき、
// 区切りなしで結合され`malformed number`になる)。その場合バッチ全体の
// 結果が0件になり、他の199件の比較機会を失ってしまう。二分探索で当該の
// 式だけを切り出し、"印字処理の不具合"として畳み込みの正誤判定とは
// 分離して報告する。

export interface PrinterDefect {
  index: number;
  expr: string;
  variant: "fold" | "nofold";
  stderr: string;
}

export interface RobustRunResult {
  origResults: Map<number, CaseResult>;
  foldResults: Map<number, CaseResult>;
  nofoldResults: Map<number, CaseResult>;
  printerDefects: PrinterDefect[];
  // オリジナル(未加工のLua)側が単体で実行に失敗した場合。生成した式の構文が
  // そもそも不正である可能性があり、テストハーネス側の問題として扱う。
  unexplainedFailures: string[];
}

function runCasesRecursive(
  cases: { index: number; expr: string }[],
  luaBin: string,
  tmpRoot: string,
  counter: { value: number },
  acc: RobustRunResult,
): void {
  const batchId = counter.value++;
  const outcome = runBatch(cases, luaBin, tmpRoot, batchId);
  const complete =
    outcome.orig.results.size === cases.length &&
    outcome.fold.results.size === cases.length &&
    outcome.nofold.results.size === cases.length;
  if (complete) {
    for (const [k, v] of outcome.orig.results) acc.origResults.set(k, v);
    for (const [k, v] of outcome.fold.results) acc.foldResults.set(k, v);
    for (const [k, v] of outcome.nofold.results) acc.nofoldResults.set(k, v);
    return;
  }
  if (cases.length === 1) {
    const c = cases[0];
    if (outcome.orig.results.size !== 1) {
      acc.unexplainedFailures.push(
        `index=${c.index} expr=${JSON.stringify(c.expr)}: オリジナル(未加工)の実行自体が失敗した` +
          ` (exit=${outcome.orig.exitStatus}, stderr=${outcome.orig.stderr.slice(0, 300)})`,
      );
      return;
    }
    acc.origResults.set(c.index, outcome.orig.results.get(c.index) as CaseResult);
    if (outcome.fold.results.size !== 1) {
      acc.printerDefects.push({
        index: c.index,
        expr: c.expr,
        variant: "fold",
        stderr: outcome.fold.stderr.slice(0, 300),
      });
    } else {
      acc.foldResults.set(c.index, outcome.fold.results.get(c.index) as CaseResult);
    }
    if (outcome.nofold.results.size !== 1) {
      acc.printerDefects.push({
        index: c.index,
        expr: c.expr,
        variant: "nofold",
        stderr: outcome.nofold.stderr.slice(0, 300),
      });
    } else {
      acc.nofoldResults.set(
        c.index,
        outcome.nofold.results.get(c.index) as CaseResult,
      );
    }
    return;
  }
  const mid = Math.floor(cases.length / 2);
  runCasesRecursive(cases.slice(0, mid), luaBin, tmpRoot, counter, acc);
  runCasesRecursive(cases.slice(mid), luaBin, tmpRoot, counter, acc);
}

// 全ケースをbatchSizeずつバッチ実行する。バッチが壊れた場合は二分探索で
// 原因の式を分離し、残りは正常に比較する。
export function runCasesRobust(
  cases: { index: number; expr: string }[],
  luaBin: string,
  tmpRoot: string,
  batchSize: number,
): RobustRunResult {
  const acc: RobustRunResult = {
    origResults: new Map(),
    foldResults: new Map(),
    nofoldResults: new Map(),
    printerDefects: [],
    unexplainedFailures: [],
  };
  const counter = { value: 0 };
  for (let start = 0; start < cases.length; start += batchSize) {
    runCasesRecursive(
      cases.slice(start, start + batchSize),
      luaBin,
      tmpRoot,
      counter,
      acc,
    );
  }
  return acc;
}

export function makeTmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "storm-difftest-"));
}

// 単一の式を、要求仕様どおりの最小形(local v = E; print(...))で単独実行する。
// バッチ実行で不一致が出た式について、バッチ化そのものが原因でないことを
// 確認するために使う。
export function runStandalone(
  expr: string,
  luaBin: string,
  tmpRoot: string,
  label: string,
  fold: boolean,
): { stdout: string; stderr: string; exitStatus: number | null; code: string } {
  const dir = path.join(tmpRoot, `standalone-${label}`);
  fs.mkdirSync(dir, { recursive: true });
  const source = `local v = ${expr}\nprint(type(v), math.type(v), tostring(v))\n`;
  const srcFile = path.join(dir, "case.lua");
  fs.writeFileSync(srcFile, source, "utf8");
  let code = source;
  if (fold) {
    code = minifyFile(srcFile, { moduleLikeLua: false, foldConstants: true });
    fs.writeFileSync(srcFile, code, "utf8");
  }
  const res = spawnSync(luaBin, ["case.lua"], { cwd: dir, encoding: "utf8" });
  return {
    stdout: res.stdout || "",
    stderr: res.stderr || "",
    exitStatus: res.status,
    code,
  };
}
