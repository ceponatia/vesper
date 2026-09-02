---
name: vesper-board
description: Operate the Vesper Development board — starting work from an issue, branch and PR linkage, status moves, the assignment convention, labels, iterations, and milestones. Use before creating a branch or opening a pull request, when moving an issue through its lifecycle (triage → ready → in progress → awaiting acceptance → done), when assigning or labeling issues, at iteration boundaries, or whenever deciding who an item is waiting on. vesper-docs owns filing, issue structure, and where information lives; this skill owns the mechanics after filing.
---

# Vesper board operations

Board: **Vesper Development** — project `7`, owner `ceponatia`, id
`PVT_kwHOARzdw84BhlWR`. The project README on GitHub is the law for fields,
labels, views, cadence, and milestones; read it before classifying anything.
This skill adds the verified mechanics and the assignment convention.

## Working an issue end to end

Work starts at the issue, not at the branch. The order below is what makes the
PR link itself and carry the issue's classification.

**1. Take the issue.** Move it to **In Progress**; set Iteration if it is
missing. If the work has no issue, file one first (vesper-docs owns filing) —
a PR with no issue has nothing to inherit and has to be classified by hand.

**2. Branch from the issue.** Never open with a bare `git checkout -b`:

```bash
gh issue develop 254 --repo ceponatia/vesper --base main \
  --name agent/254-short-slug --checkout
```

This registers a **linked branch** on the issue. A PR opened from that branch is
connected to the issue with no keyword needed — and that connection is a
**closing** link. Verified on #382: the Development connection alone put #254 in
the PR's `closingIssuesReferences`, with no closing keyword anywhere in the body.

So `gh issue develop` is for a PR that delivers the **whole** issue. If the PR
delivers only a slice, branch the ordinary way (`git switch -c agent/254-…`) and
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
.claude/skills/vesper-board/link-pr.sh <pr-number> <issue-number>
```

It adds the PR if absent and copies **Horizon, Priority, Area, Effort, and
Iteration** from the issue's item. It is idempotent — run it again whenever the
issue is reclassified.

Do not assume linkage does this for you. GitHub documents no field inheritance
from a linked issue, and this project's built-in `Pull request linked to issue`
workflow is **disabled**. Mirroring explicitly costs one command and is correct
either way.

**5. Status on the PR item tracks the PR, not the issue.** The
`Item added to project` workflow drops every new item in **Triage**, which is
wrong for a PR and pollutes the weekly triage sweep — set it immediately:

| PR state | PR Status | Issue Status |
|---|---|---|
| draft, iterating | In Progress | In Progress |
| ready for review | Awaiting Acceptance, **assign the owner** | Awaiting Acceptance, **assign the owner** |
| merged | Done (automatic — the `Item closed` workflow) | Done, if the body said `Closes` |

**A PR with no issue** (rare — it should have been filed first) is classified by
hand: `link-pr.sh` cannot help, so set Horizon, Priority, Area, and Effort with
`item-edit` using the table below.

## The assignment convention

**Assigned to `ceponatia` ⇔ the next action is the owner's.** Anything
assigned is, with certainty, ready for the owner to look at. Everything else
stays unassigned.

Assign the owner when — and only when:

- an issue's Status becomes **Awaiting Acceptance** (built, waiting on deploy
  verification, a paid run, grading, or merge);
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
gh issue edit <n> --repo ceponatia/vesper --add-assignee ceponatia   # or --remove-assignee
gh pr edit <n> --repo ceponatia/vesper --add-assignee ceponatia
```

## Status moves

Set fields with `gh project item-edit`; the item id comes from `item-list`.

```bash
# issue or PR number -> board item id
gh project item-list 7 --owner ceponatia --format json --limit 400 \
  | jq -r '.items[] | select(.content.number==<N>) | .id'

gh project item-edit --project-id PVT_kwHOARzdw84BhlWR --id <item-id> \
  --field-id <field-id> --single-select-option-id <option-id>
```

| Field | Field id | Options |
|---|---|---|
| Status | `PVTSSF_lAHOARzdw84BhlWRzhggj3Q` | Triage `5b6fb9b8` · Discovery `0eaf0465` · Ready `b6fb051b` · In Progress `0f689ecb` · Blocked `c20013a8` · Awaiting Acceptance `63f6e9f9` · Done `b13ac8c1` |
| Horizon | `PVTSSF_lAHOARzdw84BhlWRzhggj_A` | Now `2bc28b41` · Next `41a95d24` · Later `1a7c707f` · Parked `f6158f29` |
| Priority | `PVTSSF_lAHOARzdw84BhlWRzhggj_E` | P0 `9eaa63ff` · P1 `c3ece54c` · P2 `77b35843` · P3 `9fb1df0f` |
| Area | `PVTSSF_lAHOARzdw84BhlWRzhggj_I` | Narration `868ffad7` · Character Chat `34c75eb9` · Simulation `de99b836` · Images `e9d8c922` · Authoring `016c54de` · Data `d6c7a6e4` · Infrastructure `f9d335c6` · UX `b1ec8cc2` |
| Effort | `PVTSSF_lAHOARzdw84BhlWRzhggj_M` | XS `530d50c6` · S `148876a2` · M `862984dd` · L `b59b5419` · XL `a4cf9de0` |
| Iteration | `PVTIF_lAHOARzdw84BhlWRzhgwAB8` | iteration ids from `gh project field-list 7 --owner ceponatia --format json` (`--iteration-id`, not `--single-select-option-id`) |

Transition rules that pair with fields:

- **Built ≠ done.** When implementation lands on a branch/PR, move the issue to
  **Awaiting Acceptance** and assign the owner; the issue (or PR) must name the
  concrete acceptance action. Done happens by merging a PR whose body says
  `Closes #N` — the board workflow moves closed issues to Done automatically.
- A PR that delivers only part of an issue says `Part of #N`, never `Closes` —
  auto-close would erase the remaining owed scope.
- **Blocked must name its blocker**: a native blocked-by relation on the exact
  child, or the `decision-needed` label. Never prose, never row order.
- Parents (label `initiative`) aggregate; per-slice truth lives on sub-issues.
  Iterations hold execution items only, never parents.

## Labels

Exactly the labels that apply, from the board's set — these and no invented ones:

`bug` · `technical-debt` · `performance` · `security` · `documentation` ·
`research` (investigation that usually dies with its issue) · `evaluation`
(graded trial or benchmark) · `initiative` (roadmap-level outcome; drives the
Portfolio Roadmap view) · `decision-needed` (blocked on an owner ruling —
assign the owner) · `agent-found` (filed by an agent in passing).

The stock GitHub extras (`duplicate`, `wontfix`, `question`, `good first
issue`, `help wanted`, `invalid`, `enhancement`) are not part of the taxonomy;
don't add them to new work.

## Iterations and milestones

- Iterations are two-week cycles (Iteration 1 closed early on 2026-09-01;
  Iteration 2 = 2026-09-02 → 2026-09-15, then every 14 days). At a boundary: accept or carry over the closing iteration's
  items, then pull the next execution issues in. Set via `item-edit` with
  `--iteration-id`.
- Milestones per the README: **sparingly** — only when several issues
  collectively form a recognizable release or acceptance target; the project
  handles ordinary grouping. None exist today. `gh api
  repos/ceponatia/vesper/milestones -F title=... -X POST` creates one;
  `gh issue edit <n> --milestone <title>` attaches.

## Gotchas (verified the hard way)

- A Development-section connection is a **closing** reference — `gh issue
  develop` branches and hand-linked PRs both carry it, whatever the body says.
  Only connect a PR that really finishes its issue.
- Board items are **not** deduplicated across an issue and its PR: they are two
  rows, each with its own fields, and neither updates the other.
- Project-board **UI saves silently no-op when the browser tab is hidden** —
  activate the tab first, and distrust optimistic success toasts. Prefer `gh`
  for anything scriptable.
- The GraphQL API cannot edit single-select options, views, workflows, or
  create iteration fields — those are UI-only.
- `updateProjectV2Field` with `iterationConfiguration` CAN change iteration
  dates, but it **recreates every iteration with a new id and clears the
  Iteration value on every item**. Snapshot `item-list` (number → iterationId)
  first, run the mutation, then re-`item-edit --iteration-id` each item onto
  the new ids (verified 2026-09-02: 47 items cleared, all restored).
- New issues auto-add to the board within minutes; `gh project item-add` only
  when fields must be set immediately. PRs are **not** auto-added — step 4 is
  what puts them there.
- Sub-issue and blocked-by REST endpoints want the issue's **database id**
  (`gh api repos/ceponatia/vesper/issues/<n> --jq .id`), not its number —
  exact commands live in the vesper-docs skill.
