/**
 * Move one element of a list to a new index, immutably. `to` is the index the
 * element ends up at after the move (not a pre-removal insertion point).
 * Out-of-range indices are clamped; a no-op move returns the original array.
 */
export function moveItem<T>(list: readonly T[], from: number, to: number): readonly T[] {
  if (list.length === 0) return list;
  const clamp = (i: number) => Math.min(Math.max(i, 0), list.length - 1);
  const fromIndex = clamp(from);
  const toIndex = clamp(to);
  if (fromIndex === toIndex) return list;
  const next = [...list];
  const [moved] = next.splice(fromIndex, 1);
  next.splice(toIndex, 0, moved as T);
  return next;
}
