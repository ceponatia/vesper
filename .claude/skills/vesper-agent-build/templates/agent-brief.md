# Brief: #<issue> — <one-line outcome>

You are implementing one slice of Vesper in the worktree below. Read this
whole brief before touching anything; the rules section is not negotiable
and the report format is how your work gets reviewed.

## Where you work

- Worktree: `<abs path to .claude/worktrees/agent-N>` — every command runs
  there, every edit lands there. Branch `agent/<N>-<slug>` is already checked
  out.
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

<Dated owner rulings that bind this slice, verbatim or cited. Agents
inventing architecture is how past messes happened; if you hit a fork that
is not settled here, stop, put it in the report's Open questions, and build
the smaller option or nothing.>

## Rules (verbatim — these came from the owner)

- Do NOT run lint, typecheck, tests, builds, or any `pnpm` script
  (`pnpm lint*`, `pnpm test*`, `pnpm typecheck`, `pnpm verify`,
  `scripts/verify.sh`). CI on CodeBuild validates when the owner readies the
  PR; local gate runs are wasted minutes on a memory-fragile machine and are
  denied by project settings. Diagnose by reading code.
- Do NOT push, open a PR, edit the board, or comment on GitHub. Commit on
  your branch only, by pathspec (`git commit -m "…" -- <paths>`), with
  conventional messages (`feat(images): …`, `fix(chat): …`).
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

- `git status --short` in the worktree is clean (everything committed).
- `git diff <base>...HEAD --stat` shows only files from your ownership list.
- No control characters in your diff (`git diff --text <base>...HEAD | grep -P '[\x00-\x08\x0B\x0C\x0E-\x1F]'` is empty).
- Every new or changed doc line is present-tense law with no dates except
  dated owner rulings.

## Report format

Reply with exactly these sections:

1. **Commits** — SHA and subject, in order.
2. **What changed** — per file, one line each.
3. **Decisions I made** — anything not settled by this brief, with the
   reasoning and the alternative I rejected.
4. **Open questions** — forks I did not resolve, phrased so the owner can
   answer with one word each.
5. **Tests** — what protects the new behavior; new tests named with the
   defect each kills, or "none, because <existing gate>".
6. **Not done** — anything in scope that is not in the diff, and why.
