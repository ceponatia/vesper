-- Seed the one curated LoRA row the klein 4B RefControl depth recipe selects
-- (docs/images/providers/loras.md §RefControl depth row (klein 4B, pilot)): the
-- published `thedeoxen/refcontrol-FLUX.2-klein-4B-reference-depth-lora` weights,
-- re-hosted into the owner's public bucket, bound to
-- `black-forest-labs/flux-2-klein-4b-base-lora` and to nothing else.
--
-- Data-only and hand-written, like 0104, 0107, 0108 and 0136: drizzle-kit has no
-- schema change to diff here, so this migration carries no snapshot. It is a
-- migration rather than a seed script because `pnpm db:migrate` is what the Fly
-- deploy runs and `pnpm db:seed` never touches the image registries, so a fresh
-- database must come up with this row already present.
--
-- THE LOCATOR IS A VERIFIED RE-HOSTED ADDRESS AND CARRIES NO CREDENTIAL. The
-- endpoint's `lora_weights` field takes a LIST OF URLS, so the Hugging Face
-- repository is a source reference rather than something to send: Vesper's
-- `huggingface_repo` resolver passes a slug through unchanged, and a slug is not
-- a URL this provider can fetch. The artifact was therefore downloaded at the
-- publisher's pinned revision 0ae1ef7f9acc4e55ec2237360943c3c3032d3583, checked
-- against the published size (92426784 bytes) and sha256
-- (65ec4c71...5826c401) BEFORE upload, and re-hosted under a key that carries the
-- checksum's first eight hex characters so the address names the exact bytes.
-- The URL has no query string, no token and no expiry — unlike the Civitai row
-- 0108 seeds, nothing is appended to it at send time, and there is no credential
-- for this table to leak.
--
-- `compatible_model_slugs` names ONE base slug, and naming it is the point.
-- Compatibility is judged base-slug to base-slug, so the registered row's version
-- pin may move without this row chasing it. The near misses are what this list
-- exists to refuse: `…-4b` and `…-4b-base` declare no LoRA pair at all, and the
-- 9B siblings are a different size class under a non-commercial licence (#564)
-- that Vesper registers no row for. A name that resembles the target is not
-- compatibility.
--
-- `compatible_version_ids` is NON-EMPTY here, the opposite of 0108, and that is a
-- deliberate claim rather than a copied habit. A non-empty list means "these
-- weights do not survive a version change", so a render that cannot state its
-- version is refused instead of tried. Everything Vesper knows about this recipe
-- — the array-shaped binding, the two-reference order, the band below — was read
-- from THIS fixture version's published schema, so a version move is a
-- re-curation an operator must make explicitly, not something a migration should
-- pre-authorize.
--
-- THE BAND IS A PILOT CHOICE, NOT A MEASUREMENT. 0.8–1.0 around 0.9 is the weight
-- range the publisher's model card recommends. It is not a provider-declared
-- limit — this version's `lora_scales` declares no `items.minimum`/`maximum`, and
-- prose in a field description is not a bound — and it is not a measured optimum:
-- no render has been graded, and #569 owns that. Scale is refused, never clamped,
-- so the band states which strengths are curated rather than sliding a request
-- into range.
--
-- `allowed_tasks` IS EMPTY, WHICH MEANS GENERATOR-ONLY. Empty is read
-- fail-closed — no production task and no Image Lab task may use these weights —
-- while `generator_bench` carries no task at all and so skips task curation
-- entirely, still enforcing every mechanical rule above
-- (packages/image-core/src/loras/execution-context.ts). That asymmetry is how the
-- row runs in the admin bench while granting itself no player-facing eligibility.
-- Widening it is an operator's curation decision, never a workaround for a bench
-- refusal.
--
-- The trigger word is stored ONCE, in `trigger_words`, and the prompt additions
-- stay NULL. The compile step weaves a missing trigger into the prompt and skips
-- one already present, so repeating `refcontrol` in a prefix or suffix would put
-- it in the sent prompt twice and read to the model as emphasis nobody asked for.
--
-- ON CONFLICT DO NOTHING makes the statement idempotent: replayed by hand, or run
-- where this id already exists, it writes nothing rather than overwriting an
-- admin's curation. Seeded rows are ORDINARY rows (owner ruling 4, recorded on
-- 0108) — an admin may retune this band, switch the row off, or delete it, and
-- the Generator simply stops offering the LoRA. A DELETION IS NOT RESURRECTED by
-- a later deploy, and the mechanism for that is the migrator's ledger rather than
-- this clause: `pnpm db:migrate` applies each file exactly once per database and
-- records it in `drizzle.__drizzle_migrations`, so this statement never runs a
-- second time on its own. Anything that re-executed it every deploy — a seed
-- script, a hardening step — would undo that, which is the reason this row is
-- seeded by a migration and nothing else.
INSERT INTO "image_loras" (
  "id", "label", "locator_type", "locator", "compatible_model_slugs", "compatible_version_ids",
  "default_scale", "minimum_scale", "maximum_scale", "trigger_words", "prompt_prefix",
  "prompt_suffix", "allowed_tasks", "enabled", "builtin"
) VALUES (
  'imglorklein4brefdepthaaa',
  'FLUX.2 klein 4B RefControl depth (pilot)',
  'https_url',
  'https://snarebox-pub.s3.us-east-2.amazonaws.com/lora/flux2_klein_4b_refcontrol_depth-65ec4c71.safetensors',
  '["black-forest-labs/flux-2-klein-4b-base-lora"]'::jsonb,
  '["c8ca755d41dd4a19b8fe1f50247bc6b37c73ac5321af8277d97c5e66e803ecdc"]'::jsonb,
  0.9, 0.8, 1.0,
  '["refcontrol"]'::jsonb, NULL,
  NULL,
  '[]'::jsonb, true, true
)
ON CONFLICT ("id") DO NOTHING;
