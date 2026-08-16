# developer-notes folder instructions

This folder contains plan and spec files for development phases. Whenever possible, keep these documents up-to-date. When we develop something that conflicts with planned work, please update the planned work to reflect what has changed.
If a complete reanalysis and rewrite of the planned work is needed due to other changes in code, say so in the relevant document. Do not do this analysis unless asked to, but tell the user in your response that it is needed.

**Before editing anything here, invoke the `vesper-docs` skill**
(`.claude/skills/vesper-docs/`). It holds the full procedure for this folder —
artifact ownership, the canonical-owner rule, the residue guardrail, the
close-out sequence, and the validation checklist — plus copyable templates for
plans, specs, trials, audits, and deferred stubs in its `templates/` folder.
This file states the folder's local rules; the skill states how to apply them.

## No line limit in this folder

The ~400-line split guideline in the root `CLAUDE.md` and `docs/README.md` is a
**reference-tier rule** — it governs `docs/` only. Documents here have no length
limit. A plan, spec, trial, or audit is as long as its subject requires, and a
900-line spec is not a defect; splitting one to hit a number scatters a single
argument across files and makes the topic harder to follow.

Split a document here when its **content** justifies it:

- A spec covering separate domains a reader needs individually →
  `<topic>.spec.<area>.md`.
- A topic whose parts are edited independently by different work → a hub plus
  unit docs, per §"Engine gate docs" below.
- A plan carrying spec-grade technical detail → that detail moves to the spec.
  That is a boundary fix which happens to shorten the plan, not a length fix.

Never open a split-for-length pass over this folder, and never report a document
here as oversized on line count alone.

## Every document opens with Status, and every plan with Outcome

- **`Status:` on the line after the H1, in every file.** Plans use the lifecycle
  vocabulary (**draft** / **next** / **active** / **awaiting acceptance** /
  **shipped — <date>** / **parked**). Everything else says what it is:
  `companion to <plan>`, `detail for <plan>`, `reference (audit run <date>)`,
  `closed — <verdict> <date>`.
  - **shipped** means the WHOLE plan is delivered *and accepted*. A plan with one
    slice left is still **active**, however much of it has landed.
  - **awaiting acceptance** is the state between them: every slice built, nothing
    left to code, and the plan waiting on the thing it named — a paid trial, an
    owner review, a flag enable. Say which, on the Status line.
- **`Outcome:` on the next line, in `.plan.md` files only.** One sentence:
  `<A player | The owner | A developer> can <do something concrete> so that
  <observable consequence>.` It names a person, not a system; promises something
  observable, never "more robust/reliable/polished"; and stays readable to
  someone who has never seen this repo. Internal work gets an honest internal
  outcome about a developer or the owner — do not invent a player benefit.
- **Uncertainty has one home:** the owning plan's `## Open questions`. Specs,
  audits, and trials may raise a question, but it also appears in the plan, and
  resolving it means removing it there and recording the ruling in the detail
  doc.
- **No conversation in the record.** No "as discussed", "you said", "your
  feedback", "we agreed", "let me know", no agent narration, no standing "TBD".
  Rehome the meaning as context, a non-goal, an open question, or a dated owner
  ruling (`Owner ruling (<date>): …`).

## Plan and spec audiences

- **Plans are for regular readers, including non-technical product readers.**
  Write them in plain English and make them understandable without reading code
  or the matching spec. A plan should explain the user experience, why the work
  matters, product boundaries, delivery slices, success criteria, and open
  questions. Prefer ordinary examples over type names, algorithms, file trees,
  schema sketches, or implementation pseudocode.
- **Specs are the technical version for coding agents.** Put contracts, type
  shapes, ownership rules, algorithms, persistence decisions, diagnostics,
  code organization, migrations, and detailed fixtures in `<topic>.spec.md` or
  `<topic>.spec.<area>.md`.
- A plan may link to a technical term or summarize a key invariant when the
  product decision depends on it, but implementation detail belongs in the
  matching spec. The plan remains the source of truth for scope, rollout,
  success criteria, and all open questions; the spec is the source of truth for
  how coding agents implement those decisions.
- When an existing `.plan.md` reads like a coding design, move that detail into
  a matching spec as part of the next substantive edit instead of continuing to
  grow the technical plan.

## Trial reports and Markdown formatting

- **Trial result documents are stakeholder summaries.** Write them in plain
  English for product owners and other non-development readers. Lead with the
  decision, player-visible outcomes, limitations, and next steps. Put chat and
  message identifiers, timestamps, logs, diagnostic names, internal state,
  implementation references, and detailed verification history in a matching
  evidence appendix.
- **Tables are allowed, but they are read in the raw `.md` far more often than
  in a renderer — format them for the source file.** Every row on exactly one
  physical line, never a newline inside a cell, cells padded with spaces so the
  pipes line up vertically, separator row at the same widths, literal pipes
  escaped as `\|`. Prefer 2–4 columns and short phrases (~50–70 characters a
  cell); join multiple short items in one cell with `<br>`, never a bullet list
  or a code block. **If several cells need long prose, it is not a table** —
  use headings and bullets. Any table you touch gets brought into this shape as
  part of the edit. Full rules: the `vesper-docs` skill, §"Table formatting".

## The progress ladder: slice → spec → plan → shipped

Every finished piece of work is recorded **one rung up**, in the same change that
finishes it. Landed work that its governing doc does not mention is unfinished
work, and the next agent will rebuild it or plan around a gap that no longer
exists.

- **A finished slice is recorded in its spec.** The spec owns implementation
  status for the area it governs: what is built, what is built but unaccepted,
  what remains, and any ruling the build settled. A plan with no spec owns its
  own slice status until it grows one; the moment it does, that status moves.
- **A finished spec is recorded in its plan.** The plan owns which of its specs
  are complete — one line each, not a slice narrative. The plan still owns the
  *delivery order*: it says which slices exist and what each makes true, while
  the spec says whether they are built. Intent in the plan, state in the spec.
- **A finished plan is recorded in `roadmap.shipped.md`.** One line, and only
  when the whole plan is delivered and accepted.

**Built is not accepted.** When code has landed but the plan is waiting on a
trial verdict, an owner review, or a flag enable, say so in the governing doc and
name what is being waited on. Never write it as shipped, and never leave it
unwritten.

**The indexes stay short.** `roadmap.md` and `roadmap.shipped.md` are indexes,
not records. Slice histories, rulings, and build narratives belong in the spec
and the plan; an entry in either file that grows past a sentence or two is a plan
leaking into its index.

## Ship close-out: move shipped docs to finished/

Archiving is part of shipping, not an optional afterthought — un-archived
shipped plans are how this folder rots. It happens once per plan, when the whole
plan is delivered and accepted — never per slice. When a plan's `Status:` flips
to **shipped** (or **superseded**), the same change that does the roadmap
close-out also:

- `git mv`s the `<topic>.plan.md` **and every `<topic>.*` companion** (spec,
  followups, detail docs) into `finished/` together, so their mutual relative
  links keep resolving.
- Removes the plan's entry from `roadmap.md` entirely, and writes its single
  line in `roadmap.shipped.md` pointing at the `finished/…` path.
- **Repoints every link the move broke** (owner ruling 2026-08-15, reversing the
  old "leave them stale" rule):
  - **Inbound** — every link to the moved docs from anywhere under
    `docs/developer-notes/`, including from docs already in `finished/`.
  - **Outbound** — the moved docs' own relative links. Dropping a level into
    `finished/` breaks every one of them; each needs one more `../`. This is the
    single biggest source of rot, and it is invisible unless you check.
  - Reference docs need no repointing, because they no longer link here at all
    (see below).

  The old rule assumed a shipped doc's stale links were harmless. They compound:
  the 2026-08-15 sweep found **355 broken links across `docs/`**, 291 of them
  inside `finished/` docs whose outbound paths broke when they were archived.

- **Never link from `docs/` into this folder.** A reference doc contains the
  information it needs; naming the governing doc is fine as **plain text**
  (`` `chat-initiative.plan.md` ``), never as a link. Working docs are dated and
  archivable, so a reference doc that defers to one goes wrong the moment the
  plan ships — and it goes wrong in a way a path fix does not catch.
- Trims the idea's `deferred.plan.md` entry if it graduated from the parking
  lot (a one-line tombstone at most), and updates its line in
  `deferred/CLAUDE.md`'s stub index if it started as a stub there.

Two kinds of docs stay in this folder despite shipped work: plans with any slice
still queued, however much of them has landed (their progress lives in their
spec, not in the shipped history), and living reference sets cited from code and
live docs (the engine hub/spec/gate family). When in doubt: if `roadmap.md`
still lists it, it stays.

## Engine gate docs (split 2026-07-21)

The successor-engine plan and spec are split so no single file has to be read or
edited whole:

- **One doc per gate: `engine.gateN.<slug>.md`** (e.g. `engine.gate6.dual-lod.md`),
  where the slug names what the gate delivers. Each holds that gate's full plan
  section — scope, build order, and the shipped E-package histories.
  [engine.plan.md](engine.plan.md) stays the hub: goals, the gate index list
  (one-line status + link per gate), dependency order, and cost/quality material.
  **Future gates get their own file at planning time** (Gate 7 already has one) —
  never grow a new gate inline in the hub. Gate numbers in filenames are NOT the
  deprecated `phase-N` pattern: gate numbers are stable architectural identities
  (each gate's exit gates the next; they can never be resequenced), so the name
  encodes *what*, not a reorderable *when*.
- **The spec is split by §-cluster: `engine.spec.<cluster>.md`** (kernel / world /
  mind / bodies-materials / lod / operations). Section numbering is GLOBAL across
  the set and never renumbers; [engine.spec.md](engine.spec.md) is the
  authoritative § → file index. Keep citing sections as "engine.spec §N" in code
  and docs — the index resolves them. A new section joins the file owning its
  range; a genuinely new domain gets a new cluster file plus an index row. Owner
  rulings stay in §39 (engine.spec.operations.md).
- When finishing gate work, update: the gate doc (status + package history), the
  hub's gate index row, and roadmap.md — in that order of detail (full record in
  the gate doc, one line in each index).

## App Development State

Vesper is a fork of Reverie, a role playing game. Vesper is more romance focused while Reverie is general.
Vesper began with a "World Model" system which had characters, locations, items, etc. and attempted to use map locations and schedules to have NPCs move around the world. This system became somewhat _broken_ and we weren't able to get characters to move to locations in a timely fashion to keep the story going, which broke the narrative aspect of the game.
Because of this, we stepped back and created a 1-on-1 character chat which was initially run from within Character forms in the library. This worked quite well and after further development, we broke it out into its own flow and added multiple character chats to it. It lacks some features the World Model had such as locations-as-entitites and map navigation, but narratively it is greatly expanded over the World Model.
The World Model system is now fully retired. Its successor — the simulation engine built gate-by-gate under [engine.plan.md](engine.plan.md) (gates 0–6) — rolled out through [finished/engine.rollout.plan.md](finished/engine.rollout.plan.md) (R0–R6), and R6 (2026-07-22) deleted the legacy world/session-model code and database tables outright.
Two lanes remain: legacy character chat (the live product for ordinary chats) and successor chats — a character chat bound to its own simulated world, created from the `/worlds` front door, with the engine authoritative per the `engine_authority` flag. New patterns still prove out in the chat lane first.
