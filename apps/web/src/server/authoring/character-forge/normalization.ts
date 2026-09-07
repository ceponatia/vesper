export function normalizeEnumToken(value: string): string {
  return value.trim().toLowerCase().replace(/[\s-]+/g, "_");
}
