-- Data-only cleanup for the rolled-back adult-eligibility feature
-- (docs/developer-notes/finished/adult-eligibility.spec.md §1; removal is item 3 of
-- docs/developer-notes/romantic-contact-affordances.plan.md). The declaration never had a
-- column of its own — it lived as a top-level `adultEligibilityDeclaration` key inside the
-- existing `profile` jsonb of both record kinds — so the residue can only be swept in data,
-- not by a schema diff. Hence a hand-written `--custom` migration (drizzle-kit has nothing
-- to diff), in the same spirit as 0088's hand-added backfill.
--
-- Idempotent by construction: `- 'key'` on a jsonb object is a no-op once the key is gone,
-- and the `?` existence predicate means a re-run touches zero rows rather than rewriting
-- (and re-toasting) every profile. `?` is safe here — Postgres has no `?` bind placeholder,
-- and scripts/db-migrate.ts runs these statements through node-postgres, which uses `$n`.
-- The `jsonb_typeof` guard keeps a non-object profile (a bare jsonb scalar or array, which
-- `-` rejects for a text operand) from aborting the migration.
UPDATE "characters"
SET "profile" = "profile" - 'adultEligibilityDeclaration'
WHERE jsonb_typeof("profile") = 'object'
  AND "profile" ? 'adultEligibilityDeclaration';--> statement-breakpoint
UPDATE "personas"
SET "profile" = "profile" - 'adultEligibilityDeclaration'
WHERE jsonb_typeof("profile") = 'object'
  AND "profile" ? 'adultEligibilityDeclaration';
