/** Pure helpers behind the CSS monogram fallback for missing images. */

export function initialsOf(name: string): string {
  const words = name
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 0);
  const first = words[0]?.[0] ?? "?";
  const second = words.length > 1 ? (words[words.length - 1]?.[0] ?? "") : "";
  return (first + second).toUpperCase();
}

/**
 * First-letter-only monogram (privacy mode) — a single initial, deliberately
 * distinct from `initialsOf`'s two-letter badge so the privacy fallback reads
 * as "hidden on purpose", not "no portrait uploaded".
 */
export function firstInitialOf(name: string): string {
  return name.trim()[0]?.toUpperCase() ?? "?";
}

/** Deterministic hue (0–359) from a name, for the monogram gradient. */
export function hueOf(name: string): number {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = (hash * 31 + name.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) % 360;
}
