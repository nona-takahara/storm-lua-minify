import Parser from "luaparse";
import { describe, expect, test } from "vitest";
import {
  applyAggregateSpecialization,
  SpecializationHistory,
} from "../src/aggregateSpecialization";
import { cloneWithFunctionOrigins } from "../src/generatedNode";
import { analyzeOptimizer } from "../src/optimizerAnalysis";
import { resolveScopes } from "../src/resolver";
import { SourceMetadata } from "../src/sourceMetadata";
import { analyzeWholeProgramObjects } from "../src/wholeProgramObjects";
import { analyzeWholeProgramFields } from "../src/wholeProgramFields";
import { parseLua } from "./lib/optimizerHarness";
import { minifyTemporaryLuaSource } from "./lib/minifierHarness";

function fixture(source: string) {
  let chunk = parseLua(source);
  const history = new SpecializationHistory();
  const metadata = new SourceMetadata(chunk, source);
  let generation = 0;
  return {
    get chunk() {
      return chunk;
    },
    clone() {
      chunk = cloneWithFunctionOrigins(chunk);
    },
    run(reverse = false) {
      const resolved = resolveScopes(chunk);
      const analysis = analyzeOptimizer(chunk, resolved, { generation });
      const objects = analyzeWholeProgramObjects(
        [{ name: "main", chunk, resolved, analysis }],
        generation++,
      );
      const fields = analyzeWholeProgramFields(objects);
      // Change discovery order while preserving source and bindings.

      return applyAggregateSpecialization(
        objects,
        reverse
          ? {
              ...fields,
              callGraph: {
                ...fields.callGraph,
                calls: [...fields.callGraph.calls].reverse(),
              },
            }
          : fields,
        [
          {
            name: "main",
            chunk,
            resolved,
            metadata,
            maxIntroducedLocalsAt: () => 199,
          },
        ],
        history,
      );
    },
  };
}
function selected(chunk: Parser.Chunk): string[] {
  return chunk.body.flatMap((statement) =>
    statement.type === "FunctionDeclaration" &&
    statement.identifier?.type === "Identifier" &&
    statement.identifier.name.startsWith("__stormVariant")
      ? [JSON.stringify(statement.body)]
      : [],
  );
}
const values = Array.from({ length: 129 }, (_, i) => i);
const calls = (numbers: number[], name = "f") =>
  numbers
    .flatMap((n) => [`${name}(${String(n)})`, `${name}(${String(n)})`])
    .join(",");

describe("localized specialization budget", () => {
  test("selects 128 signatures by frequency then parameter and literal key regardless of discovery order", () => {
    // 128 is deliberately discovered last, but its three uses take priority.
    const source = `local function f(x)return x end local t={${calls(values)},f(128)} consume(t)`;
    const forward = fixture(source);
    const backward = fixture(source);
    expect(forward.run().createdVariants).toBe(128);
    expect(backward.run(true).createdVariants).toBe(128);
    expect(selected(forward.chunk)).toEqual(selected(backward.chunk));
    const expected = [
      128,
      ...values
        .filter((n) => n !== 128)
        .sort((a, b) => (String(a) < String(b) ? -1 : 1))
        .slice(0, 127),
    ];
    const bodies = forward.chunk.body
      .filter(
        (node): node is Parser.FunctionDeclaration =>
          node.type === "FunctionDeclaration",
      )
      .slice(1);
    expect(
      bodies.map(
        (node) => (node.body[0] as Parser.ReturnStatement).arguments[0],
      ),
    ).toEqual(
      expected.map((value): unknown =>
        expect.objectContaining({ type: "NumericLiteral", value }),
      ),
    );
  });
  test("breaks equal-frequency ties by parameter position", () => {
    const item = fixture(
      "local function f(x,y)return x,y end consume(f(a,2),f(a,2),f(1,b),f(1,b))",
    );
    expect(item.run().createdVariants).toBe(2);
    const bodies = item.chunk.body
      .filter(
        (node): node is Parser.FunctionDeclaration =>
          node.type === "FunctionDeclaration",
      )
      .slice(1);
    expect(
      (bodies[0].body[0] as Parser.ReturnStatement).arguments[0],
    ).toMatchObject({ type: "NumericLiteral", value: 1 });
    expect(
      (bodies[1].body[0] as Parser.ReturnStatement).arguments[1],
    ).toMatchObject({ type: "NumericLiteral", value: 2 });
  });
  test("gives unrelated roots independent budgets beyond 128 total variants", () => {
    const item = fixture(
      `local function f(x)return x end local function g(x)return x end local t={${calls(values.slice(0, 65))},${calls(values.slice(0, 65), "g")}} consume(t)`,
    );
    expect(item.run().createdVariants).toBe(130);
  });
  test("retains the root budget across revisits, descendants, and inline copies", () => {
    const item = fixture(
      `local function f(x,y)return x,y end local t={${values.flatMap((n) => [`f(${String(n)},true)`, `f(${String(n)},true)`]).join(",")}} consume(t)`,
    );
    const first = item.run();
    expect(first.createdVariants).toBe(1);
    const second = item.run();
    expect(second.createdVariants).toBe(127);
    item.clone();
    const third = item.run();
    expect(third.createdVariants).toBe(0);
    expect(
      third.diagnostics.some(
        (d) => d.reason === "specialization-variant-limit",
      ),
    ).toBe(true);
  });
  test("avoids clear repeated-literal growth before spending a signature", () => {
    const item = fixture(
      `local function f(x)return ${Array<string>(100).fill("x").join(",")} end consume(f(false),f(false))`,
    );
    expect(item.run().createdVariants).toBe(0);
  });
  test("keeps folding opportunities despite repeated parameter references", () => {
    const item = fixture(
      `local function f(x)return ${Array<string>(100).fill("x==false").join(",")} end consume(f(false),f(false))`,
    );
    expect(item.run().createdVariants).toBe(1);
  });
  test("shrinks more than 2048 sites and leaves nonshrinking input unchanged", () => {
    const source = `local function f(enabled) if enabled then return 1 end return 2 end local t={${[...Array<string>(2048).fill("f(true)"), "f(false)", "f(false)"].join(",")}} local total=0 for _,v in ipairs(t) do total=total+v end return total`;
    const mode = {
      runtimeProfile: "stormworks" as const,
      requiredWhitespace: " " as const,
      functionInlining: false,
      globalAliasing: false,
      collectOptimizationDiagnostics: true,
    };
    const baseline = minifyTemporaryLuaSource(source, {
      ...mode,
      functionSpecialization: false,
    });
    const result = minifyTemporaryLuaSource(source, mode);
    expect(result.code.length).toBeLessThan(baseline.code.length);
    expect(
      result.minifier.optimizationDiagnostics.some(
        (d) =>
          d.pass === "aggregate-function-specialization" &&
          d.reason === "variant-created",
      ),
    ).toBe(true);
    const small = "local function f(x)return x end return f(1)";
    expect(minifyTemporaryLuaSource(small, mode).code).toBe(
      minifyTemporaryLuaSource(small, {
        ...mode,
        functionSpecialization: false,
      }).code,
    );
  }, 120000);
});
