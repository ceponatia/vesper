---
name: vesper-db-change
description: Plan, implement, review, and verify Vesper database schema migrations, durable data changes, and authorized Neon operations. Use when changing the Drizzle schema or migration history, backfilling stored data, changing database-backed catalog rows, or acting on a known database target.
---

# Vesper database changes

Classify the change before editing or acting:

| Change | Owner and path |
| --- | --- |
| Registry vocabulary stored in source, such as attributes, meters, fact kinds, or body locations | Edit the owning registry data. Do not create a database migration unless the persisted shape changes. |
| Tables, columns, indexes, constraints, foreign keys, or stored types | Edit `apps/web/src/server/db/schema.ts`, then follow the schema-migration workflow. |
| Durable database-backed defaults, catalog rows, or backfills | Use guarded migration SQL when every environment must converge. A schema edit may be unnecessary. |
| Inspecting or mutating a Neon branch, applying migrations, seeding, or a one-off repair | Treat this as an operational database action against an explicitly identified target. |

Read [schema-migrations.md](references/schema-migrations.md) for schema, generated migration, compatibility, or deploy-order work. Read [data-operations.md](references/data-operations.md) for data migrations, backfills, seeding, or actions against Neon. Use [database-change-review.md](templates/database-change-review.md) to make a change reviewable.

## Guardrails

- Work from the repository root. Read `docs/README.md`, `docs/database/README.md`, and the documentation for the affected database-backed system.
- Use `$neon-postgres` before identifying or acting on a Neon project, branch, endpoint, or database. Preserve the repository's Drizzle and `pg` stack.
- Existing session authorization persists, but authoring a migration does not authorize applying it to production, creating a database, or seeding one. Resolve the exact target and authorization before a mutation.
- Redact credentials and connection strings. Report project, branch, endpoint, and database identifiers only to the extent needed to distinguish the target.
- Never use `drizzle-kit push`. Never automate Drizzle's create-versus-rename prompt with a fake TTY, `yes`, or unbounded input. If that prompt appears, stop generation and have the owner run `pnpm db:generate` interactively.
- Do not automatically run `pnpm db:create`, `pnpm db:migrate`, or `pnpm db:seed`. Seed is a separate, potentially destructive operation even when it is idempotent for its intended fixtures.
- Do not run local application tests, lint, typecheck, builds, or Vitest. Use `$vesper-testing` to identify the owning coverage and the exact CI job that selects it. A green aggregate check does not prove an unselected `app-int` suite ran.
- Use `$verify` for authorized deployed-path checks after the relevant Fly release and database target are known.

## Completion record

State the classification, affected schema/data contract, generated or hand-authored artifacts, compatibility and data-loss analysis, deployment order, exact target evidence, and what remains unverified. Do not claim production application, seed, or deployed verification unless it actually ran against the named target.
