-- Let the curated anatomy LoRA run portrait-VARIANT renders as well as scene ones,
-- for the portrait studio's `nsfw_test` bench kind.
--
-- Data-only and hand-written, like 0108 which seeded the row: drizzle-kit has no
-- schema change to diff here.
--
-- WHY WIDEN RATHER THAN ADD A ROW. `allowed_tasks` is fail-closed by design, and
-- 0108 set it to `scene` alone because that was the only lane the ~45 graded probe
-- renders covered. Adoption by another lane was always meant to widen this field
-- rather than mint a second row pointing at the same weights (0108's own note, and
-- intimate-scene-lora.spec.md): two rows would be two scale bands, two enabled
-- switches, and two things for an admin to keep in step.
--
-- The `nsfw_test` variant is the same render shape the probes graded — a
-- reference EDIT of the character's own canonical portrait on the LoRA-capable
-- Qwen edit wrapper — with the sheet's intimate attributes stated and clothing
-- left to the typed instruction. Nothing else about the row changes: same
-- locator, same 0.5–1.5 band around the probed default of 1, same wrapper.
--
-- GUARDED so it cannot overwrite a deliberate edit. Seeded rows are ordinary rows
-- (owner ruling 4): if an admin has already retuned this list, theirs stands and
-- this statement matches nothing. A deleted row likewise stays deleted.
UPDATE "image_loras"
SET "allowed_tasks" = '["scene","variant"]'::jsonb
WHERE "id" = 'imglorqwennsfwallinclv20'
  AND "allowed_tasks" = '["scene"]'::jsonb;
