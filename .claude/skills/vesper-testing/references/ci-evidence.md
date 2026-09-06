# CI evidence and uncovered suites

Read this before claiming a test ran or a change is fully covered. Repository-root [docs/testing.md](../../../../docs/testing.md#the-verification-gate) owns the current workflow shape; confirm `.github/workflows/ci.yml` and `package.json` when exact selection matters.

The aggregate `verify` check validates applicable jobs selected by the changed-path classifier. A skipped job can be correct for that revision. Green therefore means the selected jobs succeeded, not that every test project or integration file ran.

The `unit tests` job runs `pnpm test`, which selects the root `app` project and every package-owned pure suite. The `engine integration` job starts Postgres and runs `pnpm test:engine`, whose explicit path list selects successor simulation stores plus named narrator, admin, image, identity-pack, and route suites. It does not select the entire `app-int` project.

At minimum, `apps/web/src/app/api/gallery.int.test.ts` and `apps/web/src/server/api/authz-matrix.int.test.ts` are outside `test:engine`. Many legacy-chat, route, memory, retention, quota, and other integration suites are also outside it. Treat the `package.json` script as the exact source of truth rather than maintaining an inferred list.

For completion evidence:

1. Map each changed or added test file to the command that selects it.
2. Map that command to the CI job that actually ran at the tested commit.
3. Inspect job output when path filters or file arguments could exclude it.
4. Call any target suite outside the selected command **unverified**. Record the coverage gap in the current issue when issue editing is authorized, or report it to the owner for routing.

Do not use a local Vitest run to fill the gap. Do not claim an unscheduled integration script ran because a neighboring CI job was green.
