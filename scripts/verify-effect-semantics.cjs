const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { Minifier } = require("../dist/minifier.js");

const lua = process.env.LUA53 || "lua53";
const fixtures = [
  `
local log={}
function tick() log[#log+1]="tick" end
function use(a,b) print(a,b,table.concat(log,",")) end
local t={x=1,y=2}
local alias=t
local first=alias.x
tick()
local second=t.y
use(first,second)
`,
  `
local t
local function evil() t.y=9 end
local function make()
  t={x=1,y=2}
  local first=t.x
  evil()
  local second=t.y
  print(first,second)
end
make()
`,
  `
local outer=7
local first=(function() print("first") return outer end)()
print("middle",outer)
local second=(function() print("second") return outer end)()
print(first,second)
`,
  `
local function values() print("values") return 1,2,3 end
local a,b=values()
print(a,b)
`,
  `
local log={}
local function make(value) log[#log+1]=value return value end
local function publish(first,second) print(first,second,table.concat(log,",")) end
publish(make("first"),make("second"))
`,
  `
local function pair(value)
  local next=value+1
  if value<0 then return value,next end
  return next,value
end
print(pair(4))
print(pair(-2))
`,
  `
local function run(first,second)
  local sum=first+second
  print(sum)
end
run((function() print("first") return 1 end)(),(function() print("second") return 2 end)())
`,
];

const directory = fs.mkdtempSync(
  path.join(os.tmpdir(), "storm-effect-semantics-"),
);
function execute(file) {
  const result = spawnSync(lua, [file], { encoding: "utf8" });
  if (result.error) throw result.error;
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

try {
  fixtures.forEach((source, index) => {
    const sourceFile = path.join(directory, `source-${String(index)}.lua`);
    const minifiedFile = path.join(directory, `minified-${String(index)}.lua`);
    fs.writeFileSync(sourceFile, source);
    const code = new Minifier(
      sourceFile,
      { luaVersion: "5.3" },
      { moduleLikeLua: false, runtimeProfile: "stormworks" },
    )
      .parse()
      .toStringWithSourceMap({ file: path.basename(minifiedFile) }).code;
    fs.writeFileSync(minifiedFile, code);
    const original = execute(sourceFile);
    const minified = execute(minifiedFile);
    if (JSON.stringify(original) !== JSON.stringify(minified)) {
      throw new Error(
        `semantic mismatch in fixture ${String(index)}\noriginal=${JSON.stringify(original)}\nminified=${JSON.stringify(minified)}\ncode=${code}`,
      );
    }
  });
  process.stdout.write(
    `${lua}: ${String(fixtures.length)} effect-aware fixtures matched exactly\n`,
  );
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
}
