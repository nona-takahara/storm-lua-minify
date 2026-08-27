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
function execute(file, cwd) {
  const result = spawnSync(lua, [file], { encoding: "utf8", cwd });
  if (result.error) throw result.error;
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function verifyWholeProgramMethodFixture() {
  const fixtureDirectory = path.join(directory, "whole-program-method");
  fs.mkdirSync(fixtureDirectory);
  const sources = {
    "object.lua": `
local Object={}
function Object.create_instance(target,prototype)
  for key,value in pairs(prototype) do
    if key~="new" and type(value)=="function" then target[key]=value end
  end
  return target
end
return Object
`,
    "class.lua": `
local Object=require("object")
local Class={}
function Class.new() return Object.create_instance({},Class) end
function Class:method(value,unused) self.value=value return self.value end
return Class
`,
    "main.lua": `
local Class=require("class")
local log={}
local function mark(label,value) log[#log+1]=label return value end
local function receiver() return mark("receiver",Class.new()) end
local result=receiver():method(mark("value",7),mark("unused",9))
print(result,table.concat(log,","))
`,
  };
  Object.entries(sources).forEach(([name, source]) =>
    fs.writeFileSync(path.join(fixtureDirectory, name), source),
  );
  const entry = path.join(fixtureDirectory, "main.lua");
  const minifiedFile = path.join(fixtureDirectory, "main.min.lua");
  const code = new Minifier(
    entry,
    { luaVersion: "5.3" },
    { requireWrapper: true, runtimeProfile: "stormworks" },
  )
    .parse()
    .toStringWithSourceMap({ file: path.basename(minifiedFile) }).code;
  fs.writeFileSync(minifiedFile, code);
  const original = execute(entry, fixtureDirectory);
  const minified = execute(minifiedFile, fixtureDirectory);
  if (JSON.stringify(original) !== JSON.stringify(minified)) {
    throw new Error(
      `semantic mismatch in whole-program method fixture\noriginal=${JSON.stringify(original)}\nminified=${JSON.stringify(minified)}\ncode=${code}`,
    );
  }
}

function verifyWholeProgramFieldFixture() {
  const fixtureDirectory = path.join(directory, "whole-program-fields");
  fs.mkdirSync(fixtureDirectory);
  const sources = {
    "object.lua": `local Object={} function Object.create_instance(target,prototype) for key,value in pairs(prototype) do target[key]=value end return target end return Object`,
    "class.lua": `local Object=require("object") local Class={} function Class.new(flag) local self=Object.create_instance({},Class) self.flag=flag self.unused=mark("initializer") return self end return Class`,
    "main.lua": `local log={} function mark(value) log[#log+1]=value return value end local Class=require("class") local first=Class.new(true) local second=Class.new(false) if first.flag then mark("first") end if second.flag then mark("wrong") else mark("second") end print(table.concat(log,","))`,
  };
  Object.entries(sources).forEach(([name, source]) =>
    fs.writeFileSync(path.join(fixtureDirectory, name), source),
  );
  const entry = path.join(fixtureDirectory, "main.lua");
  const minifiedFile = path.join(fixtureDirectory, "main.min.lua");
  const code = new Minifier(
    entry,
    { luaVersion: "5.3" },
    { requireWrapper: true, runtimeProfile: "stormworks" },
  )
    .parse()
    .toStringWithSourceMap({ file: path.basename(minifiedFile) }).code;
  fs.writeFileSync(minifiedFile, code);
  const original = execute(entry, fixtureDirectory);
  const minified = execute(minifiedFile, fixtureDirectory);
  if (JSON.stringify(original) !== JSON.stringify(minified)) {
    throw new Error(
      `semantic mismatch in whole-program field fixture\noriginal=${JSON.stringify(original)}\nminified=${JSON.stringify(minified)}\ncode=${code}`,
    );
  }
}

function verifyWholeProgramExportFixture(requireWrapper) {
  const suffix = requireWrapper ? "module" : "inline";
  const fixtureDirectory = path.join(
    directory,
    `whole-program-exports-${suffix}`,
  );
  fs.mkdirSync(fixtureDirectory);
  const sources = {
    "dependency.lua": `initializations=initializations+1 local exports={used=initializations} exports.dead=mark("dead-initializer") local function private_helper() return 9 end function exports.dead_function() return private_helper() end return exports`,
    "main.lua": `initializations=0 local log={} function mark(value) log[#log+1]=value return value end local first=require("dependency") local second=require("dependency") print(first.used,second.used,initializations,table.concat(log,","))`,
  };
  Object.entries(sources).forEach(([name, source]) =>
    fs.writeFileSync(path.join(fixtureDirectory, name), source),
  );
  const entry = path.join(fixtureDirectory, "main.lua");
  const outputs = ["baseline", "trial"].map((variant) => {
    const file = path.join(fixtureDirectory, `${variant}.lua`);
    const code = new Minifier(
      entry,
      { luaVersion: "5.3" },
      { requireWrapper, runtimeProfile: "stormworks" },
      undefined,
      undefined,
      undefined,
      undefined,
      variant,
    )
      .parse()
      .toStringWithSourceMap({ file: path.basename(file) }).code;
    fs.writeFileSync(file, code);
    return { code, execution: execute(file, fixtureDirectory) };
  });
  if (
    JSON.stringify(outputs[0].execution) !==
    JSON.stringify(outputs[1].execution)
  ) {
    throw new Error(
      `semantic mismatch in whole-program export fixture (${suffix})\nbaseline=${JSON.stringify(outputs[0])}\ntrial=${JSON.stringify(outputs[1])}`,
    );
  }
}

function verifyFieldRenameFixture() {
  const fixtureDirectory = path.join(directory, "whole-program-field-renames");
  fs.mkdirSync(fixtureDirectory);
  const source = `
local source={long_field_name=3,second_field_name=4}
local target={}
for key,value in next,source do target[key]=source[key] end
print(target.long_field_name,target["second_field_name"])
for key,value in pairs(source) do print(key,value) end
`;
  const entry = path.join(fixtureDirectory, "main.lua");
  const minifiedFile = path.join(fixtureDirectory, "main.min.lua");
  fs.writeFileSync(entry, source);
  const code = new Minifier(
    entry,
    { luaVersion: "5.3" },
    { requireWrapper: false, runtimeProfile: "stormworks" },
  )
    .parse()
    .toStringWithSourceMap({ file: path.basename(minifiedFile) }).code;
  fs.writeFileSync(minifiedFile, code);
  const original = execute(entry, fixtureDirectory);
  const minified = execute(minifiedFile, fixtureDirectory);
  if (JSON.stringify(original) !== JSON.stringify(minified)) {
    throw new Error(
      `semantic mismatch in field rename fixture\noriginal=${JSON.stringify(original)}\nminified=${JSON.stringify(minified)}\ncode=${code}`,
    );
  }
}

try {
  fixtures.forEach((source, index) => {
    const sourceFile = path.join(directory, `source-${String(index)}.lua`);
    const minifiedFile = path.join(directory, `minified-${String(index)}.lua`);
    fs.writeFileSync(sourceFile, source);
    const code = new Minifier(
      sourceFile,
      { luaVersion: "5.3" },
      { requireWrapper: false, runtimeProfile: "stormworks" },
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
  verifyWholeProgramMethodFixture();
  verifyWholeProgramFieldFixture();
  verifyWholeProgramExportFixture(true);
  verifyWholeProgramExportFixture(false);
  verifyFieldRenameFixture();
  process.stdout.write(
    `${lua}: ${String(fixtures.length + 5)} effect-aware fixtures matched exactly\n`,
  );
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
}
