/**
 * Deterministic JSON for fingerprinting: keys sorted recursively, `undefined`
 * members dropped. One home, because a second copy would be a second answer to
 * "did this configuration move?".
 *
 * It is runtime-neutral on purpose — it produces the STRING a fingerprint is
 * taken of, and never takes one. The hash itself is Node work and stays on the
 * application side.
 */
export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((entry) => stableJson(entry)).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const body = Object.keys(record)
      .sort()
      .filter((key) => record[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(",");
    return `{${body}}`;
  }
  return JSON.stringify(value) ?? "null";
}
