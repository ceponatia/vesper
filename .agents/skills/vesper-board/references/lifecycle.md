# Issue and PR lifecycle

Work starts at the issue, not at the branch. The order below is what makes the
PR link itself and carry the issue's classification.

**1. Take the issue.** Move it to **In Progress**; set Iteration if it is
missing:

```bash
.agents/skills/vesper-board/board-set.sh 254 Status "In Progress" Iteration @current
```

If the work has no issue, file one first (vesper-docs owns what goes in it;
`file-issue.sh` below does the mechanics) — a PR with no issue has nothing to
inherit and has to be classified by hand.

**2. Branch from the issue.** Never open with a bare `git checkout -b`:

```bash
gh issue develop 254 --repo ceponatia/vesper --base main \
  --name codex/254-short-slug --checkout
```

This registers a **linked branch** on the issue. A PR opened from that branch is
connected to the issue with no keyword needed — and that connection is a
**closing** link. Verified on #382: the Development connection alone put #254 in
the PR's `closingIssuesReferences`, with no closing keyword anywhere in the body.

So `gh issue develop` is for a PR that delivers the **whole** issue. If the PR
delivers only a slice, branch the ordinary way (`git switch -c codex/254-…`) and
link nothing — an auto-close would erase the remaining owed scope.

**3. Open the PR draft.** Draft PRs run no CI and CodeBuild bills per job-minute,
so stay draft while iterating.

```bash
gh pr create --repo ceponatia/vesper --draft --base main \
  --title "…" --body-file <body.md>
```

The body says `Closes #254` for a whole issue, `Part of #254` for a slice, and
names what is still owed. A branch made by `gh issue develop` already connects
the PR; the keyword is what carries the intent for a hand-made branch.

**4. Put the PR on the board and mirror the issue's classification.**

```bash
.agents/skills/vesper-board/link-pr.sh <pr-number> <issue-number>
```

It adds the PR if absent and copies **Horizon, Priority, Area, Effort, and
Iteration** from the issue's item, clearing mirrored PR fields that are unset on
the issue. It reads the saved PR item back to verify both copies and clears.
Run it again whenever the issue is reclassified.

Do not assume linkage does this for you. GitHub documents no field inheritance
from a linked issue, and this project's built-in `Pull request linked to issue`
workflow is **disabled**. Mirroring explicitly costs one command and is correct
either way.

**5. Status on the PR item tracks the PR, not the issue.** Set the PR status from its actual lifecycle; do not rely on the board
automation's current default:

| PR state | PR Status | Issue Status |
|---|---|---|
| draft, iterating | In Progress | In Progress |
| ready for owner review | Awaiting Acceptance, assign the owner | Awaiting Acceptance, assign the owner |
| merged | Done (automatic — verify the saved result) | Done, if the body said `Closes` |

**A PR with no issue** (rare — it should have been filed first) is classified by
hand: `link-pr.sh` cannot help, so set the fields directly:
`board-set.sh <pr> --pr Horizon Next Priority P2 Area Images Effort S`.

## The assignment convention

**Assigned to `ceponatia` ⇔ the next action is the owner's.** Anything
assigned is, with certainty, ready for the owner to look at. Everything else
stays unassigned.

Assign the owner when — and only when — the next action requires the owner:

- an issue's Status becomes **Awaiting Acceptance** (built, waiting on owner
  verification, approval for a paid run, grading, or merge);
- built work is **ready for review** — the branch/PR exists and the next step
  is the owner reviewing, flipping a draft ready, or merging. Assign the PR
  itself too;
- a **`decision-needed`** item's only unblock is an owner ruling.

Leave unassigned: Triage, Discovery, Ready, In Progress, and items Blocked on
a dependency rather than a ruling. "To be implemented" work is never assigned.

When the owner acts — accepts, rules, merges — the assignment resolves itself:
the issue closes, or (if the ruling sends it back to implementation) **remove
the assignee** so the pool stays honest.

```bash
.agents/skills/vesper-board/board-set.sh <issue> Status "Awaiting Acceptance" --assign
.agents/skills/vesper-board/board-set.sh <pr> --pr Status "Awaiting Acceptance" --assign
.agents/skills/vesper-board/board-set.sh <issue> --unassign        # ruling sent it back to the pool
```

(`gh issue edit <n> --add-assignee ceponatia` / `gh pr edit …` is what those
run underneath.)


## Authorization and acceptance

Existing task authorization controls who opens, readies, or merges a PR. If the
user authorized the action, carry it through without asking again; assign the
owner only when the next action really is theirs. Keep drafts while iterating,
and hand off the review/CI loop to `vesper-pr-review`. A skill does not itself
authorize external messages or closing unfinished scope.

Dependencies are native blocked-by links on the affected issue. If work is
blocked by an owner choice, use a `decision-needed` issue. Do not use row order
or narrative notes as dependency records. `vesper-docs` owns issue contents.

When a sub-issue enters an iteration, place its parent in that iteration too
so the current-iteration view can nest it. Resolve the current iteration from
the live configuration instead of copying a date or ID from old instructions.
