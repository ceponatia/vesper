---
name: vesper-docs
description: Create, review, and migrate Vesper documentation across both tiers — reference docs in docs/ and working docs in docs/developer-notes/ (plans, specs, trials, audits, roadmap, deferred, finished). Use when writing or editing any Markdown under docs/, adding or closing out a plan, archiving shipped work, or restructuring documentation.
---

# Vesper documentation

Vesper documents in two tiers, and the split is the whole discipline:

- **Reference docs (`docs/`)** describe the app **as it is now**. Present tense,
  dateless, no plans, no history.
- **Working docs (`docs/developer-notes/`)** describe **what we are doing about
  it**. Dated, directional, status-carrying.

A reader who wants to know how something works reads the reference tier. A
reader who wants to know what is coming reads the working tier. When those two
jobs collide in one file, split the file — never blur the tier.

The always-loaded rules live in the root `CLAUDE.md`, `docs/README.md`, and
`docs/developer-notes/CLAUDE.md`. This skill is the procedure for applying
them, plus the four rules they do not state: canonical ownership, the Outcome
line, the residue guardrail, and the validation checklist.

## Operating rules

1. **Read before writing.** `docs/README.md` and the `README.md` of any folder
   you touch; `docs/developer-notes/CLAUDE.md` for working docs. For an edit to
   an existing topic, read the whole topic family (`ls docs/developer-notes/ |
   grep <topic>`) before changing one file in it.
2. **One canonical owner per fact.** Every outcome, invariant, and contract is
   defined in exactly one document; everything else links to it. If two
   documents define the same thing, stop and designate the owner before
   rewriting either. Never resolve a conflict by making both sides agree —
   delete one side and link to the other.
3. **Every plan opens with a Status line and an Outcome line.** See
   [The Outcome line](#the-outcome-line).
4. **Uncertainty has one home: the owning plan's `## Open questions`.** A spec,
   audit, trial, or reference doc may raise a question, but it must also appear
   in the plan. Resolving one means removing it from the plan and recording the
   ruling in the detail doc.
5. **Never write conversation into a document.** See
   [The residue guardrail](#the-residue-guardrail).
6. **Never mark work shipped because code exists.** A merged PR, a passing test,
   a spec, or a written slice does not close a plan. Closing requires the
   roadmap close-out; a behavior claim additionally requires a trial or evidence
   doc that says what was observed.
7. **Prefer deletion to preservation.** Superseded docs get removed or archived,
   not annotated. This repo does not keep a legacy tier — `finished/` is
   completed work, not an attic for the outdated.
8. **Tables follow the formatting rules or become lists.** See
   [Table formatting](#table-formatting). Both tiers, no exceptions.
9. **Reference docs carry no dates, no slice numbers, and no future tense.** If
   you are writing "will", "planned", or "once we", you are writing a plan and
   it belongs in the working tier.

## Artifact ownership

Working tier — `docs/developer-notes/`:

- **`<topic>.plan.md`** — owns the Outcome line, why the work matters, what the
  owner gets, product boundaries and non-goals, delivery slices, success
  criteria, and **all** open questions. Written in plain English for a
  non-technical product reader. Must not own type shapes, algorithms, schema
  sketches, file trees, or implementation pseudocode.
- **`<topic>.spec.md` / `<topic>.spec.<area>.md`** — owns contracts, type
  shapes, ownership rules, algorithms, persistence decisions, diagnostics, code
  organization, migrations, and fixtures. Written for coding agents. Must not
  own priority, product rationale beyond a one-line pointer, or open product
  questions.
- **`<topic>.trial.md`** — owns the stakeholder verdict: the decision,
  player-visible outcomes, limitations, and next steps, in plain English. Must
  not own chat or message identifiers, timestamps, logs, diagnostic names, or
  internal state.
- **`<topic>.trial.evidence.md`** — owns exactly what the trial doc may not:
  identifiers, timings, diagnostic codes, verification history.
- **`<topic>.audit.md`** — owns findings about the code as it stood on a stated
  date. Must not own the plan to fix them; a fix worth doing becomes a plan or a
  `deferred.plan.md` entry.
- **`<topic>.followups.md`** — owns post-ship corrections to a shipped topic.
- **`roadmap.md`** — owns priority order and nothing else. Its `## To be
  Planned` section is the owner's intake; agents never add to or reword it.
- **`roadmap.shipped.md`** — owns the one-line-per-topic shipped history.
- **`deferred.plan.md` + `deferred/`** — owns parked ideas that are not
  committed work.
- **`finished/`** — owns the archived history of shipped topics. Read-only:
  never edit a `finished/` doc to keep it current, and never repoint its
  outbound links.

Reference tier — `docs/`:

- **`docs/README.md`** — owns the reading order and the documentation rules for
  this tier.
- **`docs/<system>.md`** or **`docs/<system>/`** — owns the current patterns and
  invariants of one live system. Must not own rollout plans, dates, or history.
- **`docs/contracts/`** — owns the registries and extension points (attributes,
  meters, fact kinds, body locations) and how to extend them.
- **`docs/guide/`** — owns task-oriented manual pages for a person using the app.
- **`docs/image-models/`** — owns per-model external API reference.

## The Outcome line

Every `.plan.md` opens with its title, then `Status:`, then `Outcome:` — one
sentence, before any prose.

```markdown
# Scene image spatial fidelity

Status: next (planned 2026-08-07)

Outcome: A player can see a scene image that matches where the characters
actually are, so that the picture stops contradicting the text they just read.
```

The sentence names **a person**, **a concrete new ability**, and **an
observable consequence**. The person is a player, the owner, or a developer
working in this repo — never a system. Internal work gets an honest internal
outcome ("A developer can change the attribute registry without touching the
schema, so that adding a trait stops requiring a migration"), not an invented
player benefit.

Rejected shapes:

- **A system as the subject** — "The narrator receives constraint cues" names no
  person and no benefit.
- **Trust claims as the benefit** — "so that the app is more robust/reliable/
  polished" is unobservable. Say what changes on screen or in the workflow.
- **Unexplained internal vocabulary** — if the sentence needs "LOD", "affordance
  compiler", or "identity pack" to parse, rewrite it for a reader who has never
  seen this repo. The term can appear later in the document, defined.
- **A restatement of the work** — "so that scene images use the spatial index"
  describes the implementation, not the result.

The Outcome line is the plan's property. The roadmap's entry for the plan keeps
its own bold title and prose hook, but the hook **must not contradict the
Outcome line** — when the plan's outcome changes, check the roadmap line in the
same edit.

Non-plan docs do not carry an Outcome line. They carry a Status line saying what
they are: `Status: companion to <plan>`, `Status: detail for <plan>`,
`Status: reference (audit run <date>)`, `Status: closed — <verdict> <date>`.

One `.plan.md` is deliberately exempt: `deferred.plan.md` is the parking-lot
index, not a plan, and carries `Status: parking lot` with no Outcome line. Its
individual stubs under `deferred/` each carry an `Outcome (provisional):` line.

## Table formatting

A Markdown table is read far more often in the raw `.md` file than in a
renderer. A table whose source is a ragged wall of pipes is worse than no table
at all — that is the problem these rules exist to solve. **Optimize for the raw
file, not the rendered output.**

Structure — decide whether it should be a table at all:

- Prefer **2–4 columns**. Split a very wide table into several narrower ones.
- Keep cells short — **roughly 50–70 characters** is a useful soft limit.
- Prefer short phrases over sentences inside cells.
- **If several cells need long prose, do not use a table.** Use headings and
  bullets. This is the common case in plans and specs, and a list is the right
  answer there — do not force the content into a grid.
- No paragraphs, bullet lists, or multi-line code blocks inside a cell. If a
  cell needs several short items, join them with `<br>`.

Source formatting — non-negotiable once you have a table:

- Every row is **exactly one physical line**. Never wrap a row across lines.
- Never insert a newline inside a cell.
- **Pad cells with spaces so the pipes align vertically** in the raw file.
- The separator row uses the same column widths as the rest.
- Escape a literal pipe inside cell content as `\|`.

Aligned, so the source reads as a grid:

```markdown
| Gate | Status              | Owns                          |
| ---- | ------------------- | ----------------------------- |
| 5    | CLOSED — 2026-07-20 | Bodies, materials             |
| 6    | CLOSED — 2026-07-21 | Dual level of detail          |
| 7    | draft               | Institutions — not committed  |
```

Any table you touch gets brought into this shape as part of the edit — the same
way a table you touch used to get converted to a list.

## The residue guardrail

Before finishing any document, search it for conversation that leaked into the
record. Rewrite or delete:

- Address to a reader in the room — "as discussed", "you said", "your feedback",
  "as you requested", "per your note", "let me know", "I understand".
- Deferred thinking presented as content — "we need to figure out", "still needs
  to be decided", "TBD" left standing in a plan body.
- Agent narration — "the agent will", "I checked and", "this was harder than
  expected", review commentary about the work rather than the product.
- Undefined internal vocabulary used as if the reader shares the conversation
  it came from.

Each one converts into a structured home instead: a **Context** or
**What the owner gets** paragraph, a **Non-goal**, a decision recorded in the
spec, or an entry under the plan's **`## Open questions`**.

Owner rulings are the exception worth preserving, and they get recorded as
rulings — "Owner ruling (2026-08-05): at `exact` LOD the primary stays
mechanically inert" — not as remembered dialogue.

## Workflows

### Writing a new plan

1. Check `roadmap.md` first. Work the top of `## Next` unless told otherwise;
   out-of-order work still gets a roadmap line before you start.
2. Copy `templates/plan.md`. Fill Status and Outcome before any prose — if you
   cannot write the Outcome line, the work is not understood well enough to plan.
3. Put every technical decision in `<topic>.spec.md` from the start. A plan that
   grows type names is a plan that needed a spec three paragraphs ago.
4. Add the `roadmap.md` line under `## Next` or `## Active`. If the idea came
   from `## To be Planned`, remove it from there in the same change.

### Editing an existing topic

1. List the family: `ls docs/developer-notes/ | grep <topic>`.
2. Identify the canonical owner of the thing you are changing. Edit that file.
3. Update the docs whose meaning changed — not every doc that mentions the topic.
4. If behavior shipped, update the matching **reference** doc in `docs/` in the
   same change. A shipped behavior that only exists in a plan is undocumented.

### Closing out shipped work

In one change: set the plan's `Status:` to `shipped — <date>` with a note naming
leftovers and where they went; add the one-line entry to `roadmap.shipped.md`;
drop it from `## Active`/`## Next` in `roadmap.md`; `git mv` the whole
`<topic>.*` family into `finished/`; repoint the links in `roadmap.md` and
`roadmap.shipped.md` to `finished/…` and leave every other inbound link alone.

Partially-shipped work gets a shipped line for the slice **and** stays in Next
for the remainder, each cross-referencing the other, and does **not** move to
`finished/` yet.

### Migrating or cleaning existing docs

1. **Inventory before wording.** Determine the canonical owner, every inbound
   link, and the current implementation status. Do not improve prose first.
2. **Designate the owner** when two docs claim the same fact. Rewrite the owner;
   reduce the other to a link, or delete it.
3. **Extract, don't annotate.** Residue becomes an open question or a decision.
   Superseded content is deleted, not marked deprecated.
4. **Synthesize then remove.** When a working page's unique information has been
   folded into its canonical owner, delete the page. Do not create an archive
   tier for it — `finished/` is for shipped topics only.
5. **Verify links last**, after the moves settle.

## Validation

There is no automated docs checker in this repo, and documentation-only changes
do not need CI (root `CLAUDE.md`). Validate by hand before finishing:

- Every relative link resolves — check the ones you touched **and** the ones
  pointing at files you moved.
- `roadmap.md` links resolve and its statuses match each plan's `Status:` line.
- Every live plan has a Status line and an Outcome line.
- Every table you touched obeys [Table formatting](#table-formatting): pipes
  aligned in the raw source, one physical line per row, no newlines in cells,
  2–4 columns, short cells — or it is a list instead.
- No residue phrases (see the guardrail) in any plan or trial body.
- Reference docs you touched stay present-tense and dateless.
- Any doc that would exceed ~400 lines is split (reference tier: promote to a
  folder per `docs/README.md`; working tier: split into `<topic>.<subtopic>.md`
  or a hub-plus-units set like the engine docs).

If the change also touches code, the normal PR + CI rule applies; the docs
checks above are additional, not a substitute.

## Templates

In `templates/` beside this file: `plan.md`, `spec.md`, `trial.md`, `audit.md`,
`deferred-stub.md`, `reference-doc.md`. Copy the file, keep the section order,
delete sections that genuinely do not apply rather than leaving them empty.
