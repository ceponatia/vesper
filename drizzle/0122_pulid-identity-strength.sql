-- Send SDXL PuLID's two identity settings instead of inheriting the wrapper's
-- defaults for them (issue #383).
--
-- Data-only and hand-written, like 0104, 0107 and 0110: drizzle-kit has no
-- schema change to diff here. `pnpm db:migrate` is what the Fly deploy runs and
-- `pnpm db:seed` never touches image models, so a fresh database must come up
-- with these controls already on the rows.
--
-- WHAT CHANGES. Two fields this row never sent:
--
--   face_weight  wrapper default 0.8, range 0-1 -> 1.0
--   cfg          wrapper default 3              -> 7
--
-- `face_weight` is the strength of the PuLID adapter's pull toward the reference
-- face. This model is registered FOR identity preservation, and there is no
-- reading of that purpose on which Vesper wants the adapter at four-fifths
-- strength; 1.0 is the field's ceiling. `cfg` 3 is the wrapper default the
-- negative-field canary measured as the weak arm on this exact endpoint
-- (2026-08-29, pinned version 83bea633...: 6/6 coherent renders at cfg 7 against
-- 8/10 with degenerate output at the default).
--
-- Both settings ran on their wrapper defaults through every likeness observation
-- this row has, which is why `identity_preservation` is still `unknown` — the
-- rating has never been taken at the settings most likely to earn it.
--
-- WHICH CHANNEL EACH TRAVELS. `cfg` is a normalized control: `guidance` is
-- exactly the word for it, mapped to this model's `cfg` field. `face_weight` has
-- no normalized control and takes the same raw-override channel `method` already
-- uses -- the control vocabulary has no word for the strength of an identity
-- adapter, and inventing one for a single model would be a type change to say a
-- number.
--
-- WHAT THIS CHANGES IN THE PAYLOAD TODAY: nothing by itself, exactly as 0110
-- noted for the settings it wrote. This row still carries
-- `advanced_capabilities = '{}'`, so the normalized control has no probed
-- binding to map through (`no_binding`) and the raw override fails closed
-- against an empty `known_input_fields` (`unknown_field`). The transitional
-- overlay (`packages/image-core/src/models/quality-presets.ts`) is what delivers
-- both through `extra_input` until this version is probed, and it derives from
-- the same reviewed table this statement mirrors.
--
-- MERGE DIRECTION IS `reviewed || existing`, so an operator's own value WINS on a
-- key collision -- the parity rule 0110 states at length. The row's existing
-- reviewed keys are restated rather than sent alone: the statement then mirrors
-- the reviewed table exactly, and stays idempotent either way, since a second run
-- finds its own keys present and changes nothing.
UPDATE "image_model_profiles" p
SET "control_defaults" = v."controls" || p."control_defaults",
    "provider_overrides" = v."overrides" || p."provider_overrides"
FROM (VALUES
  ('nsfw-api/sdxl-pulid',
   '{"guidance":7,"resolution":"custom","width":832,"height":1216}'::jsonb,
   '{"method":"fidelity","face_weight":1}'::jsonb)
) AS v("base_slug", "controls", "overrides")
JOIN "image_models" m ON split_part(m."slug", ':', 1) = v."base_slug"
WHERE p."image_model_id" = m."id";
