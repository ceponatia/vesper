---
name: vesper-agent-build
description: Build Vesper issues with subagents the way the owner has ruled it works — design forks asked first, tight briefs that carry the no-gates rule verbatim, one worktree per agent made from the issue, every diff scanned and reviewed as it lands with corrections sent back to the same agent, an ordered merge into one integration branch, and one draft PR (only when asked) that closes each issue with its own keyword. Use this whenever you are about to spawn agents to implement an issue or a set of sub-issues, are asked to "use agents to build this issue", "build these in parallel", "build the issue and its sub-issues", or need a worktree for an agent — a single agent included. vesper-board owns the branch→PR→board mechanics and vesper-pr-review owns what happens after the PR exists; this skill owns the build itself.
---

# Building with agents

Ten multi-agent builds landed in the two weeks before this skill existed, and
each re-derived the same sequence and re-learned at least one of the same
mistakes. The sequence below is that record. The scripts live in this
directory; call them by path from the main checkout.

| Script | Does |
|---|---|
| `worktree-up.sh <issue> <slug> [--slice]` | branch from the issue (`gh issue develop`, linked = closing) + worktree + offline node_modules |
| `scan-diff.sh [dir]` | the mechanical review: NUL bytes, binary-looking files, throws, doc churn, tables, authz touch, census files |
| `worktree-down.sh <issue>` | remove the worktree, keep the branch |
| `templates/agent-brief.md` | the brief skeleton — the rules block goes in verbatim |
| `templates/pr-body.md` | the PR body — one `Closes` per issue, owner decisions, what is owed |

## 0. Forks first, then spec, then spawn

Before any agent exists, find every design fork the issue leaves open and
ask the owner with **AskUserQuestion**: plain English, one option marked
"(Recommended)" first, at most four per call, jargon translated into
consequences. "Agents building whatever they feel like" produced the fake
production-task mess the image-adapter refactor exists to fix, so a brief
must settle its forks or explicitly tell the agent to stop at them.

Record each ruling as a dated `Owner ruling (YYYY-MM-DD): …` comment on the
owning issue (vesper-docs owns the mechanics) — the brief cites it, the
agent does not relitigate it.

## 1. Check the spec against the code

Issues and reference pages age. Before briefing, open the code paths the
issue names and confirm they still exist and still do what the issue
assumes. On #219 the spec's `PORTRAIT_IDENTITY_LOCK` and `apparentAgeAnchor`
had been retired weeks earlier; catching that before the brief saved a
rebuild. Put what you found in the brief's "Decisions already made".

## 2. Worktrees: one per agent, made from the issue

```bash
.claude/skills/vesper-agent-build/worktree-up.sh 284 gallery-cascade          # whole sub-issue
.claude/skills/vesper-agent-build/worktree-up.sh 256 dialect-2511 --slice     # part of a larger issue
```

- **Whole issue → linked branch.** `gh issue develop` registers the branch
  on the issue, and that Development connection is a *closing* link whatever
  the PR body says. Only link a branch whose PR really finishes the issue;
  a slice gets `--slice` (plain branch) and a `Part of #N` PR.
- **Parallel agents get disjoint files.** Phase the work so no two agents
  own the same package or module; the brief's "Files you own" list is the
  contract. Where they must touch one shared line (a `PASSES` list, a docs
  index), expect and hand-resolve that one conflict at merge.
- **Dependency-ordered slices run sequentially in one worktree** (build →
  review → fix → next), not in parallel worktrees; #219's three slices went
  that way because slice 2 needed slice 1's migration.
- The offline install links node_modules from the pnpm store in about a
  second. Without it, agents see phantom "Cannot find package '@vesper/…'"
  diagnostics and start "fixing" them. A worktree cannot run `pnpm db:up`
  (compose container-name collision) — `docker start vesper-postgres` if a
  DB is ever genuinely needed, which under the no-gates rule it is not.

## 3. Briefs

Start from `templates/agent-brief.md`. What matters in it:

- **The rules block, verbatim.** No lint/typecheck/tests/pnpm scripts, no
  push, no PR, no board edits, no formatter over `docs/`, commit by
  pathspec. It is in every brief because an agent that runs a gate burns the
  minutes CI would have spent anyway and can take the desktop down with it.
- **Files you own** — the disjointness contract from step 2.
- **Decisions already made** — the dated rulings, so the agent builds the
  decided option instead of the interesting one.
- **Report format** — commits, per-file changes, decisions made, open
  questions, tests-with-the-defect-they-kill, not-done. A report in this
  shape is reviewable in minutes; free-form prose is not.

**Model:** pass `model` explicitly on every Agent call. Opus for
kernel/store/integration work, cross-cutting seams, and correction rounds;
Sonnet for mechanical stages (contracts, schema ripple, docs, test
authoring). Four all-Sonnet engine slices put every confirmed defect in the
integration stage — that is the ruling's origin. `.claude/settings.local.json`
pins `CLAUDE_CODE_SUBAGENT_MODEL`, which overrides the per-call parameter; if
every spawn fails with a model-access error, that id is the first suspect.

Spawn parallel agents in **one message** so they run concurrently, with
`run_in_background: true`; you review as each returns.

## 4. Review each diff as it lands

Do this per agent, before the next one starts or before merging — not once
at the end. First the machine:

```bash
.claude/skills/vesper-agent-build/scan-diff.sh .claude/worktrees/agent-284
```

Then your eyes, on the things the scanner cannot judge:

- Does the diff match the brief's scope and ownership list? Extra files are
  a merge conflict in waiting; missing scope is a "Not done" the report must
  own.
- Every `throw new Error` the scan flagged: is the input schema-legal? Then
  it degrades with a diagnostic instead (`docs/resilience.md`).
- Tests: does each new test name the defect it kills? Does an existing
  layer already own that invariant? (vesper-testing)
- Docs: present-tense law only; no status, no slice numbers, no dates
  except dated rulings; tables aligned; the new page indexed
  (vesper-docs).
- Migrations: the SQL says what the schema diff says, and nothing was
  answered on Drizzle's behalf.
- Client-visible fields: the client has its **own** zod schema in
  `lib/client/api.ts`, and zod strips unknown keys — a field added
  server-side is silently dropped until that schema learns it. This cost a
  whole slice's visible behavior once.
- Read the report's "Decisions I made" as a list of things the owner may
  reverse; they go on the PR.

## 5. Corrections go back to the same agent

Send fixes to the agent that built the slice with **SendMessage** — it has
the context; a fresh agent re-derives it. If the agent is gone, spawn a new
one at the branch tip (`worktree-up.sh` re-creates a worktree for an
existing branch) with the original brief plus the correction. Never file
corrections as new issues; the owner asked for the loop to stay inside the
build (2026-09-02).

## 6. Merge in dependency order into one integration branch

The integration branch is the **parent** issue's linked branch
(`worktree-up.sh <parent> <slug>` from the main checkout, or `gh issue
develop <parent> --checkout`). Merge slice branches into it in dependency
order — data/migration first, then the code that consumes it, then UI and
docs — resolving the expected shared-line conflicts by union. Run
`scan-diff.sh` once more on the merged result; merges have re-introduced
things the slices had fixed.

## 7. Deliver

**Default: branch pushed, report in chat, no PR** — the owner reviews first
(ruling 2026-08-24). When the owner has said "open a draft PR when ready",
that overrides the default for that task:

```bash
gh pr create --repo ceponatia/vesper --draft --base main --title "…" --body-file body.md
.claude/skills/vesper-board/link-pr.sh <pr> <parent-issue>
.claude/skills/vesper-board/board-set.sh <pr> --pr Status "Awaiting Acceptance" --assign
.claude/skills/vesper-board/board-set.sh <issue> Status "Awaiting Acceptance" --assign   # each closed issue
```

The body comes from `templates/pr-body.md`: one `Closes #N.` line per
issue (a comma list links only the first), the owner decisions from every
report, what is still owed, and "nothing run locally". Drafts run no CI;
the owner flips ready. From here vesper-pr-review owns the loop.

## 8. Close out

`worktree-down.sh <issue>` for each merged slice (branches stay). Then write
the memory note a future session needs: which seams are easy to re-break,
which decisions are on the PR, what is owner work. Not the narrative.

## Gotchas this skill exists for

- A NUL byte in a template string made git call a `.ts` file binary; the
  diff looked empty. `scan-diff.sh` catches control characters — read agent
  output with that in mind.
- `Closes #A, #B, #C` in a PR body closes only #A.
- Stale-worktree LSP artifacts (missing node_modules, pre-merge copies)
  produce diagnostics that are not real — verify against the branch
  worktree before believing one.
- `pnpm install` in a worktree wants `--store-dir` (the shell's HOME is
  snap-confined; the store is under the real home). `worktree-up.sh` reads
  the store path from the main checkout.
- Two sessions given the same task both implemented it in full; only a
  rejected push stopped one clobbering the other. Before pushing a branch
  this session did not create, fetch and compare.
- Tool calls issued in one message may run concurrently. An Edit of a file
  and a `git diff`/`git add` of that file in the same message race — a diff
  issued beside an Edit reported this skill's `board-set.sh` as wholly
  changed and nearly triggered a needless "fix" commit. Edit in one message;
  inspect or commit in the next.
- Sub-issues that enter an iteration pull their parent in too
  (`file-issue.sh --parent … --iteration …` does both).
