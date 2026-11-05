/** Explicit observations of fixture behavior, independent of generated Lua. */
const observations: Partial<
  Record<string, { stdout: string; prelude?: string }>
> = {
  "single-file": { stdout: "55\t3\ntrue\n" },
  "require-call": { stdout: "hello\ntrue\n" },
  "require-string-call": { stdout: "hello\ntrue\n" },
  "require-in-expression": { stdout: "hello\ntrue\n" },
  "multi-require": { stdout: "42\t42\ntrue\n" },
  "nested-module": { stdout: "1\ntrue\n" },
  "bare-require": { stdout: "hello from mod\ndone\ntrue\n" },
  dofile: {
    // The compiler treats this fixture's extensionless dofile as a module path.
    prelude:
      'local nativeDofile=dofile; function dofile(name) return nativeDofile(name..".lua") end',
    stdout: "hello from greet\ndone\ntrue\n",
  },
  "bitwise-precedence": { stdout: "3\n3\n3\n3\n32\n7\n0\n2\ntrue\n" },
  "entry-scope-many-requires": {
    stdout:
      "dep_alpha\tdep_bravo\tdep_charlie\tdep_delta\tdep_echo\tdep_foxtrot\tdep_golf\tdep_hotel\tdep_india\tdep_juliet\tdep_kilo\ntrue\n",
  },
  "merge-locals": { stdout: "dep1\tdep2\tdep3\n2\ntrue\n" },
  "global-alias": {
    prelude:
      'screen={setColor=function(...) print("setColor",...) end,drawText=function(...) print("drawText",...) end}',
    stdout:
      "setColor\t255\t0\t0\ndrawText\t0\t0\thello\ndrawText\t1\t1\tworld\ndrawText\t2\t2\tagain\nsetColor\t0\t255\t0\ntrue\n",
  },
  "const-fold": {
    prelude: 'function sideEffect() print("effect") return 4 end',
    stdout:
      "3\t3\t3.0\tHello, world!\n200\n1\t1\t1\neffect\n5\n6\n42\nAB\n-5\n4\ttrue\ntrue\n",
  },
};

export function fixtureExecution(fixture: string) {
  const observation = observations[fixture];
  if (!observation) throw new Error(`Missing execution oracle: ${fixture}`);
  const tableObservation = [
    "entry-scope-many-requires",
    "merge-locals",
  ].includes(fixture)
    ? `local nativePrint=print
function print(...)
  local values=table.pack(...)
  for i=1,values.n do
    if type(values[i])=="table" then
      assert(type(values[i].id)=="string", "missing module id")
      values[i]=values[i].id
    end
  end
  nativePrint(table.unpack(values,1,values.n))
end`
    : "";
  // Replace nondeterministic table addresses with their observable module IDs.
  return {
    ...observation,
    prelude: `${tableObservation}\n${observation.prelude ?? ""}`,
  };
}
