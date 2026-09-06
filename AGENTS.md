# Vesper — agent instructions

## Start with evidence

- Within the instruction hierarchy, preserve the user's stated goal, preferences, scope, and authorization.
  Verify material factual premises against repository state or authoritative sources before relying on them.
- Exercise independent judgment. Respectfully challenge a concrete complexity, UX, cost, or architecture
  problem with evidence and a smaller alternative. Do not manufacture objections or re-ask settled choices.
- Inspect the current branch, worktree, relevant code, and scoped instructions before changing files.
  Other agents may be editing the checkout; preserve their work and never revert unrelated changes.
- Delegate independent slices when useful. Brief each with the goal and acceptance criteria, exact owned paths,
  relevant docs/examples, validation route, and authorized actions. Name shared-checkout constraints, keep
  dependent work sequential, and review the result.
- This app is under active development. Prefer removing obsolete behavior over compatibility wrappers unless
  the user or current product contract requires compatibility.

## Skills and work state

- Canonical skills live under `.agents/skills/`; `.claude/skills/*` are compatibility symlinks. Edit the
  canonical source and follow a matching skill when its trigger applies.
- `vesper-docs` owns issue text and durable docs; `vesper-board` owns issue creation and lifecycle mechanics.
- `vesper-agent-build` owns delegated implementation; `vesper-testing` test placement and CI selection;
  `vesper-pr-review` CI/review/merge; and `verify` authorized Fly evidence.
- `vesper-branch-recovery`: stale branches, abandoned worktrees, suspected lost work, and cleanup evidence.
- `vesper-db-change`: schema migrations, durable data changes, backfills, and authorized Neon operations.
- `vesper-model-onboard`: text/image model identity, provider evidence, adapters, and deployed behavior.
- `vesper-skill-maintenance`: skill discovery, routing, helpers, and hook/runtime compatibility.
- GitHub issues and the Vesper Development board own plans, status, sequencing, dependencies, blockers, and
  open questions. Never create plan documents. The repository owns current technical truth.
- Read `docs/README.md` before editing `docs/`, then the relevant system docs. Durable docs use present-tense
  rules, carry no work status, and change with the behavior they describe. Invoke `vesper-docs` first.

## Architecture and implementation

- Vesper is a pnpm workspace: the Next app is `apps/web`; reusable packages are under `packages`; root owns
  scripts, migrations, deployment files, and repository gates. Run pnpm only from the repository root.
- Import workspaces only by declared package name/export; packages never import the app or use filesystem
  escapes. Preserve the layer graph in `docs/architecture.md` and add no forbidden sibling edge. Stateful
  Vesper behavior stays in `apps/web/src/server`.
- Packages ship TypeScript source through exact declared exports; aliases must not hide broken manifests.
  Register a new package in the Dockerfile
  manifest COPY and `apps/web/next.config.ts` `transpilePackages`; recursion discovers its scripts.
- `scripts/web.mjs` solely owns `DATA_ROOT` and root `.env` loading. Do not add another loader or load env in
  `next.config.ts`. Root scripts may reach app source through `@/`; relative root-to-app imports are forbidden.
- `apps/web/src/contracts` and `apps/web/src/lib` are pure. Components never import server modules. Server
  modules import one another through their `index.ts` barrels.
- Follow `docs/resilience.md`: use `parseOr` at trust boundaries, diagnostics over exceptions, and degraded
  defaults over failed turns. Registry vocabulary changes are data edits rather than schema migrations.
- Before UI work, read the relevant `docs/ui/` guidance and inspect existing components and primitives. Extend
  the owning pattern instead of creating a parallel interaction or visual system.
- In JSX prose, preserve whitespace at line-wrapped expression/element boundaries with `{" "}` or explicit
  string-expression children.

## Database changes

- Follow schema -> `pnpm db:generate` -> review generated SQL -> migrate. Never use `drizzle-kit push`.
- Never automate Drizzle's interactive create-versus-rename choice with a fake TTY or unbounded input. If it
  asks, stop and have the owner run generation and resolve the ambiguity.
- Preserve `CREATE EXTENSION IF NOT EXISTS vector` in the baseline migration. Use `vesper-db-change` for the
  full workflow and distinguish the intended database target before any live operation.

## Testing, CI, and live evidence

- Do not run local application tests (including any Vitest form), lint, typecheck, or builds. Diagnose from
  code and CI logs. `pnpm lint:docs` is the documentation exception.
- Dependency-free offline fixtures for skill/helper behavior may run locally if they import no application
  code, start no service, and make no external mutation. They never substitute for application CI.
- GitHub Actions CI on CodeBuild is the gate. Draft PRs run no gates; ready PRs run applicable jobs. The
  aggregate `verify` check is required on `main` and `prod`.
- Do not add a CI workflow without an explicit owner decision.
- Report only what the exact workflow/run selected at the tested head SHA. A green aggregate does not prove
  an unscheduled suite ran; the full `app-int` surface is not currently selected by ordinary CI.
- UI testing runs only against `https://vesper.fly.dev`; `verify` owns QA-account selection and sign-in.
  Never substitute local Postgres plus `pnpm dev` for UI evidence.
- Put screenshots, rendered evaluations, and all other evaluation/task output in gitignored root
  `eval-images/`, never in `docs/`. Prefer an existing conversation; remove disposable state created for QA.

## Git and delivery

- Code, configuration, dependency, and workflow changes reach `main` through a branch and PR unless the user
  explicitly directs otherwise. Documentation-only changes may go directly to `main`. Use conventional commits.
- Branches start from their issue through `vesper-board`; do not begin with an unlinked `git checkout -b`.
- Never merge based on unrelated checks or stale-head evidence. Use `vesper-pr-review` and require the current
  full PR head's required checks, review state, and existing authorization.
- For every review comment acted on, reply with what changed and the commit, then resolve only that addressed
  thread. This remains required after merge. Explain disagreements and leave those threads open.
- Deployment and live mutations require current authorization and the owning operational skill. Use `verify`
  for Fly deployment and application evidence; report the observed release, commit, target, and unverified stages.
