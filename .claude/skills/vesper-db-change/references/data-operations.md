# Data migrations and database operations

## Choose the durable mechanism

Use a checked-in, guarded SQL migration when database-backed rows must converge in every environment as part of release history. Match exact known prior values when replacing catalog data so an administrator's independent edits are not silently overwritten. Make inserts conflict-aware and updates or deletes narrow enough to explain every affected row.

Use an operational script or bounded query only for a target-specific repair, investigation, or backfill that does not belong in every environment. Treat any write as a mutation even if it is described as cleanup or repair. Prefer a dry-run or read-only preflight, stable batches, resumable progress, explicit transactions where appropriate, and a postcondition that distinguishes zero matching rows from success.

Source-backed registries are ordinary code/data edits unless their persisted representation changes. Do not introduce SQL merely because the word “registry” appears in the task.

## Target and authorization

Before an operational action, establish and report without secrets:

- environment and owning service;
- Neon project and branch;
- endpoint role and database name when needed to prevent ambiguity;
- the schema version or pending migration set;
- whether the action is read-only, migration application, seed, repair, or backfill;
- the existing session instruction that authorizes the mutation.

If the target cannot be distinguished or the requested mutation exceeds the existing authorization, stop before the write. Do not print a connection URL, password, token, complete environment dump, or user content as evidence.

## Applying and verifying

`pnpm db:migrate` applies repository migrations from `drizzle/` through `scripts/db-migrate.ts` and then runs database hardening. Apply it only to the known, authorized target. Use the repository command rather than a separately invented Drizzle invocation.

`pnpm db:seed` is separate from migration. The current seed script recreates tagged development fixtures and provisions the UI QA credential, so never infer permission to run it from permission to migrate, and never run it automatically in production. `pnpm db:create` also requires a separately intended target and operation.

After an authorized write, verify the effect at the same target:

1. Confirm the expected migration history or operation result through a schema-aware query or the current Neon tooling; do not guess a metadata relation name.
2. Check the changed columns, constraints, indexes, or guarded row predicate directly, using counts or redacted identifiers rather than sensitive row contents.
3. Detect partial work, skipped guarded rows, and unexpected matches explicitly.
4. When application behavior changed, use `$verify` on the deployed Fly release and record the release, route or UI flow, and observed result.
5. Report which checks were not run. A successful command exit alone does not prove the intended data or deployed behavior.

Avoid automatic retries for non-idempotent writes. If the result is uncertain, inspect target state before deciding whether another attempt is safe.
