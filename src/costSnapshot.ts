/** One candidate's plain AST graph, including nodes retained only by metadata. */
export class CostSnapshotClone {
  readonly copies = new Map<object, object>();

  clone<T>(value: T): T {
    if (value === null || typeof value !== "object") return value;
    const cached = this.copies.get(value);
    if (cached) return cached as T;
    const copy = (Array.isArray(value) ? [] : {}) as T;
    this.copies.set(value, copy as object);
    for (const key of Object.keys(value)) {
      (copy as Record<string, unknown>)[key] = this.clone(
        (value as Record<string, unknown>)[key],
      );
    }
    return copy;
  }
}
