---
name: vesper-board
description: Operate the Vesper Development board — status moves, the assignment convention, labels, iterations, milestones, and PR linkage. Use when moving an issue through its lifecycle (triage → ready → in progress → awaiting acceptance → done), when finishing built work or opening PRs for board items, when assigning or labeling issues, at iteration boundaries, or whenever deciding who an item is waiting on. vesper-docs owns filing, issue structure, and where information lives; this skill owns the mechanics after filing.
---

# Vesper board operations

Board: **Vesper Development** — project `7`, owner `ceponatia`, id
`PVT_kwHOARzdw84BhlWR`. The project README on GitHub is the law for fields,
labels, views, cadence, and milestones; read it before classifying anything.
This skill adds the verified mechanics and the assignment convention.

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
# issue number -> board item id
gh project item-list 7 --owner ceponatia --format json --limit 200 \
  | jq -r '.items[] | select(.content.number==<N>) | .id'

gh project item-edit --project-id PVT_kwHOARzdw84BhlWR --id <item-id> \
  --field-id <field-id> --single-select-option-id <option-id>
```

| Field | Field id | Options |
|---|---|---|
| Status | `PVTSSF_lAHOARzdw84BhlWRzhggj3Q` | Triage `5b6fb9b8` · Discovery `0eaf0465` · Ready `b6fb051b` · In Progress `0f689ecb` · Blocked `c20013a8` · Awaiting Acceptance `63f6e9f9` · Done `b13ac8c1` |
| Horizon | `PVTSSF_lAHOARzdw84BhlWRzhggj_A` | Now `2bc28b41` · Next `41a95d24` · Later `1a7c707f` · Parked `f6158f29` |
| Priority | `PVTSSF_lAHOARzdw84BhlWRzhggj_E` | P0 `9eaa63ff` · P1 `c3ece54c` · P2 `77b35843` · P3 `9fb1df0f` |
| Iteration | `PVTIF_lAHOARzdw84BhlWRzhgwAB8` | iteration ids from `gh project field-list 7 --owner ceponatia --format json` |

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

- Iterations are two-week Mon–Sun cycles (Iteration 1 = 2026-08-31 →
  2026-09-13). At a boundary: accept or carry over the closing iteration's
  items, then pull the next execution issues in. Set via `item-edit` with
  `--iteration-id`.
- Milestones per the README: **sparingly** — only when several issues
  collectively form a recognizable release or acceptance target; the project
  handles ordinary grouping. None exist today. `gh api
  repos/ceponatia/vesper/milestones -F title=... -X POST` creates one;
  `gh issue edit <n> --milestone <title>` attaches.

## Gotchas (verified the hard way)

- Project-board **UI saves silently no-op when the browser tab is hidden** —
  activate the tab first, and distrust optimistic success toasts. Prefer `gh`
  for anything scriptable.
- The GraphQL API cannot edit single-select options, views, workflows, or
  create iteration fields — those are UI-only.
- New issues auto-add to the board within minutes; `gh project item-add` only
  when fields must be set immediately.
- Sub-issue and blocked-by REST endpoints want the issue's **database id**
  (`gh api repos/ceponatia/vesper/issues/<n> --jq .id`), not its number —
  exact commands live in the vesper-docs skill.
