// Run after building: LUA53=lua5.3 node scripts/verify-discardable-local-reads.cjs
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
  functionInlining: false,
  functionSpecialization: false,
  identifierOptimizations: false,
  localDeclarationMerging: false,
  localDeclarationHoisting: false,
  tableReadMerging: false,
};
const cases = [
  [
    "parameter-copy",
    "local function f(p)local unused=p return 1 end return f(mark(7))",
    "7\ntrue\t1\n",
    {},
    false,
  ],
  [
    "local-copy",
    "local x=mark(7) local unused=x return x,nil,3",
    "7\ntrue\t7\tnil\t3\n",
    {},
    false,
  ],
  [
    "upvalue-copy",
    "local u=mark(7) local function f()local unused=u return 1 end return f()",
    "7\ntrue\t1\n",
    {},
    false,
  ],
  [
    "nil-upvalue",
    "local u local function f()local unused=u return 1 end return f()",
    "\ntrue\t1\n",
    {},
    false,
  ],
  ["outer-shadow", "local x=mark(7) do local x=x end return x", "7\ntrue\t7\n"],
  [
    "actual-error",
    'local function f(p)local unused=p return 1 end return f((function()mark(7) error("boom",0)end)())',
    "7\nfalse\tboom\n",
    {},
    false,
  ],
  [
    "mixed-initializers",
    "local x=mark(7) local unused,a,b=x,mark(8),mark(9) return a,b",
    "7,8,9\ntrue\t8\t9\n",
    {},
    false,
  ],
  [
    "global-read",
    "--@storm keep\nlocal _ENV=setmetatable({}, {__index=function(_,k)mark(k) return 7 end}) local unused=missing return 1",
    "missing\ntrue\t1\n",
    { runtimeProfile: "lua53", allowIntrospectionChanges: true },
    true,
  ],
  [
    "global-read-error",
    '--@storm keep\nlocal _ENV=setmetatable({}, {__index=function(_,k)mark(k) error("lookup",0) end}) local unused=missing return 1',
    "missing\nfalse\tlookup\n",
    { runtimeProfile: "lua53", allowIntrospectionChanges: true },
    true,
  ],
  [
    "binding-before-declaration",
    "--@storm keep\nlocal _ENV=setmetatable({}, {__index=function(_,k)mark(k) return 7 end}) local f=function()local unused=f return 1 end return f()",
    "f\ntrue\t1\n",
    { runtimeProfile: "lua53", allowIntrospectionChanges: true },
    true,
  ],
  [
    "debug-local",
    "local function f(p)local unused=p local name,value=debug.getlocal(1,2) return name,value end return f(mark(7))",
    "7\ntrue\tunused\t7\n",
    { runtimeProfile: "lua53" },
    true,
  ],
  [
    "debug-upvalue",
    "local u=mark(7) local function f()local unused=u return 1 end local name,value=debug.getupvalue(f,1) return name,value",
    "7\ntrue\tu\t7\n",
    { runtimeProfile: "lua53" },
    true,
  ],
  [
    "debug-opt-in",
    "local function f(p)local unused=p return 1 end return f(mark(7))",
    "7\ntrue\t1\n",
    { runtimeProfile: "lua53", allowIntrospectionChanges: true },
    false,
  ],
];
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "storm-local-reads-"));
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
  for (const [name, source, expected, options, retained] of cases) {
    const entry = path.join(directory, "main.lua");
    fs.writeFileSync(entry, source);
    const compile = (extra = {}) =>
      new Minifier(
        entry,
        { luaVersion: "5.3", locations: true, ranges: true, scope: true },
        { ...mode, ...options, ...extra },
      )
        .parse()
        .toString();
    const output = compile();
    if (retained !== undefined)
      assert.equal(
        output.includes("local unused="),
        retained,
        `${name}: retained declaration`,
      );
    if (retained === false)
      assert.ok(
        Buffer.byteLength(output) <
          Buffer.byteLength(compile({ unusedLocalRemoval: false })),
        `${name}: smaller output`,
      );
    const original = execute(source, `${name}-original`);
    assert.equal(original, expected, `${name}: original behavior`);
    assert.equal(
      execute(output, `${name}-minified`),
      original,
      `${name}: Lua behavior`,
    );
    console.log(`PASS ${name}`);
  }
  console.log(`${cases.length} Lua 5.3 comparisons passed`);
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
}
