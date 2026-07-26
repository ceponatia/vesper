import type { Pool } from "pg";

/**
 * Post-migration database invariants that protect data consumed outside SQL.
 * Kept idempotent because `db:migrate` runs on every environment promotion.
 */
export const IMAGE_PATH_CONTAINMENT_SQL = `
UPDATE "images"
SET "path" = 'images/' || "owner_id" || '/' || "id" || '.webp'
WHERE "path" IS DISTINCT FROM 'images/' || "owner_id" || '/' || "id" || '.webp';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'images_path_canonical'
      AND conrelid = 'images'::regclass
  ) THEN
    ALTER TABLE "images"
      ADD CONSTRAINT "images_path_canonical"
      CHECK ("path" = 'images/' || "owner_id" || '/' || "id" || '.webp');
  END IF;
END
$$;
`;

/**
 * Repair legacy/corrupted rows before installing the immutable canonical-path
 * constraint. A repaired row whose old file was elsewhere safely degrades to a
 * missing canonical file; image_sweep marks it failed without touching the old
 * path.
 */
export async function applyDatabaseHardening(pool: Pick<Pool, "query">): Promise<void> {
  await pool.query(IMAGE_PATH_CONTAINMENT_SQL);
}
