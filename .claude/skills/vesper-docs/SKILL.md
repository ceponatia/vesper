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
them, plus the five rules they do not state in full: canonical ownership, the
Outcome line, the progress ladder, the residue guardrail, and the validation
checklist.

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
6. **Record every finished piece of work one rung up.** A finished slice goes in
   its spec, a finished spec in its plan, a finished plan in
   `roadmap.shipped.md` — in the same change that finishes it. See
   [The progress ladder](#the-progress-ladder).
7. **Never mark work shipped because code exists.** A merged PR, a passing test,
   a spec, or a written slice does not close a plan. `shipped` means the WHOLE
   plan is delivered *and accepted*; a behavior claim additionally requires a
   trial or evidence doc that says what was observed. Built-but-unaccepted is its
   own state and must be written as such.
8. **Prefer deletion to preservation.** Superseded docs get removed or archived,
   not annotated. This repo does not keep a legacy tier — `finished/` is
   completed work, not an attic for the outdated.
9. **Tables follow the formatting rules or become lists.** See
   [Table formatting](#table-formatting). Both tiers, no exceptions.
10. **Reference docs carry no dates, no slice numbers, and no future tense.** If
    you are writing "will", "planned", or "once we", you are writing a plan and
    it belongs in the working tier.

## Artifact ownership

Working tier — `docs/developer-notes/`:

- **`<topic>.plan.md`** — owns the Outcome line, why the work matters, what the
  owner gets, product boundaries and non-goals, the delivery slices and their
  order, success criteria, **which of its specs are complete**, and **all** open
  questions. Written in plain English for a non-technical product reader. Must
  not own type shapes, algorithms, schema sketches, file trees, implementation
  pseudocode, or a slice-by-slice build narrative.
- **`<topic>.spec.md` / `<topic>.spec.<area>.md`** — owns contracts, type
  shapes, ownership rules, algorithms, persistence decisions, diagnostics, code
  organization, migrations, fixtures, and **the implementation status of every
  slice it governs** — built, built-but-unaccepted, or remaining. Written for
  coding agents. Must not own priority, product rationale beyond a one-line
  pointer, or open product questions.
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
- **`roadmap.shipped.md`** — owns one line per **completed plan**. A slice, a
  spec, or a bug fix never earns an entry here.
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

## The progress ladder

Finished work is recorded **one rung up**, in the same change that finishes it.
Landed work its governing doc does not mention is unfinished work: the next agent
rebuilds it, or plans around a gap that closed weeks ago.

| Finished | Recorded in          | As                                    |
| -------- | -------------------- | ------------------------------------- |
| A slice  | its spec             | implementation status + any ruling    |
| A spec   | its plan             | one line, not a build narrative       |
| A plan   | `roadmap.shipped.md` | one line, and the move to `finished/` |

**Intent lives in the plan; state lives in the spec.** The plan says which slices
exist and what each one makes true — that is the delivery order and it does not
change when code lands. The spec says whether they are built. A plan that grows a
slice-by-slice build history has taken over its spec's job, and the two will
disagree within a month.

A plan with no spec owns its own slice status until it grows one. The moment it
does, that status moves and the plan keeps only the per-spec line.

### Built is not accepted

Between "the code is merged" and "the plan is done" there is a real state, and it
has to be written down: every slice built, nothing left to code, waiting on a
paid trial, an owner review, or a flag enable. Record it in the governing doc and
**name what is being waited on**. A plan in that state carries
`Status: awaiting acceptance — <what>`. It is not `shipped`, it does not move to
`finished/`, and it keeps its roadmap line.

The failure this prevents is the quiet one: work that reads as done because the
PR merged, so nobody runs the trial that was the whole point of building it.

### What a shipped line looks like

Only a completed plan earns one, and it is a single line:

```markdown
- **<Plan title>** — [plan](finished/<topic>.plan.md) — <date> — <one-sentence hook>.
```

No slice list, no rulings, no build history — those stayed in the plan and its
specs, which is why the line links to them. `roadmap.md` and
`roadmap.shipped.md` are indexes, and an entry that grows past a sentence or two
is a plan leaking into its index.

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

## Document length

**The ~400-line guideline is a reference-tier rule only.** It exists because
`docs/` is read by a person orienting themselves, and a long reference doc
buries the thing they came for. A `docs/<system>.md` past ~400 lines gets
promoted to `docs/<system>/` with a `README.md` index plus one file per
sub-topic (`docs/README.md` has the procedure).

**Working docs under `docs/developer-notes/` have no line limit.** A plan, spec,
trial, or audit is as long as its subject requires, and a 900-line spec is not a
defect — splitting one to hit a number produces artificial seams that scatter a
single argument across files and make the topic harder to follow, not easier.

Split a working doc when its **content** justifies it, never its length:

- A spec covering several genuinely separate domains, where a reader needs one
  and not the others → `<topic>.spec.<area>.md`.
- A topic whose parts are edited independently by different work → a hub plus
  unit docs, the way the engine gate and spec-cluster docs are organized
  (`docs/developer-notes/CLAUDE.md` §"Engine gate docs").
- A plan carrying spec-grade technical detail → that detail moves to the spec.
  This is a boundary fix that happens to shorten the plan, not a length fix.

Do not open a split-for-length pass over `docs/developer-notes/`, and do not
report a working doc as oversized on line count alone.

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

### Closing out a slice

The common case, and it never touches the roadmap. In the same change that lands
the code:

1. Update the **spec**'s implementation status: this slice is built, or built and
   waiting on something you name. Record any ruling the build settled.
2. If the slice completed everything a spec governs, add or update that spec's
   line in the **plan**.
3. If behavior changed for a user, update the matching **reference** doc in
   `docs/` — a shipped behavior that only exists in a plan is undocumented.
4. Correct the plan's own text where the build contradicted it. A plan that still
   describes a blocker the slice removed will send the next agent around it.

Do **not** add a `roadmap.shipped.md` entry, and do not move anything to
`finished/`. If the roadmap's one-line hook for the plan now says something
untrue — it named this slice as the next work, or as a blocker — fix that line
and nothing else.

### Closing out a plan

Only when the whole plan is delivered **and accepted**. In one change: set the
plan's `Status:` to `shipped — <date>` with a note naming leftovers and where
they went; `git mv` the whole `<topic>.*` family into `finished/`; remove its
entry from `roadmap.md`; add the single line to `roadmap.shipped.md` pointing at
the `finished/…` path. Leave every other inbound link alone.

If the code is all written but acceptance has not happened, this is not that
change. Set `Status: awaiting acceptance — <what>`, record it in the spec too,
and leave the plan where it is.

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
- `roadmap.md` links resolve and its entries do not contradict each plan's
  `Status:` line.
- Every live plan has a Status line and an Outcome line.
- **Every piece of dev work in this change is recorded one rung up** — the slice
  in its spec, the completed spec in its plan, the completed plan in
  `roadmap.shipped.md`. Anything built but not yet accepted says so, and names
  what it waits on.
- `roadmap.shipped.md` gained an entry **only** if a whole plan completed, and
  that entry is one line pointing at `finished/`.
- Nothing moved to `finished/` while its plan still has a queued slice.
- Every table you touched obeys [Table formatting](#table-formatting): pipes
  aligned in the raw source, one physical line per row, no newlines in cells,
  2–4 columns, short cells — or it is a list instead.
- No residue phrases (see the guardrail) in any plan or trial body.
- Reference docs you touched stay present-tense and dateless.
- **Reference-tier only:** a `docs/` doc over ~400 lines is promoted to a folder
  per `docs/README.md`. **The line guideline does not apply to
  `docs/developer-notes/`** — see [Document length](#document-length).

If the change also touches code, the normal PR + CI rule applies; the docs
checks above are additional, not a substitute.

## Templates

In `templates/` beside this file: `plan.md`, `spec.md`, `trial.md`, `audit.md`,
`deferred-stub.md`, `reference-doc.md`. Copy the file, keep the section order,
delete sections that genuinely do not apply rather than leaving them empty.
