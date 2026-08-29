import { describe, expect, test } from "vitest";
import {
  finiteOptimizerTuple,
  finiteOptimizerValue,
  joinOptimizerTuples,
  joinOptimizerValues,
  valueAtOptimizerTupleSlot,
} from "../src/optimizerValueDomain";

const limits = {
  maxAtoms: 3,
  maxUnknownReasons: 3,
  maxTuplePrefix: 2,
};

describe("finite optimizer value domain", () => {
  test("normalizes empty, singleton, and two-value fast paths", () => {
    expect(finiteOptimizerValue()).toEqual({
      atoms: [],
      unknownReasons: [],
    });
    expect(
      finiteOptimizerValue([
        { kind: "string", value: "last" },
        { kind: "boolean", value: true },
      ]).atoms,
    ).toEqual([
      { kind: "boolean", value: true },
      { kind: "string", value: "last" },
    ]);
    expect(
      finiteOptimizerValue(
        [
          { kind: "number", raw: "42" },
          { kind: "number", raw: "42" },
        ],
        ["same", "same"],
      ),
    ).toEqual({
      atoms: [{ kind: "number", raw: "42" }],
      unknownReasons: ["same"],
    });
  });

  test("joins atoms and unknown knowledge independently and deterministically", () => {
    const joined = joinOptimizerValues(
      [
        finiteOptimizerValue(
          [
            { kind: "string", value: "answer" },
            { kind: "number", raw: "42" },
          ],
          ["external-call"],
          limits,
        ),
        finiteOptimizerValue(
          [
            { kind: "boolean", value: true },
            { kind: "number", raw: "42" },
          ],
          ["dynamic-branch"],
          limits,
        ),
      ],
      limits,
    );

    expect(joined).toEqual({
      atoms: [
        { kind: "boolean", value: true },
        { kind: "number", raw: "42" },
        { kind: "string", value: "answer" },
      ],
      unknownReasons: ["dynamic-branch", "external-call"],
    });
  });

  test("caps atoms without discarding the fact that alternatives were lost", () => {
    const value = finiteOptimizerValue(
      [
        { kind: "external", id: "runtime" },
        { kind: "parameter", index: 1 },
        { kind: "function", id: "helper" },
        { kind: "allocation", allocationKind: "table", id: "factory:1" },
      ],
      [],
      limits,
    );

    expect(value.atoms).toHaveLength(3);
    expect(value.unknownReasons).toContain("atom-cap-exceeded");
  });

  test("joins tuple slots with nil padding without poisoning other slots", () => {
    const left = finiteOptimizerTuple(
      [
        finiteOptimizerValue([{ kind: "number", raw: "1" }], [], limits),
        finiteOptimizerValue([{ kind: "string", value: "x" }], [], limits),
      ],
      { kind: "none" },
      limits,
    );
    const right = finiteOptimizerTuple(
      [finiteOptimizerValue([{ kind: "number", raw: "1" }], [], limits)],
      { kind: "none" },
      limits,
    );

    const joined = joinOptimizerTuples([right, left], limits);

    expect(joined.prefix[0]).toEqual({
      atoms: [{ kind: "number", raw: "1" }],
      unknownReasons: [],
    });
    expect(joined.prefix[1].atoms).toEqual([
      { kind: "nil" },
      { kind: "string", value: "x" },
    ]);
  });

  test("a vararg tail includes nil for a missing runtime slot", () => {
    const tuple = finiteOptimizerTuple(
      [],
      {
        kind: "vararg",
        value: finiteOptimizerValue(
          [{ kind: "parameter", index: 0 }],
          [],
          limits,
        ),
      },
      limits,
    );

    expect(valueAtOptimizerTupleSlot(tuple, 4, limits).atoms).toEqual([
      { kind: "nil" },
      { kind: "parameter", index: 0 },
    ]);
  });

  test("tuple prefix overflow becomes an explicit unknown tail", () => {
    const tuple = finiteOptimizerTuple(
      [
        finiteOptimizerValue([{ kind: "nil" }], [], limits),
        finiteOptimizerValue([{ kind: "boolean", value: false }], [], limits),
        finiteOptimizerValue([{ kind: "string", value: "lost" }], [], limits),
      ],
      { kind: "none" },
      limits,
    );

    expect(tuple.prefix).toHaveLength(2);
    expect(tuple.tail).toEqual({
      kind: "unknown",
      reasons: ["tuple-prefix-cap-exceeded"],
    });
  });

  test("rejects a reason cap that could hide loss of information", () => {
    expect(() =>
      finiteOptimizerValue([], [], { ...limits, maxUnknownReasons: 0 }),
    ).toThrow(/at least one/);
  });
});
