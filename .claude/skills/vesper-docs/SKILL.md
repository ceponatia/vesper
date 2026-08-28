---
name: vesper-docs
description: Where information lives in Vesper — GitHub Issues and the project board own all work state (plan documents are retired), repo docs state durable technical law, ADRs record contested decisions. Use when writing or editing any Markdown under docs/, when about to record a plan, status, or progress anywhere, when filing or structuring issues and sub-issues, or when deciding whether something belongs in an issue, a reference page, or an ADR.
---

# Where information lives

**GitHub owns work state; the repository owns technical truth; git owns
history.**

```text
GitHub Project   what matters now — Status, Horizon, Priority, Area, Effort
GitHub Issues    what we intend, what blocks it, decisions needed, experiments, acceptance
Repo docs        what the system currently guarantees
Git history      how we got here
```

The test for every artifact: **an agent picking up an issue must be able to act
from that issue, at most one parent issue, one 100–200-line reference page, and
the code.** If a task requires reading six historical documents first, the
information is in the wrong place — move it, don't add a seventh.

The board is **Vesper Development** — project `7`, owner `ceponatia`, id
`PVT_kwHOARzdw84BhlWR`. The board's own README on GitHub holds the field and
label conventions; the commands below are the verified essentials.

## The routing table

One home per kind of information. Never write the same fact into two homes —
status in an issue body, a slice list in a doc, or a dependency in prose
re-creates exactly the drift this system deleted.

| Information               | Home                                      |
| ------------------------- | ----------------------------------------- |
| Outcome, product intent   | parent issue                              |
| Current status            | project field, set at triage              |
| Implementation sequence   | sub-issues, in order                      |
| Individual work items     | issues and sub-issues                     |
| Dependencies              | native blocked-by relations               |
| Design reasoning          | issue comments; a `research` issue        |
| Owner rulings             | issue comment; ADR only if it becomes law |
| Open questions that block | a `decision-needed` issue                 |
| Acceptance criteria       | the issue that closes on them             |
| Technical laws            | a reference page under `docs/`            |
| History, research residue | closed issues, merged PRs, git            |

## Work state: issues, sub-issues, the board

**Plan documents are retired.** Never create a `*.plan.md`, a roadmap file, or
any document whose job is to say what happens next. A plan-sized effort is a
**parent issue**; anything smaller is an issue or a sub-issue.

A parent issue is the agent's map — 30–50 lines, this shape (the "Feature or
plan" issue form produces it):

```markdown
**Outcome:** A player can <do something concrete> so that <observable consequence>.

## Current state        — built vs accepted, honestly distinguished
## Scope                — what this covers; delivery order as sub-issues
## Acceptance           — the trial, review, or enable that makes it Done
## Constraints & rulings — dated: `Owner ruling (2026-08-26): …`
## References           — the reference pages this work implements
```

- **Sub-issues are the implementation stages, created together with their
  parent whenever possible** (owner ruling 2026-08-28). Defer a stage only when
  there is not yet enough information to start even a draft sub-issue — and
  create it the moment there is. Finishing a stage closes its sub-issue;
  nothing else needs updating, because nothing else records it.
- **A discovered prerequisite is a new sub-issue plus a blocked-by relation** on
  the work it gates — never a prose note. Dependencies are structural: there is
  deliberately no "Blocked" status; blocked work is visible through its
  relations.
- **A blocking open question is a `decision-needed` issue**: the plausible
  choices, their consequences, links to the code. Close it when the owner
  rules; record the ruling as a dated comment. If the ruling changes durable
  law, update those lines in the reference page in the same change.
- **Research lives in a `research` issue and usually dies with it.** Once
  decided: rationale worth keeping → ADR (rarely), resulting behavior →
  reference page, resulting work → issues, everything else → closed-issue
  history. Measured trials and benchmarks are the exception — reproducibility
  can justify a durable, **text-only** record under `docs/`. The renders and
  screenshots behind a verdict never enter git; root `CLAUDE.md` owns where
  they go.
- **Fields are set on the board at triage** (Status, Horizon, Priority, Area,
  Effort) — never restated in bodies or docs. New issues auto-add to the board
  as Inbox within a few minutes; Inbox means untriaged, not forgotten.
- **Built is not accepted.** Awaiting Acceptance is a Status, and the issue
  names what it waits on. Closing an issue asserts delivered *and* accepted.
- Filing something you noticed in passing: add the `agent-found` label.
- **GitHub Discussions are not used** (owner ruling 2026-08-26): part of the
  agent fleet cannot read them, so a decision parked there is a silo. Decisions
  and research conversations are issues.

### Commands (verified against this repo, gh ≥ 2.89)

```bash
# File work. Labels: bug, technical-debt, performance, security, documentation,
# research, evaluation, decision-needed, agent-found.
gh issue create --repo ceponatia/vesper --title "..." --body-file body.md --label research

# Auto-add reaches the board within minutes; to set fields immediately, add it
# yourself. Field and option ids come from field-list.
gh project item-add 7 --owner ceponatia --url <issue-url> --format json --jq .id
gh project field-list 7 --owner ceponatia --format json
gh project item-edit --project-id PVT_kwHOARzdw84BhlWR --id <item-id> \
  --field-id <field-id> --single-select-option-id <option-id>

# Make B a sub-issue of A — REST wants database ids, not issue numbers.
CHILD=$(gh api repos/ceponatia/vesper/issues/<B> --jq .id)
gh api -X POST repos/ceponatia/vesper/issues/<A>/sub_issues -F sub_issue_id=$CHILD

# Mark N blocked by M.
BLOCKER=$(gh api repos/ceponatia/vesper/issues/<M> --jq .id)
gh api -X POST repos/ceponatia/vesper/issues/<N>/dependencies/blocked_by -F issue_id=$BLOCKER
```

Close an issue by landing its PR with `Closes #N` in the body — the board's
automation moves it to Done and archives it after two quiet weeks.

## Durable docs: reference pages

A reference page states **what the system currently guarantees** — boring,
present-tense law an agent can check code against. It tells no story of how the
feature was built, lists no alternatives, and records no progress. Template:
`templates/reference-doc.md`.

`docs/README.md` is the index and owns the tree itself: the reading-order table
that every top-level area appears in, the one-doc-per-system rule, and the
~400-line file-to-folder promotion rule. Read it before adding a page, and add
the page's row there in the same change.

- **Shape:** one paragraph of orientation; an "Owns / does not own" section
  naming the boundary and the owning page for what it excludes; then laws as
  short declarative bullets grouped by aspect. Target 100–200 lines, well
  inside the promotion threshold.
- **One canonical owner per fact.** If two pages define the same thing, stop
  and designate the owner — delete the other side and link to the owner. Never
  resolve a conflict by making both sides agree.
- **Docs do not link into work state.** No issue or PR references as content —
  git blame is the provenance. Issues point at docs, not the reverse.

### The no-dynamic-state rule

A durable doc may **never** contain: `Status:` lines · "next" / "remaining
work" / "not started" · slice or stage numbers · rollout checklists · roadmap
priority · current blockers · "awaiting owner" · PR or issue state. All of that
is board state.

The distinction that matters — an architectural **requirement** belongs in the
page; **project state** does not:

- Belongs: "A transfer requires an addressable body-surface owner on both
  participants."
- Does not: "Blocked because player body-surface ownership isn't implemented
  yet."

### Style guards

- **No conversation in the record:** no "as discussed" / "you said" / "let me
  know", no agent narration, no standing `TBD` — an undecided thing is a
  `decision-needed` issue, not a placeholder. Owner rulings appear as dated
  ruling lines, not remembered dialogue.
- **Tables are read raw:** 2–4 columns, short cells, every row one physical
  line, pipes padded so the source aligns, literal pipes escaped `\|`. If
  several cells need prose, it is a list, not a table.

## ADRs — sparingly

`docs/decisions/NNN-<slug>.md`, template `templates/adr.md`: Decision, Context,
Alternatives considered, Why this choice, Consequences — 30–100 lines.

An ADR exists to **prevent re-litigation**, not to record history. "Touch,
smell and taste are sibling owners; do not collapse them into one sensory
system" earns one, because someone will propose collapsing them again. "Use 30
days instead of 60" does not — that number belongs in the relevant reference
page. Most owner rulings never become ADRs.

## Validation

Before finishing any change this skill governed:

- **Every relative link in `docs/` resolves** — run it, don't eyeball it:

  ```bash
  python3 -c "
  import re,os,glob
  n=0
  for f in glob.glob('docs/**/*.md',recursive=True):
      d=os.path.dirname(f)
      for m in re.finditer(r'\]\(([^)#]+\.md)(?:#[^)]*)?\)',open(f,encoding='utf-8').read()):
          t=m.group(1)
          if not t.startswith('http') and not os.path.exists(os.path.normpath(os.path.join(d,t))):
              n+=1; print('BROKEN',f,'->',t)
  print('broken:',n)"
  ```

- **No reference to a retired working document survives, in any form** — the
  rule, its rationale, and the `§N` clause it carries are stated once, in
  `docs/README.md`'s documentation rules. Enforce it here:

  ```bash
  git grep -nE "[a-z0-9-]+\.(plan|spec|trial|audit|deferred|research|followups)\.md|§[0-9]" -- apps packages scripts docs
  ```

  Every hit must name a file that exists under `docs/`, or be a doc's reference
  to its own numbered sections.

- **No dynamic state in any durable doc you touched** — check against the
  banned list above, and search touched files for `Status:`, `slice`,
  `remaining`, `awaiting`, `blocked on`.
- **Issues you filed are complete:** on the board with fields set, sub-issues
  linked to their parent, dependencies wired as relations, labels applied.
- Tables you touched are aligned or converted to lists; no residue phrases in
  anything you wrote.

Documentation-only changes run no code gates (root `CLAUDE.md`); these checks
are the review.
