type CandidateMask = Readonly<Record<string, "baseline" | "trial">>;

/** Classify the candidate at the existing snapshot boundary, not by call order. */
export function matchesCostCandidate(
  args: readonly unknown[],
  selection: "baseline" | "full-trial" | { without: string },
): boolean {
  const mask = args[0] as CandidateMask;
  const entries = Object.entries(mask);
  if (entries.length === 0) throw new Error("Missing cost candidate mask");
  if (typeof selection === "object" && !Object.hasOwn(mask, selection.without))
    return false;
  return entries.every(
    ([gate, value]) =>
      value ===
      (typeof selection === "object"
        ? gate === selection.without
          ? "baseline"
          : "trial"
        : selection === "baseline"
          ? "baseline"
          : "trial"),
  );
}
