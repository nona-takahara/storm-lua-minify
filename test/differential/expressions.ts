// #44の定数畳み込み(--fold-constants)を、本物のLua 5.3と突き合わせる
// 差分テスト用の式コーパス。人手で選んだ固定式(要求仕様に挙がっている
// 境界ケース)と、シード付き擬似乱数で生成する式の2本立て。

// 人手で選んだ固定式。四則演算・床除算・剰余・べき乗・除算(負数の組み合わせを含む)、
// 整数/浮動小数点混在、64bit整数の桁あふれ、ビット演算とシフト(負・64以上)、
// 比較、文字列連結・長さ、論理演算、実行時エラーになる式を網羅する。
export const REQUIRED_EXPRESSIONS: string[] = [
  // 四則演算・床除算・剰余・べき乗・除算
  "1+2",
  "1-2",
  "2*3",
  "7/2",
  "7//2",
  "7%2",
  "2^10",
  // 負の数を含む床除算・剰余の組み合わせ(Luaは床方向)
  "-7//2",
  "-7%3",
  "7//-2",
  "7%-3",
  "-7/-2",
  "-7%-3",
  "7//-3",
  "-7//-3",
  "-7//-2",
  "-1//2",
  "-1%2",
  "1//-1",
  "1%-1",
  // 整数・浮動小数点混在
  "1+2.0",
  "3/1",
  "2^2",
  "7//2.0",
  "1.0+2",
  "3.0//2",
  "3.0%2",
  "2^0.5",
  "10/4",
  // 極端な桁比のfloat剰余(#44検証で発見: 畳み込みの`a - floor(a/b)*b`定式化は
  // 中間の掛け戻しで桁落ちし、Luaの実際のfmodベースの結果と異なる値に丸まる。
  // 本物のLuaでは0ではなく9.6318652803971148e-301になる)
  "10 % 1e-300",
  // 64bit整数の桁あふれ
  "0x7fffffffffffffff+2",
  "0x7fffffffffffffff*2",
  "0x8000000000000000-1",
  "0x7fffffffffffffff+1",
  "-0x7fffffffffffffff-2",
  "0xffffffffffffffff+1",
  "0x7fffffffffffffff*0x7fffffffffffffff",
  // ビット演算・単項~
  "1&3",
  "1|2",
  "1~2",
  "5~3",
  "1<<4",
  "256>>4",
  "~0",
  "~1",
  "~(-1)",
  // シフト量が負・64以上
  "1<<64",
  "1<<-1",
  "-1>>1",
  "1<<63",
  "1<<65",
  "1>>64",
  "1>>-1",
  "1<<-64",
  "1<<-65",
  "-1<<1",
  "-1<<64",
  "0<<-1",
  // 比較(数値・文字列)、== と ~=
  "1<2",
  "2<=2",
  "3>2",
  "2>=3",
  "1==1.0",
  "1~=1.0",
  "1==2",
  '"a"<"b"',
  '"abc"=="abc"',
  '"b">"a"',
  '"10"<"9"',
  "1==1",
  "1.0==1.0",
  "0==0.0",
  // 連結・長さ
  '"a".."b"',
  '#"hello"',
  '#""',
  '"" .. ""',
  '"ab"..1',
  // 論理演算
  "true and false",
  "true or false",
  "not true",
  "not nil",
  "1 and 2",
  "nil or 3",
  "false or nil",
  "not not 1",
  "nil and 1",
  "false and error()",
  // 実行時エラーになる式(両方が同じエラーで落ちることを確認する)
  "1//0",
  "1%0",
  '1<"a"',
  "0//0",
  "0%0",
  '"a"+1',
  "nil+1",
  "true+1",
  "1&1.5",
  "1<<1.5",
  "#1",
  '1<{}',
];

// ============================================================
// シード付き擬似乱数によるランダム式生成
// ============================================================

// mulberry32: 小さく決定的なPRNG。再実行しても同じ式集合が出るようにする。
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(rnd: () => number, arr: readonly T[]): T {
  return arr[Math.floor(rnd() * arr.length)];
}

const NUMBER_ATOMS = [
  "0",
  "1",
  "2",
  "3",
  "4",
  "5",
  "7",
  "8",
  "10",
  "16",
  "32",
  "63",
  "64",
  "65",
  "100",
  "0.0",
  "0.5",
  "1.5",
  "2.5",
  "3.14",
  "1e10",
  "1e-10",
  "1e300",
  "1e-300",
  "1e15",
  "0x1",
  "0x2",
  "0x10",
  "0xff",
  "0x7fffffffffffffff",
  "0x8000000000000000",
  "0xffffffffffffffff",
];

const STRING_ATOMS = [
  '"a"',
  '"b"',
  '"abc"',
  '""',
  '"z9"',
  '"Hello"',
  '"10"',
  '"3"',
  '"-1"',
];

const BOOL_ATOMS = ["true", "false"];
const NIL_ATOM = "nil";

const UNARY_OPS = ["-", "not ", "#", "~"];
const BINARY_OPS = [
  "+",
  "-",
  "*",
  "/",
  "//",
  "%",
  "^",
  "&",
  "|",
  "~",
  "<<",
  ">>",
  "..",
  "==",
  "~=",
  "<",
  "<=",
  ">",
  ">=",
  "and",
  "or",
];

function genAtom(rnd: () => number): string {
  const r = rnd();
  if (r < 0.65) return pick(rnd, NUMBER_ATOMS);
  if (r < 0.85) return pick(rnd, STRING_ATOMS);
  if (r < 0.95) return pick(rnd, BOOL_ATOMS);
  return NIL_ATOM;
}

function genExpr(rnd: () => number, depth: number): string {
  if (depth <= 0 || rnd() < 0.45) return genAtom(rnd);
  if (rnd() < 0.2) {
    const op = pick(rnd, UNARY_OPS);
    const operand = genExpr(rnd, depth - 1);
    return `${op}(${operand})`;
  }
  const op = pick(rnd, BINARY_OPS);
  const l = genExpr(rnd, depth - 1);
  const r = genExpr(rnd, depth - 1);
  return `(${l} ${op} ${r})`;
}

// count個のランダム式を、seedから決定的に生成する。
export function generateRandomExpressions(
  count: number,
  seed: number,
): string[] {
  const rnd = mulberry32(seed);
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    out.push(genExpr(rnd, 3));
  }
  return out;
}
