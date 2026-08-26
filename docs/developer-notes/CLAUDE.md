# developer-notes folder instructions

This folder contains plan and spec files for development phases. Whenever possible, keep these documents up-to-date. When we develop something that conflicts with planned work, please update the planned work to reflect what has changed.
If a complete reanalysis and rewrite of the planned work is needed due to other changes in code, say so in the relevant document. Do not do this analysis unless asked to, but tell the user in your response that it is needed.

**Before editing anything here, invoke the `vesper-docs` skill**
(`.claude/skills/vesper-docs/`). It holds the full procedure for this folder —
artifact ownership, the canonical-owner rule, the residue guardrail, and the
validation checklist — plus copyable templates for plans, specs, trials, and
audits in its `templates/` folder. This file states the folder's local rules;
the skill states how to apply them.

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
  unit docs.
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

## Every new plan is written from the plan template

The mandatory structure for a `.plan.md` is the plan template at
`.claude/skills/vesper-docs/templates/plan.md` (owner ruling 2026-08-22). It
applies to every plan created from now on.

- **Every numbered template section appears in the plan**, in template order,
  under the template's headings. A section that does not apply is filled with
  `N/A — <why it does not apply>` — a bare `N/A` is acceptable, the reason is
  better. A section is never omitted.
- **No sections beyond the template.** If a plan needs a section the template
  does not define, ask the project owner to upgrade the template; never deviate
  in one document. Unresolved, that request lives in the plan's risks/open
  questions section as waiting on an owner ruling.
- The template's trailing "Planning rules for agents" section is writer
  instruction, not plan content — it does not appear in the finished plan.
- **Plans written before the template are migrated in dedicated tasks**, on the
  owner's request. When editing a pre-template plan for another reason, keep
  its existing structure; do not restructure it as a side effect.

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

## The progress ladder: slice → spec → plan

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

**Built is not accepted.** When code has landed but the plan is waiting on a
trial verdict, an owner review, or a flag enable, say so in the governing doc and
name what is being waited on. Never write it as shipped, and never leave it
unwritten.

**The index stays short.** `roadmap.md` is an index, not a record. Slice
histories, rulings, and build narratives belong in the spec and the plan; an
entry that grows past a sentence or two is a plan leaking into its index.

## Never link from docs/ into this folder

A reference doc contains the information it needs; naming the governing doc is
fine as **plain text** (`` `chat-initiative.plan.md` ``), never as a link.
Working docs are dated and directional, so a reference doc that defers to one
goes wrong the moment the plan ships — and it goes wrong in a way a path fix
does not catch.

Links **within** this folder are ordinary and expected. Keep them resolving:
when a doc is renamed or removed, repoint or strip every inbound link in the
same change. The 2026-08-15 sweep found 355 broken links across `docs/` because
that was skipped, and a broken relative path is unresolvable to the next reader.

## App Development State

Vesper is a fork of Reverie, a role playing game. Vesper is more romance focused while Reverie is general.
Vesper began with a "World Model" system which had characters, locations, items, etc. and attempted to use map locations and schedules to have NPCs move around the world. This system became somewhat _broken_ and we weren't able to get characters to move to locations in a timely fashion to keep the story going, which broke the narrative aspect of the game.
Because of this, we stepped back and created a 1-on-1 character chat which was initially run from within Character forms in the library. This worked quite well and after further development, we broke it out into its own flow and added multiple character chats to it. It lacks some features the World Model had such as locations-as-entitites and map navigation, but narratively it is greatly expanded over the World Model.
The World Model system is now fully retired. Its successor — the simulation engine built gate-by-gate through gates 0–6 — rolled out through releases R0–R6, and R6 (2026-07-22) deleted the legacy world/session-model code and database tables outright.
Two lanes remain: legacy character chat (the live product for ordinary chats) and successor chats — a character chat bound to its own simulated world, created from the `/worlds` front door, with the engine authoritative per the `engine_authority` flag. New patterns still prove out in the chat lane first.
