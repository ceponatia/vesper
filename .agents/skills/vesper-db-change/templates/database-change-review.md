# Database change review

## Identity and classification

- Change: `[issue or concise purpose]`
- Class: `[source registry | schema | durable data migration | operational action]`
- Schema/data owner: `[file, table, or registry]`
- Intended target: `[none during authoring | environment / Neon project / branch / database]`
- Mutation authorization: `[not needed | existing session instruction]`

## Artifacts

- [ ] `apps/web/src/server/db/schema.ts` change is necessary and matches the intended contract.
- [ ] Migration SQL was reviewed statement by statement.
- [ ] `drizzle/meta/_journal.json` has the expected new entry.
- [ ] The generated schema snapshot matches the SQL, or this is explicitly a data-only migration with no schema snapshot.
- [ ] Existing migration history was not rewritten or renumbered.
- [ ] The baseline still preserves `CREATE EXTENSION IF NOT EXISTS vector`.

Artifacts reviewed: `[paths and migration tag]`

## Existing data and compatibility

- Existing-row behavior: `[default, null state, and backfill separately]`
- Backfill guard and unmatched-row behavior: `[predicate and expected counts]`
- Data-loss analysis: `[drops, deletes, casts, truncation, cascades, uniqueness]`
- Lock and runtime analysis: `[large updates, indexes, constraints]`
- Old application with migrated schema: `[compatible or staged requirement]`
- New application with migrated schema: `[expected contract]`
- Forward recovery: `[safe action if app release fails after migration]`

## Execution order

1. `[preflight or expansion]`
2. `[checked-in migration / bounded operation]`
3. `[application release or backfill]`
4. `[validation and later contract step, if any]`

- [ ] No `drizzle-kit push` is used.
- [ ] No production migration, create, repair, or seed is implied by authoring approval.
- [ ] Secrets and stored user content are absent from logs and evidence.
- [ ] The effect of post-migration database hardening was considered.

## Evidence

- CI job and exact selected suite: `[job / command / paths, or not run]`
- Fresh-database migration result: `[evidence or unverified]`
- Representative populated upgrade/backfill result: `[evidence or unverified]`
- Target postconditions: `[redacted query/tool result or unverified]`
- Fly release and deployed behavior: `[release and observation or unverified]`
- Remaining risk: `[specific limitation]`
