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

const functionRewriteFixtures = [
  {
    name: "omitted-tail-parameter-global",
    source:
      "x=42 local function f(x)if x then return 1 end return 2 end return f()",
    stdout: "true\t2\n",
  },
  {
    name: "omitted-tail-parameters-local-body",
    source:
      "local x=42 local y=43 local function f(x,y)local value=x if value then return 1 end return y,2 end return f()",
    stdout: "true\tnil\t2\n",
  },
  {
    name: "parameterless-tail-call",
    source:
      "local function f()if flag then return 1 end return 2,3 end return f()",
    stdout: "true\t2\t3\n",
  },
  {
    name: "specialization-tail-call",
    source:
      "local function pair()return 10,20 end local function f(a,b)return b end return f(pair())+f(pair())",
    stdout: "true\t40\n",
  },
  {
    name: "specialization-tail-call-effects",
    source:
      "calls=0 local function pair()calls=calls+1 return 10,20,30 end local function f(a,b)return b end local value=f(pair())+f(pair()) return value,calls",
    stdout: "true\t40\t2\n",
  },
  {
    name: "specialization-tail-call-error",
    source:
      'local function pair()error("sentinel",0)end local function f(a,b)return b end return f(pair())+f(pair())',
    stdout: "false\tsentinel\n",
  },
  {
    name: "specialization-tail-call-prefix",
    source:
      "local function pair()return 10,20 end local function f(flag,a,b)if flag then return b end return a end return f(true,pair())+f(true,pair())",
    stdout: "true\t40\n",
  },
  {
    name: "specialization-string-call",
    source:
      'local function pair(s)return 10,20 end local function f(a,b)return b end return f(pair"x")+f(pair"x")',
    stdout: "true\t40\n",
  },
  {
    name: "specialization-table-call",
    source:
      "local function pair(t)return 10,20 end local function f(a,b)return b end return f(pair{})+f(pair{})",
    stdout: "true\t40\n",
  },
  {
    name: "specialization-vararg-tail",
    source:
      "local function f(a,b)return b end local function run(...)return f(...)+f(...) end return run(10,20)",
    stdout: "true\t40\n",
  },
  {
    name: "specialization-derived-parameter",
    source:
      "local function pair()return 10,20 end local function f(a,b)return b end local function run(a,b)return f(a,b)+f(a,b) end return run(pair())+run(pair())",
    stdout: "true\t80\n",
  },
  {
    name: "specialization-colon-receiver",
    source:
      "local object={} function object:f(a,b)return b end local function pair()return 10,20 end return object:f(pair())+object:f(pair())",
    stdout: "true\t40\n",
  },
  {
    name: "specialization-field-callback",
    source:
      "local object={} function object.f(a,b)return b end local function pair()return 10,20 end return object.f(pair())+object.f(pair())",
    stdout: "true\t40\n",
  },
  {
    name: "specialization-nil-padding",
    source:
      "local function f(a,b)if b==nil then return 7 end return b end return f()+f(10)",
    stdout: "true\t14\n",
  },
  {
    name: "specialization-nonfinal-call",
    source:
      "calls=0 local function pair()calls=calls+1 return 10,20 end local function f(a,b,c)if c==nil then return b end return c end local value=f(pair(),7)+f(pair(),7) return value,calls",
    stdout: "true\t14\t2\n",
  },
];

function verifyFunctionRewriteFixture(fixture) {
  const sourceFile = path.join(directory, `${fixture.name}.lua`);
  fs.writeFileSync(sourceFile, fixture.source);
  const code = new Minifier(
    sourceFile,
    { luaVersion: "5.3" },
    {
      requireWrapper: false,
      runtimeProfile: "stormworks",
      requiredWhitespace: " ",
      globalAliasing: false,
    },
  )
    .parse()
    .toStringWithSourceMap({ file: `${fixture.name}.min.lua` }).code;
  // Wrap after minifying so the exact return-position input is optimized.
  const executeChunk = (source, suffix) => {
    const file = path.join(directory, `${fixture.name}-${suffix}.lua`);
    fs.writeFileSync(file, `print(pcall(function()\n${source}\nend))`);
    return execute(file);
  };
  const expected = { status: 0, stdout: fixture.stdout, stderr: "" };
  const original = executeChunk(fixture.source, "original");
  const minified = executeChunk(code, "minified");
  if (
    JSON.stringify(original) !== JSON.stringify(expected) ||
    JSON.stringify(minified) !== JSON.stringify(expected)
  ) {
    throw new Error(
      `semantic mismatch in ${fixture.name}\nexpected=${JSON.stringify(expected)}\noriginal=${JSON.stringify(original)}\nminified=${JSON.stringify(minified)}\ncode=${code}`,
    );
  }
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
local keys={}
for key in pairs(source) do keys[#keys+1]=key end
table.sort(keys)
for _,key in ipairs(keys) do print(key,source[key]) end
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
  functionRewriteFixtures.forEach(verifyFunctionRewriteFixture);
  verifyWholeProgramMethodFixture();
  verifyWholeProgramFieldFixture();
  verifyWholeProgramExportFixture(true);
  verifyWholeProgramExportFixture(false);
  verifyFieldRenameFixture();
  process.stdout.write(
    `${lua}: ${String(fixtures.length + functionRewriteFixtures.length + 5)} effect-aware fixtures matched exactly\n`,
  );
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
}
