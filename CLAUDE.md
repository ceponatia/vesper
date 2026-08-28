# Vesper — agent notes

- `AGENTS.md` is a symlink of `CLAUDE.md`; update `CLAUDE.md` only. Note this only works on Linux, not Windows. AGENTS.md will be blank on Windows.
- This app is under active development. Do not preserve legacy behavior by default; prefer deleting obsolete code over deprecation wrappers.

## Documentation & work state

- **GitHub owns work state; the repository owns technical truth.** Plans, status, sequencing, dependencies, and open questions live on the [Vesper Development board](https://github.com/users/ceponatia/projects/7) and its issues — never in repo documents. Plan documents are retired: a plan-sized effort is a parent issue with sub-issues, dependencies are native blocked-by relations, and a blocking open question is a `decision-needed` issue.
- Documented system-by-system in `docs/`. **Read `docs/README.md` first**, then the relevant system doc, and update it in the same change when behavior or patterns shift. Durable docs state present-tense law and carry no status, no remaining work, and no blockers.
- **Invoke the `vesper-docs` skill before writing or editing any Markdown under `docs/`, before filing or restructuring issues, and whenever deciding where information belongs** (`.claude/skills/vesper-docs/`). It owns the routing table (issue vs reference page vs ADR), the no-dynamic-state rule, issue and sub-issue conventions with verified commands, templates, and validation.

## Architecture

- **This is a pnpm workspace.** The Next app is `@vesper/web` under `apps/web`; reusable packages live under `packages/`; the root holds scripts, migrations, deployment files, and repo-wide gates.
  - Run pnpm from the repository root (`pnpm-workspace.yaml` pins it), never a parent directory.
  - Packages import other packages by name only — never the app, never a filesystem path. If a package seems to need app code, pass the value in or leave the code in the app.
  - Current packages:
    - `@vesper/image-core` (provider-neutral image engine)
    - `@vesper/simulation-core` (simulation contracts/kernels/scheduler)
    - `@vesper/contracts` (diagnostics/parsing/determinism primitives)
    - `@vesper/image-replicate` (server-only Replicate transport)
    - `@vesper/image-sd` (Stable Diffusion recipes, training manifests, deployment contracts).
  - `image-core` and `simulation-core` are peers, as are `image-sd` and `image-replicate`; peers never import each other, and the SD package never calls the provider. Stateful Vesper-specific image/simulation code stays under `apps/web/src/server`.
  - Packages ship TypeScript source with declared `exports`. No tsconfig or Vitest alias may paper over a broken manifest, and published subpaths are exact entries, never `*` patterns.
  - Adding a package: two registrations fail late and name no cause — a manifest COPY in the `Dockerfile`, and a `transpilePackages` entry in `apps/web/next.config.ts`. Ordinary scaffolding aside, everything else is caught by `lint:package-boundaries` or `lint:package-resolution` with a message naming the fix. Do not enumerate the package in root scripts or a root Vitest project; `pnpm -r` recursion finds it.
  - `pnpm lint:package-boundaries` enforces dependency direction, declared dependencies/subpaths, browser-vs-Node runtime rules, no relative workspace escapes, and no published-entry `export *`. `pnpm lint:package-resolution` imports every declared entry. Both run in CI's static-checks job.
  - `scripts/web.mjs` is the single owner of `DATA_ROOT` and the root `.env`; `pnpm dev`/`build`/`start` all run through it, Fly's Docker build included. Never add a second loader or load env in `next.config.ts` — `next start` never executes it, so a loader there works in dev and silently fails in production.
  - Root scripts may import app source through `@/…` — the only sanctioned root→app edge. Relative root imports into `apps/web` are forbidden.
  - Each workspace owns its `typecheck`/`test` scripts; root commands recurse with `pnpm -r --workspace-concurrency=1`, and workspace validation stays serial. `apps/web` has no `test` script by design: the root Vitest config owns the app/app-int suites and repo-root test setup. See `docs/testing.md`.
- `apps/web/src/contracts` and `apps/web/src/lib` are pure (no IO/env/db). Server modules import each other only through `index.ts` barrels. Components never import `server/*`. ESLint enforces these boundaries.
- Resilience rules in `docs/resilience.md` are mandatory: `parseOr` at trust boundaries, diagnostics over exceptions, degraded defaults over failed turns.
- Registries (attributes, meters, fact kinds, body locations) are extension points; vocabulary changes are data edits, not schema migrations.
- **JSX prose-boundary whitespace:** guard line-wrapped boundaries after `{expr}`/elements with `{" "}` or explicit string-expression children.
- DB workflow: edit `apps/web/src/server/db/schema.ts` → `pnpm db:generate` → review SQL in `drizzle/` → `pnpm db:migrate`. Never use `drizzle-kit push`. Preserve `CREATE EXTENSION IF NOT EXISTS vector` in the baseline migration.
  - **Never automate `db:generate`'s interactive create-vs-rename prompt with a fake TTY or unbounded input.** If Drizzle asks, the diff is ambiguous — stop and ask the owner to run `pnpm db:generate` themselves.

## Testing

- Tests: `pnpm test` (pure), `pnpm test:int` / `pnpm test:engine` (need Postgres). CI runs the pure suite on every ready PR, and `test:engine` plus the Gate 1 benchmark in its engine job. Run `test:int` manually when its covered surface changes. Degradation tests assert fallback **and** diagnostic code.
- **Invoke the `vesper-testing` skill before creating, expanding, or substantially rewriting tests** (`.claude/skills/vesper-testing/`). Protect meaningful invariants, regressions, and failure modes at their one owning layer; extend existing coverage instead of duplicating it, and do not add tests merely because code changed. Test count is not a quality metric here, and "no new test" is a valid outcome.
- **UI testing runs against the Fly deploy** (`https://vesper.fly.dev`), never a local Postgres + `pnpm dev`. Local dev stays valid for non-UI work and DB scripts.
  - **UI/QA account:** `uxtest-main@vesper.local`, id `uxtestmaina1b2c3d4e5f6g7`, role `admin` — use it for manual/Playwright UI tests instead of seed/`Player` data. Auth uses a signed Better Auth session (`docs/auth.md`); sign in at `/sign-in` with the `DEV_PASSWORD` Fly secret. `/api/dev/impersonate` is local-only, disabled in production.
  - Prefer an **existing** conversation. Create a new chat only when the test needs state you cannot edit into an existing one, and delete it when done.
  - Screenshots and all other evaluation/dev-task imagery go in the gitignored root `eval-images/` — never under `docs/`; graded render evidence goes in `evidence/`.

## Validation & CI

- **CI is the gate:** GitHub Actions on AWS CodeBuild managed runners (`.github/workflows/ci.yml`, `runs-on: codebuild-vesper-ci-…`; owner decision 2026-08-21). There are **no local git hooks** — commits and pushes run nothing. The aggregate `verify` status check is **required on `main` and `prod`**; a PR merges only when it is green.
- Milestone-gated per the workflow header: draft PRs run nothing, ready PRs run the applicable gates, and `gh workflow run CI --ref main` is the deliberate full run. CodeBuild bills per job-minute, so keep PRs draft while iterating.
- For documentation-only changes, review Markdown rendering, links, and consistency instead of running code gates.
- Two workflows exist: `ci.yml` (the CI suite) and `promote.yml` (manually opens the `main` → `prod` PR). Do not add another without an explicit owner decision.

## Git & delivery

- After each **major task**, use a descriptive conventional commit (`feat:` / `chore:` / `docs:` …). **Code, config, dependency, and workflow changes reach `main` through a branch + PR; documentation-only changes may go directly to `main`.** Minor fixes can ride with the next major task instead of getting their own PR.
- **Close the loop on every review comment you act on.** When a review (Codex, another agent, or a person) raises something worth implementing: fix it, then **reply on that thread saying what changed and where — naming the commit — and mark the thread resolved.** This holds after the PR is merged; a fix that landed on `main` still gets its reply and resolution. Never resolve a thread you did not address, and never silently fix one: an unanswered thread reads as ignored, and a resolved-but-unanswered one destroys the record of why the change happened. Disagreeing is fine — reply with the reasoning and leave it open for the owner.
  - Replies: `gh api repos/ceponatia/vesper/pulls/<pr>/comments/<comment-id>/replies -f body="…"`. Resolving needs GraphQL `resolveReviewThread` with the thread id from `pullRequest.reviewThreads`.
- `git doc` is the owner's doc-only shortcut (`git add -A && git commit -m "documentation updates" && git push`). It stages everything, so confirm the worktree is doc-only first; otherwise commit by pathspec. `git wip` is the scratch equivalent.

## Deployment & environments

- Deploy with `fly deploy -a vesper` and verify with `fly status -a vesper`. See `docs/deployment.md`.
- On a fresh or missing-row Neon DB, seed over SSH with `fly ssh console -a vesper -C "pnpm db:seed"` so the QA account and its credential are both provisioned.
