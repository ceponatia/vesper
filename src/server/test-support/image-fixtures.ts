import { newId } from "@/lib/ids";

/**
 * Build an `images` row that satisfies the `images_path_canonical` CHECK
 * constraint (`scripts/db-hardening.ts`), which requires the stored path to be
 * exactly `images/<owner_id>/<id>.webp`.
 *
 * Fixtures used to hand-write a readable filename (`images/<owner>/scene.webp`)
 * back when `path` was free-form text. The constraint made every one of those a
 * failed insert, so the id and the path are derived together here — a suite
 * cannot pick one without the other.
 */
export function canonicalImageRow<T extends { ownerId: string; id?: string }>(
  values: T,
): T & { id: string; path: string } {
  const id = values.id ?? newId();
  return { ...values, id, path: `images/${values.ownerId}/${id}.webp` };
}
