/**
 * Machine bookkeeping tags: written by seeds and forges for provenance, never
 * meaningful to browse by. Hidden from every filter UI and card chip row; the
 * data itself is untouched.
 */
export function isMachineTag(tag: string): boolean {
  const t = tag.trim().toLowerCase();
  return t === "suggested" || t.startsWith("seed:");
}

/** The user-meaningful slice of a tag list (machine tags removed). */
export function visibleTags(tags: readonly string[]): string[] {
  return tags.filter((t) => !isMachineTag(t));
}
