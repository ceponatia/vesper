# Brief: #<issue> — <one-line outcome>

You are implementing one slice of Vesper in the assigned checkout below. Read this
whole brief before touching anything. Apply the user's explicit instructions
and existing authorization; this brief supplies scope and repository policy.

## Where you work

- Checkout: `<absolute path>`; mode: `<isolated worktree | shared checkout>`.
  Every command and edit stays there. In an isolated worktree, branch
  `<assigned branch>` is already checked out. In a shared checkout, do not change
  branches, stage, commit, or clean files unless the parent explicitly assigns
  that operation; unrelated edits from other agents are expected and preserved.
- Read first: the root `CLAUDE.md` and `docs/README.md`, then issue #<N>
  (and its parent #<P>), then `<reference page(s) under docs/>`, then the
  code paths named below. The issue is the spec; if the spec and the code
  disagree, the code is what exists — say so in your report instead of
  guessing which one is right.

## Outcome

<Two to four sentences: what a player or operator can do afterwards that
they cannot do now, and the observable consequence. Copy the issue's
Outcome line if it has one.>

## Scope

In:
- <concrete deliverable 1, with the file or module it lives in>
- <concrete deliverable 2>

Out (do not build, even if it seems adjacent):
- <thing another agent owns>
- <thing deferred by an owner ruling — cite the dated ruling>

## Files you own

You may create or edit only these paths. Another agent owns the rest of the
tree in parallel; touching a file outside this list creates a merge conflict
nobody asked for.

- `apps/web/src/…`
- `docs/…`
- `drizzle/…` (only if a migration is in scope — see below)

## Decisions already made

<Dated owner rulings that bind this slice, verbatim or cited. Reuse them.
Resolve routine implementation choices from the code and requirements. For
an unresolved material product, architecture, cost, or irreversible choice,
hold only the dependent work and ask the parent; continue independent work.>

## Rules and allowed operations

- Do NOT run local application lint, typecheck, tests, or builds
  (`pnpm lint*`, `pnpm test*`, `pnpm typecheck`, `pnpm verify`,
  `scripts/verify.sh`) — and not `vitest` in any form, not even one file
  under one project. CI on CodeBuild validates when the PR is readied within
  the task's authorization. Diagnose by reading code and CI logs. Migration
  generation below is an explicit non-gate exception when a migration is in
  scope. Dependency-free offline tests of skill helpers are allowed when those
  helpers are the task;
  they must not invoke application gates, services, or external mutations.
- Do NOT push, open a PR, edit the board, or comment on GitHub. In an isolated
  worktree, commit owned paths only by pathspec (`git commit -m "…" -- <paths>`),
  with conventional messages (`feat(images): …`, `fix(chat): …`). In a shared
  checkout, leave commits to the parent unless the brief explicitly assigns one.
- Do NOT run a formatter over `docs/` or over files you did not change.
- Do NOT add a test because code exists. Read `.claude/skills/vesper-testing/SKILL.md`:
  one owning layer per invariant, and "no new test" is a valid outcome you
  state with a reason.
- Do NOT write status, progress, slice numbers, or "remaining work" into
  anything under `docs/` — durable docs are present-tense law
  (`.claude/skills/vesper-docs/SKILL.md`). Work state lives on the issue.
- Migrations: edit `apps/web/src/server/db/schema.ts`, run `pnpm db:generate`,
  review the SQL. If Drizzle asks a create-vs-rename question, STOP and
  report — never answer it with a fake TTY or piped input.
- Resilience: `parseOr` at trust boundaries, diagnostics over exceptions,
  degraded defaults over failed turns (`docs/resilience.md`). Before
  reporting, `git diff <base>...HEAD | grep '^+.*throw new Error'` and
  justify every hit on a schema-legal path.
- If you cannot finish, finish everything that does not depend on the
  blocker and say precisely what you left out and why.

## Self-check before you report

- In an isolated worktree, `git status --short` is clean and owned work is
  committed. In a shared checkout, inspect `git status --short` without cleaning,
  staging, or reverting anything; unrelated dirty paths may belong to others.
- A path-limited diff against the assigned baseline shows only your intended
  changes under the ownership list. Report any pre-existing edits in an owned
  path instead of overwriting or claiming them.
- No unexpected control characters in your owned diff. Use the assigned baseline
  and pathspec, including uncommitted files when the parent owns commits.
- Every new or changed doc line follows `vesper-docs`, including its three
  permitted kinds of dated line; do not redefine that law in the report.

## Report format

Reply with exactly these sections:

1. **Commits** — SHA and subject in order, or `None — parent owns commits` for
   a shared checkout.
2. **What changed** — per file, one line each.
3. **Decisions I made** — anything not settled by this brief, with the
   reasoning and the alternative I rejected.
4. **Open questions** — forks I did not resolve, phrased so the owner can
   answer with one word each.
5. **Tests** — what protects the new behavior; new tests named with the
   defect each kills, or "none, because <existing gate>".
6. **Not done** — anything in scope that is not in the diff, and why.
