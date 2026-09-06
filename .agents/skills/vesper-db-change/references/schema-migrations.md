# Schema migrations

## Authoring sequence

1. Edit `apps/web/src/server/db/schema.ts` as the schema source of truth.
2. From the repository root, run `pnpm db:generate` only when generation is in scope. `drizzle.config.ts` reads that schema and writes to `drizzle/`.
3. If Drizzle asks whether an object was created or renamed, stop. The diff is ambiguous; the owner must run generation interactively. Never script an answer, allocate a fake TTY, pipe `yes`, or leave stdin unbounded.
4. Review the new SQL and `drizzle/meta/_journal.json`. For a generated schema migration, also review the new snapshot as part of the same change. Confirm the journal index/tag, SQL, and snapshot describe one coherent transition and do not overwrite concurrent migration history.
5. Inspect SQL before any application. Do not substitute `drizzle-kit push` for checked-in migrations.

The baseline migration must continue to begin with `CREATE EXTENSION IF NOT EXISTS vector`; Drizzle will not recreate that extension statement if the baseline is regenerated. Do not rewrite or renumber existing history to make a new migration fit.

A guarded, data-only migration can be journaled without a new schema snapshot. Classify it explicitly and confirm that it makes no schema transition rather than fabricating snapshot churn.

## Semantic review

For every affected table, answer these questions from current data and both application versions:

- What happens to existing rows? Separate a database default for future inserts, a migration-time backfill, and an application fallback.
- Can the column be null during rollout? For a populated table, prefer an expand/backfill/validate/contract sequence when adding `NOT NULL`, uniqueness, or a restrictive foreign key cannot be proven safe in one bounded migration.
- Is the backfill guarded, deterministic, idempotent, and narrow enough to preserve operator-edited rows? State how unmatched and malformed rows behave.
- Can a cast truncate, reinterpret, or reject stored values? Can a drop, delete, cascade, uniqueness constraint, or replacement table lose data?
- Do index or constraint creation and large updates hold locks long enough to affect the serving application?
- Do `onDelete`, defaults, check constraints, and indexes match the application contract rather than merely allowing generation to pass?
- Is forward recovery clear if the release command succeeds but the new application fails? Do not rely on a destructive down migration as the recovery plan.

`scripts/db-migrate.ts` runs the checked-in Drizzle migrations and then `applyDatabaseHardening`. Review the hardening step's current behavior when the affected data overlaps it; applying migrations can therefore mutate data beyond a newly added SQL file.

## Deployment and evidence

`fly.toml` runs `pnpm -w run db:migrate` as the Fly release command before new Machines receive traffic. The old application can continue serving while the migration runs. Keep the transition compatible with the old and new application versions, or stage an incompatible contract change across releases.

CI's engine integration migrates a fresh Postgres database from zero and then runs the repository's curated `pnpm test:engine` selection. This proves only that checked-in history can build that fresh schema and that the selected suites passed. It does not by itself prove an upgrade of representative populated data, production lock behavior, a backfill's preservation rules, or any unselected `app-int` suite.

Before delivery, record:

- the schema and migration files reviewed;
- expected row transformations and any preflight evidence;
- the old-app/new-schema and new-app/new-schema compatibility result;
- the exact CI job and selected coverage, if run;
- the intended release order and forward-recovery action;
- deployed migration and application checks only when they actually ran against the identified target.
