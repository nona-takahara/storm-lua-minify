// 本物のLua処理系を使った差分テスト(#44の定数畳み込み検証)のための、
// 実行環境にLua 5.3系(または5.3と整数/浮動小数点の区別が同じ5.4系)が
// 存在するかどうかの検出。CIにはLuaが入っていないため、無ければ理由付きで
// スキップする前提で使う。
import { spawnSync } from "node:child_process";

export interface LuaDetectResult {
  available: boolean;
  bin?: string;
  version?: string; // 例: "5.3.6"
  reason: string;
}

// LUA53_BINで明示された実行ファイルを最優先で試す。それ以外はPATH上の
// 一般的な名前を順に試す。
const CANDIDATES = ["lua5.3", "lua5.4", "lua"];

function tryOne(bin: string): { version: string } | undefined {
  let res;
  try {
    res = spawnSync(bin, ["-v"], { encoding: "utf8" });
  } catch {
    return undefined;
  }
  if (!res || res.error) return undefined;
  const out = (res.stdout || "") + (res.stderr || "");
  const m = out.match(/Lua (5)\.(\d+)\.(\d+)/);
  if (!m) return undefined;
  return { version: `${m[1]}.${m[2]}.${m[3]}` };
}

export function detectLua(): LuaDetectResult {
  const tried: string[] = [];
  const override = process.env.LUA53_BIN;
  const candidates = override ? [override, ...CANDIDATES] : CANDIDATES;
  const rejectedVersions: string[] = [];
  for (const bin of candidates) {
    tried.push(bin);
    const found = tryOne(bin);
    if (!found) continue;
    const minor = found.version.split(".")[1];
    if (minor === "3" || minor === "4") {
      return {
        available: true,
        bin,
        version: found.version,
        reason: `${bin} -> Lua ${found.version}`,
      };
    }
    rejectedVersions.push(`${bin}=Lua ${found.version}`);
  }
  const extra =
    rejectedVersions.length > 0
      ? ` (見つかったが対象外のバージョン: ${rejectedVersions.join(", ")})`
      : "";
  return {
    available: false,
    reason:
      `Lua 5.3または5.4系のインタプリタが見つからないためスキップ` +
      `(試した候補: ${tried.join(", ")}. LUA53_BIN環境変数でパスを指定可能)` +
      extra,
  };
}
