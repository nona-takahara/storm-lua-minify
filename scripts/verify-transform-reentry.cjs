// Run after building: LUA53=lua5.3 node scripts/verify-transform-reentry.cjs
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { Minifier } = require("../dist/minifier.js");

const mode = {
  runtimeProfile: "stormworks",
  requiredWhitespace: " ",
  globalAliasing: false,
  constantOptimizations: true,
};
const cases = [
  [
    "deferred-tail-inline",
    "local function a(x)return x+1 end local function b(x)return a(x) end return b(2)",
    "\ntrue\t3\n",
  ],
  [
    "fold-dce-inline",
    "local function f()local x=1+2 return x end return f()+0",
    "\ntrue\t3\n",
  ],
  [
    "summary-after-fold",
    "local function a()return 1+2 end local x=a() return x",
    "\ntrue\t3\n",
    { functionOptimizations: false },
  ],
  [
    "constant-actual-specialization",
    "local flag=true local function f(x)if x then return 1 end return 2 end return f(flag)+f(flag)",
    "\ntrue\t2\n",
  ],
  [
    "multiple-constant-actuals",
    "local flag=true local function f(x,y)if x then return y end return 2 end return f(flag,3)+f(flag,3)",
    "\ntrue\t6\n",
  ],
  [
    "actual-effects-and-return-tuple",
    "local function a(x,y)mark(x) return x,y end local function b(x,y)return a(x,y) end return b(mark(2),mark(3))",
    "2,3,2\ntrue\t2\t3\n",
  ],
  [
    "error-after-effect",
    'local function a(x)mark(x) error("boom",0) end local function b(x)return a(x) end return b(2)',
    "2\nfalse\tboom\n",
  ],
  [
    "omitted-nil-binding",
    "x=42 local function a(x)if x then return 1 end return 2 end local function b()return a() end return b()",
    "\ntrue\t2\n",
  ],
  [
    "expanded-actuals",
    "local function pair()mark(1) return 10,20 end local function f(a,b)return b end return f(pair())+f(pair())",
    "1,1\ntrue\t40\n",
  ],
  [
    "single-value-adjustment",
    "local function pair()mark(1) return 10,20 end local function f(a,b,c)if c==nil then return b end return c end return f(pair(),7)+f(pair(),7)",
    "1,1\ntrue\t14\n",
  ],
  [
    "alpha-conversion-through-loop",
    'local function a(id,name)mark(id) mark(name) end local function b(id,names)for _,name in ipairs(names)do a(id,name)end end b(7,{"axle"}) return 4',
    "7,axle\ntrue\t4\n",
  ],
];
for (const depth of [3, 10]) {
  const functions = ["local function f0(x)return x+1 end"];
  for (let i = 1; i < depth; i++)
    functions.push(`local function f${i}(x)return f${i - 1}(x) end`);
  cases.push([
    `chain-${depth}`,
    `${functions.join(" ")} return f${depth - 1}(2)`,
    "\ntrue\t3\n",
  ]);
}
cases.push([
  "reuse-late-constant-actuals",
  "local flag=true local function f(x)if x then return 1 end return 2 end return f(true)+f(true)+f(flag)+f(flag)",
  "\ntrue\t4\n",
]);
for (const depth of [3, 10]) {
  const functions = ["local function f0()return 1+2 end"];
  for (let i = 1; i < depth; i++)
    functions.push(`local function f${i}()local x=f${i - 1}()return x end`);
  cases.push([
    `summary-chain-${depth}`,
    `${functions.join(" ")} local x=f${depth - 1}() return x`,
    "\ntrue\t3\n",
    { functionOptimizations: false },
  ]);
  const parameters = Array.from({ length: depth }, (_, i) => `p${i}`);
  const body = parameters
    .map((name) => `if ${name} then return 1 end`)
    .join(" ");
  const actuals = parameters.map(() => "flag").join(",");
  cases.push([
    `specialization-lineage-${depth}`,
    `local flag=1 local function f(${parameters.join(",")})${body} return 2 end return f(${actuals})+f(${actuals})`,
    "\ntrue\t2\n",
  ]);
}
cases.push([
  "nested-callable-inline-origin",
  "local function outer()local flag=true local function f(x)if x then return 1 end return 2 end return f(flag)+f(flag) end return outer()",
  "\ntrue\t2\n",
]);
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "storm-reentry-"));
function execute(source, name) {
  const script = path.join(directory, `${name}.lua`);
  const stdout = path.join(directory, `${name}.stdout`);
  const stderr = path.join(directory, `${name}.stderr`);
  fs.writeFileSync(
    script,
    `local log={} function mark(x)log[#log+1]=tostring(x) return x end
local run=assert(load([====[${source}]====],"case"))
local results=table.pack(pcall(run))
print(table.concat(log,","))
for i=1,results.n do if i>1 then io.write("\\t") end io.write(tostring(results[i])) end io.write("\\n")`,
  );
  const out = fs.openSync(stdout, "w");
  const err = fs.openSync(stderr, "w");
  try {
    const result = spawnSync(process.env.LUA53 || "lua5.3", [script], {
      stdio: ["ignore", out, err],
    });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, fs.readFileSync(stderr, "utf8"));
    return fs.readFileSync(stdout, "utf8");
  } finally {
    fs.closeSync(out);
    fs.closeSync(err);
  }
}
try {
  for (const [name, source, expected, options] of cases) {
    const entry = path.join(directory, "main.lua");
    fs.writeFileSync(entry, source);
    const compile = () =>
      new Minifier(
        entry,
        { luaVersion: "5.3", locations: true, ranges: true, scope: true },
        { ...mode, ...options },
      )
        .parse()
        .toString();
    const first = compile();
    fs.writeFileSync(entry, first);
    assert.equal(
      compile(),
      first,
      `${name}: output must be stable after one compilation`,
    );
    const originalResult = execute(source, `${name}-original`);
    assert.equal(originalResult, expected, `${name}: original result`);
    assert.equal(
      execute(first, `${name}-minified`),
      originalResult,
      `${name}: Lua behavior`,
    );
    console.log(`PASS ${name}`);
  }
  console.log(
    `${cases.length} Lua 5.3 behavior and fixed-point comparisons passed`,
  );
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
}
