-- Widen the curated anatomy LoRA's scale band to 0–2. The default stays at 1.
--
-- Data-only and hand-written, like 0108 which seeded the row and 0114 which
-- widened its task list: drizzle-kit has no schema change to diff here.
--
-- WHY THE BAND MOVES. 0108 fenced the row at 0.5–1.5 as a conservative ring
-- around the one strength the probe had actually rendered, and nothing has ever
-- been graded at either edge since: the acceptance bench swept two points, 1.0
-- and 0.75, and every scene-composition probe ran at 1. So 0.5–1.5 is a guess
-- around a measured centre rather than a finding about where these weights stop
-- working — and it is the tighter of the two fences, because both wrappers this
-- row is compatible with declare `lora_scale` as 0–4 with a default of 1, and
-- the provider's own plus-LoRA guidance puts subtle stylization at 0.6–1.0 and
-- dramatic transformation at 1.5 and above. Vesper's ceiling sat exactly where
-- the provider says the interesting range begins.
--
-- 0–2 is still a curation claim, not a slider convenience range: scale is
-- REFUSED, never clamped, so the band remains a statement about strengths a
-- reviewer will stand behind. What it adds is headroom for the staged-scene
-- bench to locate BOTH of the failures its verdict vocabulary separates —
-- `anatomy_withheld` is the scale too low, `geometry_wrong` is the scale too
-- high — where a band fenced below the provider's strong region can only ever
-- find the first. The default is deliberately untouched: the owner ruled on
-- 2026-08-16 that it stays 1.0, and widening the band is not evidence against
-- that ruling.
--
-- WIDENING THE STORED BAND WIDENS NOTHING AT THE PROVIDER. Curation and reach
-- are independent gates in `mechanicalLoraRefusal`: this band refuses with
-- `image_lora.incompatible`, while the ACTIVE version's own declared range for
-- its scale field refuses with `image_lora.unreachable_configuration`. A render
-- on a version that declares less than 0–2 is still refused before any spend by
-- the check that reads the version, not this row.
--
-- GUARDED so it cannot overwrite a deliberate edit. Seeded rows are ordinary
-- rows (owner ruling 4): an operator who has already retuned this band keeps
-- theirs and this statement matches nothing. A deleted row stays deleted.
UPDATE "image_loras"
SET "minimum_scale" = 0, "maximum_scale" = 2
WHERE "id" = 'imglorqwennsfwallinclv20'
  AND "minimum_scale" = 0.5
  AND "maximum_scale" = 1.5;
