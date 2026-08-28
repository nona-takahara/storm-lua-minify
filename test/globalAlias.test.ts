import { describe, test } from "vitest";
import assert from "node:assert/strict";
import Parser from "luaparse";
import { resolveScopes } from "../src/resolver";
import { insertGlobalAliases } from "../src/transform";
import { minifyTemporaryLuaProject } from "./lib/minifierHarness";
import { runMinifier } from "./lib/helpers";

describe("global alias insertion", () => {
  function parse(code: string): Parser.Chunk {
    return Parser.parse(code, { luaVersion: "5.3" });
  }

  function alias(
    code: string,
    excludeNames: ReadonlySet<string> = new Set(),
  ): Parser.Chunk {
    const chunk = parse(code);
    const resolved = resolveScopes(chunk);
    insertGlobalAliases(chunk, resolved, { excludeNames });
    return chunk;
  }

  test("a global referenced many times above the threshold gets aliased at the top of the chunk", () => {
    const chunk = alias(`
    screen.setColor(1)
    screen.setColor(2)
    screen.setColor(3)
    screen.setColor(4)
    screen.setColor(5)
  `);

    assert.equal(chunk.body.length, 6);
    const aliasDecl = chunk.body[0] as Parser.LocalStatement;
    const aliasInit = aliasDecl.init[0];
    assert.equal(aliasInit.type === "Identifier" && aliasInit.name, "screen");

    const aliasName = aliasDecl.variables[0].name;
    for (let i = 1; i < chunk.body.length; i++) {
      const call = (chunk.body[i] as Parser.CallStatement)
        .expression as Parser.CallExpression;
      const base = call.base as Parser.MemberExpression;
      assert.equal((base.base as Parser.Identifier).name, aliasName);
    }
  });

  test("a global below the reference threshold is left untouched", () => {
    const chunk = alias(`
    screen.setColor(1)
  `);

    assert.equal(chunk.body.length, 1);
    assert.equal(chunk.body[0].type, "CallStatement");
  });

  test("excludeNames prevents aliasing a global selected for direct renaming", () => {
    const chunk = alias(
      `
      screen.setColor(1)
      screen.setColor(2)
      screen.setColor(3)
      screen.setColor(4)
      screen.setColor(5)
    `,
      new Set(["screen"]),
    );

    assert.equal(chunk.body.length, 5);
    assert.equal(chunk.body[0].type, "CallStatement");
  });

  test("a global that is ever assigned is never aliased", () => {
    const chunk = alias(`
    counter = counter or 0
    counter = counter + 1
    counter = counter + 1
    counter = counter + 1
    counter = counter + 1
  `);

    // Assigned globals belong to global renaming, not alias insertion.
    assert.equal(chunk.body.length, 5);
  });

  test("a global written by another module is not captured before that module runs", () => {
    const { code } = minifyTemporaryLuaProject(
      {
        "main.lua": `
          function onTick()
            calculateTick()
            calculateTick()
            calculateTick()
            calculateTick()
            calculateTick()
          end
          require("implementation")
        `,
        "implementation.lua": `
          function calculateTick()
            return 1
          end
        `,
      },
      {
        requireWrapper: false,
        optimizations: false,
        localRenaming: true,
        globalRenaming: false,
        globalAliasing: true,
        neverRenameGlobals: new Set(["onTick"]),
      },
    );

    assert.equal(
      /local\s+\w+\s*=\s*calculateTick/.test(code),
      false,
      `program-owned global must not be captured as an external alias: ${code}`,
    );
    assert.match(code, /calculateTick\(\)/);
  });

  test("require and dofile are never aliased even when referenced frequently", () => {
    const chunk = alias(`
    local a = require("m1")
    local b = require("m2")
    local c = require("m3")
    local d = require("m4")
    local e = require("m5")
  `);

    // No declaration aliases either module-loading function.
    assert.equal(chunk.body.length, 5);
    chunk.body.forEach((statement) => {
      const local = statement as Parser.LocalStatement;
      const call = local.init[0] as Parser.CallExpression;
      assert.equal((call.base as Parser.Identifier).name, "require");
    });
  });

  test("a field name that happens to share an aliased global's spelling is left untouched", () => {
    const chunk = alias(`
    local t = {}
    t.screen = "not the global"
    screen.setColor(1)
    screen.setColor(2)
    screen.setColor(3)
    screen.setColor(4)
    screen.setColor(5)
  `);

    const fieldAssign = chunk.body[2] as Parser.AssignmentStatement;
    const fieldTarget = fieldAssign.variables[0] as Parser.MemberExpression;
    assert.equal(fieldTarget.identifier.name, "screen");
  });

  test("mode.neverRenameGlobals protects a global from aliasing", () => {
    const { code } = runMinifier({
      label: "mode.neverRenameGlobals also protects a global from #8b aliasing",
      fixture: "global-alias",
      mode: {
        requireWrapper: false,
        neverRenameGlobals: new Set(["screen"]),
      },
    });

    assert.ok(
      code.includes("screen.setColor"),
      `screen must remain unaliased: ${code}`,
    );
  });
});
