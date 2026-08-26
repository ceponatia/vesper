# Narrator Prompt Lab — technical spec

Status: companion to [narrator-prompt-lab.plan.md](narrator-prompt-lab.plan.md)

The implementation contract for coding agents. Product scope, priority, and open
questions live in the plan; this document is how the decisions in it get built.

## Scope

This spec governs the **replaceable narrator instruction seam** and the storage,
API and provenance around it: the prompt-authority IR the four narrator builders
emit, the classification of every existing instruction unit, owner-scoped
template/revision persistence, the admin CRUD and per-chat selection routes, the
resolution of one frozen instruction source per exchange, and the run provenance
recorded on every take.

It deliberately leaves alone: what the production instructions *say* (this is a
seam extraction, not a prompt rewrite), the narrator model axis
(`narrator-model-bench.plan.md` owns that), every helper agent's prompt, and the
variables/template-language follow-on.

## Implementation status

| Slice                                          | State                                      |
| ---------------------------------------------- | ------------------------------------------ |
| 1 — replaceable instruction boundary            | built 2026-08-26                           |
| 2 — templates and immutable revisions           | built 2026-08-26, awaiting the migration   |
| 3 — Prompt Lab canvas                           | built 2026-08-26, awaiting owner use       |
| 4 — per-conversation selector and active badge  | built 2026-08-26, awaiting owner use       |
| 5 — wire the live narrator lanes                | built 2026-08-26, never run on a real turn |
| 6 — take-level provenance                       | built 2026-08-26, never run on a real turn |
| 7 — hardening and owner rollout                 | not started                                |

Slices 2–6 are code-complete and unexercised: `drizzle/0121` has not been applied
to any database, so no Prompt Lab prompt has ever been written, selected, or
narrated with. Slice 1 is the exception — its byte-identity is proven against
`HEAD` and the existing suites pass, so the no-override path is verified.

Slice 7's hardening list is the acceptance gate and is deliberately still open.

### Rulings the build settled

**Owner ruling (2026-08-26) — units split at the sentence level.** Several
charter units are one string that crosses the authority boundary. The viewpoint
rule ends with *"never put words, thoughts, or actions in their mouth"*; the
narrator-camera rule mixes *"the camera sits behind the player's eyes"* (craft)
with *"never their deliberate actions, speech, or decisions"* (law). Classifying
either wholesale as `behavior` would let an experiment "test better player
agency" by deleting the law that protects player agency.

So units split at **sentence boundaries**, and a sentence that still mixes
authorities takes the **strictest** authority. Two consequences, both deliberate:

1. Production stays byte-identical by construction — the pieces rejoin with the
   separator they were already written with.
2. The tiebreak fails safe. A protective clause riding along with a craft clause
   survives every experiment; the reverse can never happen.

**Owner ruling (2026-08-26) — three borderline units.** `noRefusalRule` is
**behavior** (a test prompt may word it itself; the minor and content fences are
separate units and always stay). `readingPlayerMessageBlock` is a
**runtime_invariant** — it decides what the character can perceive, which is
epistemic truth, not narration style. `attributionTagRule` and the output half of
`messageNotationBlock` are **transport_contract**: the chat renderer parses
`[Name]` tags, so a replaced attribution rule silently breaks who-said-what in
the UI.

**Implementation ruling — an empty body is rejected on save.** The plan left this
to product. A blank editor silently stripping the narrator's entire craft layer
from every attached conversation is the wrong accident to permit; "no replaceable
handwritten behavior text" is expressible as a body that says so.

**Implementation ruling — a real FK with `ON DELETE SET NULL`.** The plan left
FK-vs-soft-pointer open. `character_chats.narrator_prompt_template_id` is a real
nullable FK: the constraint is the integrity backstop for a genuine hard delete,
while the *normal* delete is soft and the service explicitly clears live
selections in the same transaction. A soft pointer would permit dangling ids for
no gain.

### The service does not import the API layer

`server/narrator-prompts` carries its own six-line `unique_violation` predicate
rather than importing the identical one from `@/server/api`.

That barrel pulls the route and auth layer in behind it. Once the chat pipeline
imported the service, every consumer inherited a transitive edge to
`server/auth`, which reads the database at module load — so any test mocking
`db()` at module scope exploded several imports away from anything it meant to
exercise (`sim-surfaces.degradation.test.ts` was the one that caught it). A
persistence service has no business dragging authentication into its module
graph; the small duplication is the cheaper half of that trade.

### The inspector previews the override

The admin chat inspector (`previewChatPrompt` → `/api/admin/self/chat-inspector/:chatId/prompt`)
resolves the conversation's CURRENT selection and renders the prompt the next
exchange would build, override included.

§"Agent isolation" does not reach it. That rule keeps the resolved source away
from **helper agents** — the pulse, the extraction legs, classifiers, the scene
composer, the deliberator — which produce structured state rather than prose. The
inspector renders the prose narrator's own prompt, and one that quietly showed
production bytes for a conversation running a test template would answer the
single question it exists to answer incorrectly.

It resolves read-only, at preview time, and takes no lock: this is not the
exchange's frozen source, and it generates nothing.

## Contracts

All pure, in `apps/web/src/contracts/narrator-prompts/`, re-exported from that
folder's `index.ts`. Importable by `server/*`, by components, and by the prompt
builders; it imports nothing from either.

| Module                  | Owns                                                                     |
| ----------------------- | ------------------------------------------------------------------------ |
| `authority.ts`          | the four authority layers, the node IR, and the two render modes          |
| `template.ts`           | template/revision shapes, limits, and every API request schema            |
| `instruction-source.ts` | the resolved per-exchange source and its fallback reasons                 |
| `provenance.ts`         | the per-take run record                                                   |

### The authority layers

- **`behavior`** — narrator craft. Role, prose camera, pacing, richness, dialogue
  style, topic discipline. **The only layer a test prompt replaces.**
- **`runtime_context`** — authored and committed facts: who the character is,
  what is true now, what was remembered.
- **`runtime_invariant`** — fences that bound the reply whatever its style:
  player-agency law, perception ceilings, untrusted-data fencing, the minor
  fence, physical-consistency corrections.
- **`transport_contract`** — anything software downstream parses: the `[Name]`
  speaker-tag grammar, the successor's strict JSON schema, the retry correction
  block.

`narratorPromptAuthorityRank` orders them for the sentence-level tiebreak;
`strictestAuthority` applies it.

### The node IR

`NarratorPromptNode` is a small tree, not a flat section list, because today's
prompts carry structural formatting inside their content:

- **`unit`** — one classified piece of text with a stable semantic `id`
  (`camera_style_person`, `player_agency_message`). Never a displayed rule
  number, which moves the moment a behavior rule is dropped from a numbered list.
- **`literal`** — exact bytes with no authority: a heading, a block label.
  Rendered in both modes.
- **`behavior_slot`** — where the owner's handwritten instructions land. An
  explicit slot rather than "filter out behavior and splice the body in
  somewhere", so placement is a property of the builder a reviewer can see rather
  than an emergent consequence of a filter. Renders nothing in production.
- **`group`** — an ordered join. `separator` and `dropEmpty` exist to reproduce
  today's byte-exact joins: `join("\n")` keeps empty strings (and so keeps blank
  lines), `filter(Boolean).join("\n\n")` does not. `prefix`/`suffix` render only
  when at least one child rendered, so a label never dangles.
- **`numbered_list`** — a contiguously numbered rule list. Numbers are
  **generated from position**, never authored into the text: today's lists are
  contiguous 1…n with every item present, so production renders byte-identically,
  and an override's survivors renumber instead of leaving gaps.

`renderNarratorPrompt(nodes, mode)` takes `{kind:"production"}` or
`{kind:"override", body}`. Production renders every unit and nothing in the slot;
override renders nothing for `behavior` units and the custom body in the slot.

**Nothing anywhere may reference a rule by its displayed number.** Bind to
heading names, as the prompt style rules in `docs/character-chat/prompts.md`
already require.

### Blank-line joins

Where a builder today interleaves `""` entries into a `join("\n")`, model it as
`separator: "\n\n"` with `dropEmpty: true` rather than as `literal("")` children.
The two are byte-identical in production — `["a","","b"].join("\n")` equals
`["a","b"].join("\n\n")` — but the literal-empties form strands blank lines
wherever an override drops a behavior unit.

## Ownership rules

- **`apps/web/src/server/narrator-prompts/`** is authoritative for template and
  revision rows. Nothing else writes them.
- **Revisions are immutable after insert.** No code path updates a revision row.
- **`current_revision` and `current_revision_id` always agree** outside a
  transaction. They move together or not at all.
- **The chat send request never carries prompt text.** A normal send accepts no
  raw body, no revision id, and no one-call template override; the server
  resolves the selection from the owned chat. This keeps authorization and
  provenance server-owned and blocks request-level prompt spoofing.
- **The selection is operational configuration, not story state.** It sits beside
  `agent_reasoning_profile` and `scene_composer_model`, is absent from
  `ChatScenario` and from scenario presets, and is never touched by state reset,
  regenerate, rerun, or simulation rollback.
- **The Prompt Lab is narrator-only.** The resolved source reaches the four prose
  narrator paths and nothing else — not the reaction pulse, memory extraction,
  archivist, visual extraction, physical/contact or permission classifiers, the
  scene composer, meanwhile agents, or the successor deliberator.

## Algorithms

### Resolving one exchange's instruction source

`resolveNarratorInstructionSource(ownerId, chatId, sink)` runs **after the
exchange lock is acquired** and before any narrator prompt is built, in both
lanes, above the legacy/successor fork. Its result is reused unchanged by every
attempt in that exchange — the first call, every hidden retry, the presentation
audit, settlement and provenance.

Resolution reads the template's **current revision id** once and freezes that id.
Retries must never re-read `template → current_revision_id`: an owner saving
revision 18 between attempt 1 and attempt 2 would otherwise silently change the
prompt mid-exchange.

The successor lane gets this for free: `sim-narrator.ts` rebuilds the prompt per
attempt from one `SimRenderContext`, so carrying the source on the context
freezes it across the retry loop.

### The save compare-and-swap

One transaction, three statements:

1. `UPDATE narrator_prompt_templates SET current_revision = $base + 1, … WHERE id = $id AND owner_id = $owner AND deleted_at IS NULL AND current_revision = $base RETURNING id`.
   **Zero rows ⇒ roll back and return `prompt_conflict`.** This conditional
   update *is* the concurrency gate.
2. `INSERT` the revision at `$base + 1`. The `UNIQUE(template_id, revision)`
   constraint is an integrity backstop, not the lock.
3. `UPDATE … SET current_revision_id = $newRevisionId`.

At READ COMMITTED this yields exactly one winner: the loser's UPDATE re-checks
its predicate against the committed row, sees `current_revision != $base`, and
updates zero rows. **No `SELECT … FOR UPDATE` and no SERIALIZABLE** — the row
lock the conditional update already takes is the whole mechanism, and a preceding
`FOR UPDATE` would only duplicate it.

`body_hash` is `fnv1aHex` over the language version joined to the body, so a
future `plain_v1` body that happens to be byte-identical to a `plain_v0` one does
not collide.

## Persistence

`narrator_prompt_templates` — `id`, `owner_id` (cascade), `name`, `notes`,
`current_revision`, `current_revision_id`, `duplicated_from_id`, `created_at`,
`updated_at`, `deleted_at`.

Active names are unique case-insensitively per owner, which is a **partial**
index over a **function** and therefore cannot be a plain unique constraint:

```sql
CREATE UNIQUE INDEX narrator_prompt_templates_owner_active_name_unique
ON narrator_prompt_templates (owner_id, lower(name))
WHERE deleted_at IS NULL;
```

Soft deletion frees the name for reuse, which is the intended behavior.

Drizzle expresses this directly — `.on(t.ownerId, sql`lower(${t.name})`).where(…)`
— with two caveats for whoever reviews the generated SQL. drizzle-kit requires an
expression index to be **explicitly named**, and it cannot detect a later *change*
to the expression: editing `lower(name)` produces no diff, so that migration has
to be hand-written.

`narrator_prompt_revisions` — `id`, `template_id` (cascade), `revision`, `body`,
`body_hash`, `template_language`, `created_at`, with `UNIQUE(template_id, revision)`.

`character_chats.narrator_prompt_template_id` — nullable FK, `ON DELETE SET NULL`,
declared beside `agent_reasoning_profile`. `character_chats` is declared before
the new tables, and the inline `.references(() => …)` form handles that fine
because the arrow resolves lazily — this is the file's own idiom for a forward
reference (`characterChats.simBranchId` points at a table declared ~2,200 lines
below it). No table declarations were moved.

`updated_at` means *template metadata or head changed*, never *this prompt was
used* — generation must not touch it. Usage counts come from counting
`character_chats` rows by `narrator_prompt_template_id`, never from revisions or
timestamps.

`current_revision_id` deliberately carries **no** FK to the revisions table: a
template row is inserted before its first revision exists, so the pointer would
be unsatisfiable for the life of that transaction. The save/create transactions
are what keep it honest, and the "never observed disagreeing" invariant above is
the thing tests should assert.

Migration `drizzle/0121_puzzling_roxanne_simpson.sql`, generated and reviewed
2026-08-26: two `CREATE TABLE`s, the partial expression index, the owner and
template cascades, and the nullable `SET NULL` column on `character_chats`. It
has **not been applied** — `pnpm db:migrate` runs against a real database and the
deploy applies it. Never `drizzle-kit push`.

## Resilience

Every failure degrades to production instructions and emits a diagnostic. A
Prompt Lab experiment must never be able to dead-end a conversation.

| Trust boundary                        | Degraded default          | Diagnostic reason    |
| ------------------------------------- | ------------------------- | -------------------- |
| chat selects an id that will not load | production instructions   | `template_missing`   |
| template soft-deleted since selection | production instructions   | `template_deleted`   |
| current revision missing or unparsable| production instructions   | `revision_missing`   |
| stored `template_language` unknown    | production instructions   | `unknown_language`   |

All four carry `NARRATOR_INSTRUCTION_FALLBACK_CODE` =
`narrator_prompt_override_unavailable`. `resolveNarratorInstructionSource` never
throws.

An unknown `template_language` is **rejected**, never guessed at as `plain_v0` —
guessing is how an old handwritten prompt silently starts executing as a
template.

Context overflow follows the narrator lane's existing truthful
context-window policy. Authoritative runtime state is never silently truncated to
make a custom prompt fit.

Take provenance parses with `parseOr` and every field beyond lane/model/source is
optional, so historical takes written before this work keep loading.

## Code organization

| Path                                          | Holds                                                        |
| --------------------------------------------- | ------------------------------------------------------------ |
| `contracts/narrator-prompts/`                  | the four pure contract modules and their barrel               |
| `server/engine/prompts/charter.ts`             | classified charter units, both lanes                          |
| `server/engine/prompts/character-chat.ts`      | legacy 1:1 + ensemble node trees                              |
| `server/engine/prompts/sim-render.ts`          | successor co-present node tree                                |
| `server/engine/prompts/sim-solo-render.ts`     | successor solo node tree                                      |
| `server/narrator-prompts/`                     | owner-scoped persistence, CRUD services, source resolution    |
| `app/api/admin/self/narrator-prompts/`         | template CRUD + duplicate                                     |
| `app/api/admin/self/narrator-prompt/[chatId]/` | per-chat selection                                            |
| `app/settings/narrator-prompts/`               | the Prompt Lab page                                           |
| `components/chat/narrator-prompt-select.tsx`   | the per-conversation control and its active badge             |

The plan's package ruling stands: **no new workspace package in v1.** This work
is dominated by app concerns — owner-scoped persistence, admin routes, chat
configuration. The pure composition seam stays organized so it *could* later be
extracted; the variables/template-language follow-on is the real package
candidate.

## API surface

Every route is owner-admin and lives under `/api/admin/self`. That is not a
stylistic choice: `withOwnerAdmin` fails closed with a hidden 404 for any path
outside `OWNER_ADMIN_API_PREFIX`, so a handler placed at a bare `/api/admin/…`
would never answer. The plan's original suggestion has been corrected to match.

| Route                                                    | Answers                                                   |
| -------------------------------------------------------- | --------------------------------------------------------- |
| `GET /narrator-prompts`                                   | `{ prompts: Summary[] }`                                    |
| `POST /narrator-prompts`                                  | `201 { prompt: Detail }`                                    |
| `GET \| PATCH /narrator-prompts/:id`                      | `{ prompt: Detail }`                                        |
| `DELETE /narrator-prompts/:id`                            | `{ deletedPromptId, clearedChatIds }`                       |
| `POST /narrator-prompts/:id/duplicate`                    | `201 { prompt: Detail }`                                    |
| `GET \| PATCH /narrator-prompt/:chatId`                   | `{ selection }`                                             |

`POST …/duplicate` requires a JSON body; send `{}` when not renaming.

Refusals use the standard envelope — `404 not_found`, `409 prompt_name_taken` —
with one deliberate exception. A stale save answers
`409 { error: { code: "prompt_conflict", … }, currentRevision: N }`, carrying the
winning revision **beside** the envelope (the `identity-pack/shared.ts`
precedent) so the editor can offer reload without a second request.

Two shapes are load-bearing for the UI and worth stating:

- **`DELETE` returns `clearedChatIds`.** Soft delete clears live selections, so
  the route can report what actually happened — "N conversations fell back to the
  production prompt" — instead of a generic success.
- **`GET /narrator-prompt/:chatId` returns the whole picture in one read**:
  `{ chatId, promptId, selected, available }`. The conversation menu's picker and
  the persistent header badge both render from it, so they cannot drift, and a
  non-admin issues no request at all.

The singular `narrator-prompt/:chatId` and plural `narrator-prompts` differ by
one character. The singular is the *conversation's* setting (mirroring
`agent-reasoning/:chatId`); the plural is the *library*.

## Fixtures and tests

Pure suite:

- production render of each of the four lanes is byte-identical to the
  pre-seam builder output — the existing byte-stability and snapshot tests in
  `prompts/character-chat.test.ts` and `prompts/sim-render.test.ts` are the gate,
  and **may not be re-baselined to accommodate the refactor**;
- an override drops every `behavior` unit and keeps every other authority,
  asserted by unit id;
- the named protective clauses survive an override in all four lanes;
- numbered lists renumber contiguously under an override.

Integration suite (needs Postgres):

- a stale save returns `prompt_conflict` and inserts no revision;
- cross-owner read and write both fail;
- soft delete clears live selections and resolution then degrades with the
  diagnostic;
- a duplicate is independent of its source.

Per `.claude/skills/vesper-testing/`, these are the invariants worth permanent
tests; coverage of the UI panes and of routes that only re-express a service call
is deliberately not added.
