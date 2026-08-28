export type OptimizerValueAtom =
  | { readonly kind: "nil" }
  | { readonly kind: "boolean"; readonly value: boolean }
  | { readonly kind: "number"; readonly raw: string }
  | { readonly kind: "string"; readonly value: string }
  | { readonly kind: "function"; readonly id: string }
  | {
      readonly kind: "allocation";
      readonly allocationKind: "table" | "function";
      readonly id: string;
    }
  | { readonly kind: "parameter"; readonly index: number }
  | { readonly kind: "external"; readonly id: string };

/**
 * A value keeps proven alternatives independently from incomplete knowledge.
 * For example, `{42} + unknown` is more useful than top while remaining sound.
 */
export interface FiniteOptimizerValue {
  readonly atoms: readonly OptimizerValueAtom[];
  readonly unknownReasons: readonly string[];
}

export type OptimizerTupleTail =
  | { readonly kind: "none" }
  | { readonly kind: "vararg"; readonly value: FiniteOptimizerValue }
  | { readonly kind: "unknown"; readonly reasons: readonly string[] };

export interface FiniteOptimizerTuple {
  readonly prefix: readonly FiniteOptimizerValue[];
  readonly tail: OptimizerTupleTail;
}

export interface OptimizerValueDomainLimits {
  readonly maxAtoms: number;
  readonly maxUnknownReasons: number;
  readonly maxTuplePrefix: number;
}

export const DEFAULT_OPTIMIZER_VALUE_DOMAIN_LIMITS: OptimizerValueDomainLimits =
  Object.freeze({
    maxAtoms: 16,
    maxUnknownReasons: 8,
    maxTuplePrefix: 16,
  });

export const NIL_ATOM: OptimizerValueAtom = Object.freeze({ kind: "nil" });

export const EMPTY_OPTIMIZER_VALUE: FiniteOptimizerValue = Object.freeze({
  atoms: Object.freeze([]),
  unknownReasons: Object.freeze([]),
});

export const EMPTY_OPTIMIZER_TUPLE: FiniteOptimizerTuple = Object.freeze({
  prefix: Object.freeze([]),
  tail: Object.freeze({ kind: "none" }),
});

export function finiteOptimizerValue(
  atoms: readonly OptimizerValueAtom[] = [],
  unknownReasons: readonly string[] = [],
  limits: OptimizerValueDomainLimits = DEFAULT_OPTIMIZER_VALUE_DOMAIN_LIMITS,
): FiniteOptimizerValue {
  validateLimits(limits);
  const normalizedAtoms = uniqueSorted(atoms, atomKey);
  const normalizedReasons = uniqueSorted(unknownReasons, (reason) => reason);
  const atomOverflow = normalizedAtoms.length > limits.maxAtoms;
  const reasons = atomOverflow
    ? [...normalizedReasons, "atom-cap-exceeded"]
    : normalizedReasons;
  return Object.freeze({
    atoms: Object.freeze(normalizedAtoms.slice(0, limits.maxAtoms)),
    unknownReasons: Object.freeze(
      capReasons(reasons, limits.maxUnknownReasons),
    ),
  });
}

export function unknownOptimizerValue(
  reason: string,
  limits: OptimizerValueDomainLimits = DEFAULT_OPTIMIZER_VALUE_DOMAIN_LIMITS,
): FiniteOptimizerValue {
  return finiteOptimizerValue([], [reason], limits);
}

export function joinOptimizerValues(
  values: readonly FiniteOptimizerValue[],
  limits: OptimizerValueDomainLimits = DEFAULT_OPTIMIZER_VALUE_DOMAIN_LIMITS,
): FiniteOptimizerValue {
  return finiteOptimizerValue(
    values.flatMap((value) => value.atoms),
    values.flatMap((value) => value.unknownReasons),
    limits,
  );
}

export function finiteOptimizerTuple(
  prefix: readonly FiniteOptimizerValue[],
  tail: OptimizerTupleTail = { kind: "none" },
  limits: OptimizerValueDomainLimits = DEFAULT_OPTIMIZER_VALUE_DOMAIN_LIMITS,
): FiniteOptimizerTuple {
  validateLimits(limits);
  const normalizedPrefix = prefix
    .slice(0, limits.maxTuplePrefix)
    .map((value) =>
      finiteOptimizerValue(value.atoms, value.unknownReasons, limits),
    );
  const normalizedTail =
    prefix.length > limits.maxTuplePrefix
      ? joinTupleTails(
          [
            tail,
            {
              kind: "unknown",
              reasons: ["tuple-prefix-cap-exceeded"],
            },
          ],
          limits,
        )
      : normalizeTail(tail, limits);
  return Object.freeze({
    prefix: Object.freeze(normalizedPrefix),
    tail: normalizedTail,
  });
}

export function valueAtOptimizerTupleSlot(
  tuple: FiniteOptimizerTuple,
  index: number,
  limits: OptimizerValueDomainLimits = DEFAULT_OPTIMIZER_VALUE_DOMAIN_LIMITS,
): FiniteOptimizerValue {
  if (!Number.isInteger(index) || index < 0)
    throw new RangeError("Tuple slot index must be a non-negative integer");
  if (index < tuple.prefix.length) return tuple.prefix[index];
  switch (tuple.tail.kind) {
    case "none":
      return finiteOptimizerValue([NIL_ATOM], [], limits);
    case "vararg":
      // A vararg may contain fewer values than the requested slot.
      return joinOptimizerValues(
        [tuple.tail.value, finiteOptimizerValue([NIL_ATOM], [], limits)],
        limits,
      );
    case "unknown":
      return finiteOptimizerValue([], tuple.tail.reasons, limits);
  }
}

export function joinOptimizerTuples(
  tuples: readonly FiniteOptimizerTuple[],
  limits: OptimizerValueDomainLimits = DEFAULT_OPTIMIZER_VALUE_DOMAIN_LIMITS,
): FiniteOptimizerTuple {
  validateLimits(limits);
  if (tuples.length === 0) return EMPTY_OPTIMIZER_TUPLE;
  const prefixLength = Math.min(
    Math.max(...tuples.map((tuple) => tuple.prefix.length)),
    limits.maxTuplePrefix,
  );
  const prefix = Array.from({ length: prefixLength }, (_, index) =>
    joinOptimizerValues(
      tuples.map((tuple) => valueAtOptimizerTupleSlot(tuple, index, limits)),
      limits,
    ),
  );
  const overflow = tuples.some(
    (tuple) => tuple.prefix.length > limits.maxTuplePrefix,
  );
  const tail = joinTupleTails(
    [
      ...tuples.map((tuple) => tuple.tail),
      ...(overflow
        ? ([
            {
              kind: "unknown",
              reasons: ["tuple-prefix-cap-exceeded"],
            },
          ] as const)
        : []),
    ],
    limits,
  );
  return finiteOptimizerTuple(prefix, tail, limits);
}

function joinTupleTails(
  tails: readonly OptimizerTupleTail[],
  limits: OptimizerValueDomainLimits,
): OptimizerTupleTail {
  const unknownReasons = tails.flatMap((tail) =>
    tail.kind === "unknown" ? tail.reasons : [],
  );
  if (unknownReasons.length > 0) {
    return Object.freeze({
      kind: "unknown",
      reasons: Object.freeze(
        capReasons(unknownReasons, limits.maxUnknownReasons),
      ),
    });
  }
  const varargs = tails.filter(
    (tail): tail is Extract<OptimizerTupleTail, { kind: "vararg" }> =>
      tail.kind === "vararg",
  );
  if (varargs.length === 0) return Object.freeze({ kind: "none" });
  const values = varargs.map((tail) => tail.value);
  if (tails.some((tail) => tail.kind === "none")) {
    values.push(finiteOptimizerValue([NIL_ATOM], [], limits));
  }
  return Object.freeze({
    kind: "vararg",
    value: joinOptimizerValues(values, limits),
  });
}

function normalizeTail(
  tail: OptimizerTupleTail,
  limits: OptimizerValueDomainLimits,
): OptimizerTupleTail {
  switch (tail.kind) {
    case "none":
      return Object.freeze({ kind: "none" });
    case "vararg":
      return Object.freeze({
        kind: "vararg",
        value: finiteOptimizerValue(
          tail.value.atoms,
          tail.value.unknownReasons,
          limits,
        ),
      });
    case "unknown":
      return Object.freeze({
        kind: "unknown",
        reasons: Object.freeze(
          capReasons(tail.reasons, limits.maxUnknownReasons),
        ),
      });
  }
}

function atomKey(atom: OptimizerValueAtom): string {
  switch (atom.kind) {
    case "nil":
      return "0:nil";
    case "boolean":
      return `1:boolean:${atom.value ? "1" : "0"}`;
    case "number":
      return `2:number:${atom.raw}`;
    case "string":
      return `3:string:${JSON.stringify(atom.value)}`;
    case "function":
      return `4:function:${atom.id}`;
    case "allocation":
      return `5:allocation:${atom.allocationKind}:${atom.id}`;
    case "parameter":
      return `6:parameter:${String(atom.index).padStart(12, "0")}`;
    case "external":
      return `7:external:${atom.id}`;
  }
}

function uniqueSorted<T>(
  values: readonly T[],
  keyOf: (value: T) => string,
): T[] {
  const byKey = new Map<string, T>();
  values.forEach((value) => byKey.set(keyOf(value), value));
  return [...byKey.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([, value]) => value);
}

function capReasons(reasons: readonly string[], maximum: number): string[] {
  const normalized = uniqueSorted(reasons, (reason) => reason);
  if (normalized.length <= maximum) return normalized;
  if (maximum === 0) return [];
  return [
    ...normalized.slice(0, Math.max(0, maximum - 1)),
    "reason-cap-exceeded",
  ];
}

function validateLimits(limits: OptimizerValueDomainLimits): void {
  Object.entries(limits).forEach(([name, value]) => {
    if (!Number.isInteger(value) || value < 0)
      throw new RangeError(`${name} must be a non-negative integer`);
  });
  // At least one slot is necessary to preserve the fact that a cap discarded
  // information. An empty reason set means the atom set is exhaustive.
  if (limits.maxUnknownReasons === 0)
    throw new RangeError("maxUnknownReasons must be at least one");
}
