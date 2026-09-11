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

  ## Subagent model policy (Codex Only)

Use subagents aggressively when work can be investigated or executed
independently.

Normal delegated work should use the default subagent configuration.
The default subagent is expected to be GPT-5.6 Terra at medium reasoning.

Do not escalate merely because a task is large. Terra is appropriate for:

- repository exploration
- implementing well-specified GitHub issues
- ordinary bug fixes
- tests
- contained refactors
- repetitive or mechanical implementation work

Escalate to the `sol_escalation` agent when any of the following occurs:

- a Terra worker makes two materially different attempts without resolving
  the underlying problem;
- the worker cannot determine the root cause from available evidence;
- implementation reveals architectural ambiguity not captured by the issue;
- the task unexpectedly involves concurrency, transaction semantics,
  persistence/replay correctness, migrations, authorization/security
  boundaries, or similarly consequential system behavior;
- tests fail in ways that contradict the worker's model of the system;
- the worker reports that multiple plausible implementations have
  substantially different architectural consequences;
- the main agent has low confidence that the Terra result is correct.

When escalating:

1. Do not ask another Terra worker to start over from scratch.
2. Provide `sol_escalation` with the originating task, relevant findings,
   attempted approaches, changed files, test output, and unresolved question.
3. Let the Sol agent reconsider the approach rather than merely repair the
   previous patch.
4. After Sol returns, integrate or continue based on its findings.

Do not use Sol escalation for routine work solely because it is available.

## Subagent model policy (Claude)

A delegated slice runs on a project role under `.claude/agents/`, and each of
those roles pins its own model in its frontmatter; the parent never passes
`model` on a call to a `vesper-*` role. `.claude/hooks/agent_policy.py`
(a PreToolUse hook on the Agent tool) enforces this: it refuses an
implementation brief sent to an un-pinned agent type, a `vesper-escalation`
spawn with no escalation record, and an explicit `model` override on a
pinned Vesper role.

| Role | Model | Use |
| --- | --- | --- |
| `vesper-builder` | Sonnet | Default worker for a bounded slice with a brief: well-specified issues, ordinary fixes, tests, contained refactors, mechanical work. Stops after one failed attempt and returns an escalation record instead of retrying. |
| `vesper-escalation` | Opus | Takes over a slice from that record, or owns from the start a slice touching kernel or simulation-core logic, migrations, authorization, persistence or replay correctness. Reconsiders the approach instead of repairing the previous patch. |
| `vesper-reviewer` | Opus | Read-only semantic review of a diff before integration or a PR. |
| `vesper-test-keeper` | Opus | Test reconciliation after a coding task; see Skills and work state. |

Escalate when: the builder returns an escalation record or reports a failed
attempt; a second plausible approach would have different architectural
consequences; the root cause cannot be determined from the evidence; CI fails
in a way that contradicts the builder's model of the system; or the parent
has low confidence in the result. Hand `vesper-escalation` the originating
brief, findings, attempted approaches, changed files, CI output, and the
unresolved question — do not restart from scratch, and do not escalate
merely because a task is large.

The built-in Explore and Plan agents take no brief and no model.
`CLAUDE_CODE_SUBAGENT_MODEL` is only the default for ad-hoc spawns that pin
nothing, and is set to `claude-sonnet-5`; never set
`CLAUDE_CODE_SUBAGENT_MODEL_FORCE`, which would erase the per-role pins.
Subagents never run on the session's own model when that model is Fable.

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
- For substantial delegated work, use `vesper-task-context`. Select `vesper-ux-review`, `vesper-ui-quality`,
  or `vesper-scenario-review` when the change warrants that review; their custom roles live in `.codex/agents/`.
- After any coding task, run the `vesper-test-keeper` role (`.codex/agents/`, `.claude/agents/`) before
  reporting the work complete: it brings the tests that own the changed or new code in line with the change
  under `vesper-testing`'s rules and reports the CI evidence. It edits tests only.
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
- GitHub Actions CI on GitHub-hosted runners is the gate. Draft PRs run no gates; ready PRs run applicable
  jobs. The aggregate `verify` check is required on `main` and `prod`.
- Do not add a CI workflow without an explicit owner decision.
- Report only what the exact workflow/run selected at the tested head SHA. A green aggregate does not prove
  an unscheduled suite ran; the full `app-int` surface is not currently selected by ordinary CI.
- UI testing runs only against `https://vesper.fly.dev`; `verify` owns QA-account selection and sign-in.
  Never substitute local Postgres plus `pnpm dev` for UI evidence.
- Put screenshots, rendered evaluations, and all other evaluation/task output in gitignored root
  `eval-images/`, never in `docs/`. Prefer an existing conversation when it fits the scenario.
- Retain characters, conversations, and other entities created during live QA, including their generated
  images and supporting records, so owners can review them. Include names and review URLs or IDs in the
  handoff. Do not delete test-created state as cleanup; deletion requires an explicit owner request.

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
