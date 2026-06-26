# Social-reaction cards — plan

Status: **shipped — 2026-06-26** (core feature 2026-06-25; the library-reuse UI slice —
CRUD + page + builder + import/save + public discovery gallery — 2026-06-26; see the
"Deferred slice — library-reuse UI" section for the per-step record).

## Completion note (2026-06-25)

Shipped: the card contracts (`contracts/personality/cards.ts` — `SocialReactionCard`,
`severityToTier`, the tier→intensity ramp, `ReactionKind`→valence, `resolveCardForTags` /
`resolveCardReaction`); the `resolveSocialReaction` card branch riding the §6 curve; all three
call sites wired (`merge.ts`, `scene.ts`, world-less `chat-state.ts`); the witnessed-breach
path (continuity `normBreaches` → `cardBreaches`, `planCardBreachReactions` folding per-witness
affinity through the curve + directives); the freeform-norms surface fully removed; the
world-forge proposing cards; and inline card authoring in the world editor + character
Disposition tab (`components/personality/social-cards-editor.tsx`, incl. the tag-override
flip).

**Two refinements to the design below, made at build time:**

1. **Inline storage over join + instance tables.** Because `world.style` is read **live**
   each turn (never snapshotted into the session), world cards live **inline** on
   `worldStyle.socialCards` and character cards on `CharacterProfile.socialCards` (both
   snapshot-copy arrays, riding the existing live-read + participant-snapshot cascade). This
   replaces the planned `world_social_cards` join and the "frozen session array" — no spawn
   changes, no instance table. The **`social_cards` library table** (DB migration `0014`)
   ships as the cross-world reuse store, but its **CRUD API + standalone library page +
   cross-world import picker + clone UI is the one deferred slice** (the table is in place;
   inline authoring + forge proposals deliver the core value, like the world-map slices).
2. **Single-severity card model.** A card carries one `severity` → one tier → one ramped
   intensity (decided ruling), so `defaultReactions: Record<Tier, …>` collapsed to a single
   optional `defaultReaction` (+ `reactionOverrides`); per-tier maps were redundant once the
   §6 curve does the affinity-bending. The card emits a `SocialReaction`, not raw deltas.

Carried-forward open questions (now build-time follow-ups): the deferred library-reuse UI;
the three-layer precedence is implemented as **character cards before world cards** (first
matching card governs); severity thresholds use the companion-app 26/51/76 (playtest-tunable).

## Deferred slice — library-reuse UI (build plan, 2026-06-26)

This is the one remaining slice (top of `roadmap.md` → Next). The `social_cards` table
shipped (migration 0014, full library shape — owner/visibility/clonedFromId/searchEmbedding);
what's missing is the **reuse surface** around it. **Decisions taken 2026-06-26:**
**(a) full surface** — CRUD API + standalone library page + a dedicated **card builder** +
cross-world import picker + per-character attach + clone + save-to-library + a **public browse
gallery** (cross-account discovery); **(b) full semantic search** (wire `social_card` into the
memory/embedding module like items); **(c) imported cards keep unknown-tag overrides as-is** — a
`reactionOverride` keyed on a tag absent from this account's registry is a silent no-op until a
character carries that tag (no validate-on-import friction; consistent with the immutable-snapshot
model).

**Slice progress (2026-06-26): shipped — all 7 steps built + `pnpm verify`-green + int-tested.**
The library-machinery wiring, CRUD API, standalone page + card builder (with live reaction
preview), import/attach + save-to-library on the inline editor, the public discovery gallery
(scope query, debuted on cards), and tests/docs all landed. The auth.plan.md "public browse
gallery + clone UI entry point" deferral graduated here (cards-first; the other shareable kinds
pass `scope` through but their list API still ignores it — the fast-follow).

> **Storage note — read this before the superseded "Storage & import" section below.** Cards
> ship **inline**, not in join tables (completion-note refinement #1). The `world_social_cards`
> / `character_social_cards` joins, the `materializeWorldEntities`-style copy, and the frozen
> session-bundle array described under "Storage & import" were **not built and are not the
> design** — a world's cards live on `worlds.style.socialCards`, a character's on
> `characters.profile.socialCards`, both edited by the shared `SocialCardsEditor`
> (`components/personality/social-cards-editor.tsx`) via a plain `onChange` array. So **import
> / attach = snapshot a `social_cards` library row into that inline array** (append a fresh-id
> copy), and **save-to-library = the reverse** (promote an inline card to a `social_cards`
> row). There is no join to write.

Build order for the slice (each step reuses the **items** library as its template):

1. **[done 2026-06-26]** **Wire `social_card` into the shared library machinery.** `"social_card"`
   added to `ShareableKind` (`server/api/visibility.ts` `findViewable` + `server/api/clone.ts`
   `cloneToLibrary`, no image step — cards carry none) and to `LibraryKind`
   (`server/memory/library-search.ts` — both `TABLE_NAMES`, `searchTextFor`, `fuzzyResolve`;
   `server/api/library.ts` `TABLE_NAMES`); cards get semantic search (decision **b**).
2. **[done 2026-06-26]** **CRUD API.** `GET/POST /api/social-cards`,
   `GET/PATCH/DELETE /api/social-cards/[id]`, `POST /api/social-cards/[id]/clone` — mirror
   `app/api/items/**`. `definition` holds the mechanical fields (`socialCardExtrasSchema` =
   `socialReactionCardSchema.pick(kind/triggers/severity/defaultReaction/reactionOverrides)`);
   `label`→`name`, `description`→column, fresh `id` per row. **List is owner-scoped today** (public
   discovery is step 6). Embedding refreshed on create/update; `parseOr` at the boundary.
3. **[done 2026-06-26]** **Standalone library page + card builder.** Add `"social-cards"` to `EntityLibrary`'s
   `LibraryEntity` union + a **`shareable: true`** config (`components/library/entity-library.tsx`) —
   so it gets the All/Public/Owned toggle (wired live in step 6) and the publish toggle. A
   `/social-cards` grid + a **card builder** at `/social-cards/new` & `/social-cards/[id]`: reuse
   `SocialCardsEditor`'s per-card controls (kind, trigger-concept multi-select from
   `interactionConceptIds()`, severity slider, default reaction, the `reactionOverrides` tag-flip on
   `dispositionTags`) for the mechanical fields, wrapped with library-row chrome
   (name/description/tags + a `PublishToggle`) and a **live reaction preview** (`severityToTier` →
   `tierIntensity`/`tierDefaultKind`, plus "a character tagged X → …" so the author watches the
   foot-fetish flip resolve). Cards have no image — skip the batch-image affordances. Add a
   `social_card` case to `publish-toggle.tsx`'s local `ShareableKind` + a `socialCardsApi` client.
4. **[done 2026-06-26]** **Import / attach pickers (snapshot into inline arrays).** Add a pure **library-row → inline
   `SocialReactionCard`** snapshot helper in `contracts/personality/cards.ts` (compose from the
   row's `definition`, mint a new id). Surface a `LibraryPickerDialog` "Import from library" next
   to the inline `SocialCardsEditor` in **both** the world editor (writes `style.socialCards`) and
   the character Disposition tab (writes `profile.socialCards`). Unknown-tag overrides accepted
   as-is (decision **c**).
5. **[done 2026-06-26]** **Save-to-library (reverse).** A "Save to library" action on each inline card row →
   `POST /api/social-cards`, so forge-/inline-authored cards become reusable. (Clone-on-use is
   the clone route from step 2.)
6. **[done 2026-06-26]** **Public browse gallery (graduates the auth.plan.md deferral).** `EntityLibrary`'s
   All/Public/Owned toggle exists but is **visual-only** — the public-browse query was deferred
   app-wide (`finished/auth.plan.md` → "public browse gallery + clone UI entry point"; see the
   `scope` comment in `entity-library.tsx:193`). Implement it here, **debuting on cards**: a `scope`
   (`all`|`public`|`owned`) param on `GET /api/social-cards`, backed by an **owner∪public /
   public-only** `searchLibraryIds` variant (extend `LibrarySearchOptions` with `scope` + the viewer
   id so other owners' public rows return), threaded through `EntityLibrary`'s `config.list`
   (`(q, tag)` → `(q, tag, scope)`) and `socialCardsApi.list`. The **clone entry point** = a "Clone
   to my library" action on a public card's tile/detail → the step-2 clone route. The
   `searchLibraryIds` scope change is **shared infra** — it lights the same toggle for
   characters/locations/items the moment their `config.list` passes `scope` (see Open questions:
   generalize-now vs cards-first).
7. **[done 2026-06-26]** **Tests + docs.** CRUD/clone/visibility **+ public-scope** int tests (mirror
   `library.int.test.ts`); the snapshot-helper unit test. Update `database.md` (drop the "deferred
   slice" caveat on the `social_cards` row), `authoring.md`, `contracts/relationships.md`, and note
   the public-gallery graduation on `roadmap.md` (the Auth Shipped entry's "Deferred" line) +
   `auth.md` if it tracks the deferral.

---

(Original plan, design carried inline below.) **Ready to build** — every dependency has shipped:

- the personality §6 resolution seam (`resolveSocialReaction(act, {…, cards})`, shipping
  with `cards: []`) shipped **2026-06-18** (`finished/personality-and-state.plan.md`); and
- **Mood** shipped **2026-06-24** (`finished/mood.plan.md`), so the §6 response curve now
  carries **real** affinity **and** mood (it was a neutral stub when this plan was first
  drafted, 2026-06-19). This plan fills the live `cards` argument — see
  **Reconciliation with shipped work** below for what that changed.

Context: [finished/personality-and-state.spec.md](finished/personality-and-state.spec.md)
§6 (the seam this feeds) / §10 (what this removes). Reference implementation: the
companion-app `taboo-reaction-engine.ts` + `world-lore-schemas.ts` (`TabooCard`,
`severityToTabooTier`, `resolveWitnessReaction`) — **adapted, not ported verbatim** (the
companion-app cards carried raw affinity/mood deltas; Vesper now resolves everything
through the §6 curve — see the card model).

## Goal

Replace today's freeform `world.style.norms` with **importable social-reaction cards**
(taboos + social rules) — **library content, reusable across worlds like items** — that
resolve **deterministically** with per-character **tag overrides**, feeding two consumers:

1. the personality **`resolveSocialReaction`** seam (§6) — the player→target reaction; and
2. the **witnessed-breach** reactions across *all* present NPCs — the deterministic
   replacement for the continuity agent's freeform `normBreaches` path.

## Reconciliation with shipped work (2026-06-25 review)

The seam and its dependencies shipped between this plan's first draft and now. The current
code (verified 2026-06-25) differs from the original draft in four load-bearing ways — the
card model below is rewritten to match:

1. **The reaction shape is fixed, and it is not the companion-app shape.**
   `resolveSocialReaction` returns a **`SocialReaction`** — and that type already reserves a
   card source (`src/contracts/personality/reactions.ts:19`):
   ```ts
   interface SocialReaction {
     conceptId: string;
     valence: "like" | "dislike";   // PreferenceValence
     intensity: number;              // 1–10 base magnitude
     hint: string;                   // narrator flavour
     source: "preference" | "card";  // "card" already anticipated
   }
   ```
   A matched card **must produce a `SocialReaction`** (with `source: "card"`), which then
   rides `evaluateSocialReaction` → the §6 curve. **Cards therefore do NOT carry raw
   `affinityDelta`/`moodDelta`** (the companion-app shape) — the curve computes the affinity
   delta from `intensity × affinity × mood × traitScale`, clamped at the merge. The
   placeholder `SocialReactionCard { id }` (`reactions.ts:35`) and the `cards: readonly
   SocialReactionCard[]` field on `DispositionSources` are the stubs this plan fills.

2. **Mood is real, not a stub.** `evaluateSocialReaction(reaction, affinity, μ, traitScale)`
   takes a real mood factor (`moodMeterToFactor(meterValue)`) at every call site, and the
   merge already applies a **`moodNudge(evaluated)`** to the target's `mood` meter alongside
   the affinity delta. So a card reaction **automatically moves mood** the moment it rides
   the curve — there is no separate card mood-delta to build (this retires a "Not in scope"
   item; see below).

3. **There are three call sites now, not one.** `resolveSocialReaction` is called from:
   - `server/engine/merge.ts` → `planReactionAffinity` (session player→NPC apply);
   - `server/engine/scene.ts` → `buildReactionLine` (pre-narration reaction line); and
   - `server/engine/chat-state.ts` → `applyChatPulse` (**sessionless 1-on-1 character
     chat**, shipped 2026-06-24).
   The first two have a world → get world cards. **Character chat is world-less** — it reads
   only `CharacterProfile`; resolved 2026-06-25 by giving each character its own **default
   card set** (Storage & import), so chat resolves the character's cards instead of `[]`.

4. **The witnessed-breach affinity path is new, not a re-point.** Today the merge turns each
   continuity `normBreach` into a **correction string → directive** only — it touches no
   affinity (`merge.ts:1437-1450`). Re-pointing it to `cardBreaches` re-uses that directive
   plumbing, but *folding a witness affinity delta through the §6 curve is genuinely new
   behaviour built on top* — call it out as such, not as a rename.

## The card model

`SocialReactionCard` (fills the placeholder at `reactions.ts:35`; mirrors companion-app
`TabooCard` but **emits a `SocialReaction`, not raw deltas**):

```ts
type Tier = "odd" | "disapproval" | "shunning" | "ostracized";

type SocialReactionCard = {
  id: string; label: string; description: string;
  kind: "social_rule" | "taboo";          // authoring/UX bucket; mechanics unified by severity
  triggers: string[];                       // concept ids from the shared vocabulary — NOT free keywords
  severity: number;                         // 0–100 → tier (severityToTier)
  defaultReactions: Partial<Record<Tier, CardReaction>>; // tier → reaction
  reactionOverrides: Array<{ tag: string; fromTiers: Tier[]; toReaction: CardReaction }>;
};

// What a card yields — maps onto SocialReaction, NOT a companion-app flat delta:
type CardReaction = {
  kind: ReactionKind;   // revulsion | disapproval | shunning | fear | accepting | enjoy | kindred_spirit | indifferent
  valence: "like" | "dislike";  // derived-from / co-stored with kind (indifferent ⇒ resolves to null)
  intensity: number;    // 1–10 base magnitude the §6 curve scales
  hint: string;         // → SocialReaction.hint (the narrator flavour, was `prompt`)
};
```

- **Triggers are concept ids** (the `interactionConcepts` vocabulary,
  `contracts/personality/interactions.ts` — 13 concepts today), so **intake's
  classification is the trigger** — no second free-text keyword path to drift. Grow the
  vocabulary as taboos require non-interpersonal acts (e.g. `public_exposure`,
  `consumption_taboo`); see Open questions.
- **`reactionOverrides` key on canonical tags** (`contracts/personality/tags.ts` — 17 tags
  today, incl. `foot-fetish-positive`, `prudish`, `exhibitionist`) — the **foot-fetish
  flip**: a `foot-fetish` taboo defaults to revulsion, but a character tagged
  `foot-fetish-positive` overrides to *enjoy* (`{ valence: "like", … }`).
- **No `affinityDelta`/`moodDelta` on the card.** A matched card returns a `SocialReaction
  { valence, intensity, hint, source: "card" }`; `evaluateSocialReaction` then applies the
  affinity- and mood-aware curve (goodwill deadband, hostility amplification, trait scale,
  the ±`AFFINITY_DELTA_CLAMP` clamp) **and** the `moodNudge` — identical to how a bespoke
  preference resolves. One curve, one source of truth.
- **Severity sets intensity via a fixed tier ramp (decided 2026-06-25).** The author sets a
  single `severity` (0–100); `severityToTier` buckets it, and a fixed ramp derives the base
  `intensity` the §6 curve scales: **odd→2, disapproval→5, shunning→8, ostracized→10**. No
  per-tier authored intensity — one number per card. A `reactionOverride` may flip the
  `kind`/`valence` (the foot-fetish enjoy) but inherits the from-tier's ramped intensity.
- Port one pure helper, **`severityToTier`** (companion-app), into `contracts/`. The
  companion-app `resolveWitnessReaction` is **re-expressed** as "resolve the witness's card
  reaction → `SocialReaction` → run the §6 curve per witness," not ported as a flat-delta
  function (see Resolution #2).
- The `ReactionKind` → `valence` mapping is a small fixed table (revulsion/disapproval/
  shunning/fear → `dislike`; accepting/enjoy/kindred_spirit → `like`; indifferent → no
  reaction, `null`). Keep `kind` for authoring richness + the EmotionLabel beat; `valence`
  is what the curve consumes.

## Storage & import (the library pattern)

Cards are library content (mirroring `items`), and the load-bearing rule the user set
(2026-06-25) is **immutable, copy-at-every-layer**: a card is a fixed rule (like a board-game
rule tweak) with **no per-session mutable state**, and every layer that *uses* a card holds
its **own snapshot copy** so an owner editing or deleting the source library card never
reaches into a world, session, or character already using it (the `world-instances` cascade).
So there is **no `social_card_instances` table** — sessions read a frozen snapshot array.

- **`social_cards`** library table (user-owned) — columns mirror `items`: `id`, `ownerId`,
  `name`, `description`, `definition` (the card JSONB: kind/triggers/severity/reactions/
  overrides), `tags`, **`visibility` (`private`|`public`)** + **`clonedFromId`** so cards are
  shareable and clone-on-use exactly like items (`server/api/clone.ts` `cloneToLibrary`,
  `server/api/visibility.ts` `findViewable`). Optional `searchEmbedding`/`embedder` if cards
  join library search.
- **`world_social_cards`** join — mirrors `world_items` **minus the placement columns**
  (cards are world-global rules: no location/cast/worn/container/quantity). Just `worldId`
  (FK cascade), `sourceCardId` (soft, no FK), `sourceStampedAt`, `name`, `snapshot` (frozen
  card JSONB). Materialized by a `materializeWorldEntities`-style copy
  (`server/api/worlds.ts`), name-matched on save like items.
- **Character default cards (new scope, decided 2026-06-25).** A character carries its own
  small set of default cards — its *personal* lines/taboos — so they apply in the
  **world-less character chat** and travel with the character into any world. Store them as
  **snapshot copies on the character** (a `character_social_cards` join with a `snapshot`
  column, or a `defaultCards` snapshot array on the `CharacterProfile` JSONB — pick at build,
  leaning the join for parity with `world_social_cards`). Attaching a library card to a
  character **snapshots a copy**, same copy-on-use rule as worlds. The character forge/editor
  proposes/attaches these.
- **Session read (frozen array, no instance table).** At spawn, snapshot the world's cards
  **plus each cast member's default cards** into the **session bundle** as a read-only array
  (consistent with "spawn is a full instantiation," no live library join). Cards never
  mutate during play, so there is nothing to instance.
- DB workflow per `CLAUDE.md`: `schema.ts` → `pnpm db:generate` (human-run if it prompts) →
  review `drizzle/` → `pnpm db:migrate`.

## Resolution — two integration points

**1. Player→target reaction (personality seam).** Pass the effective card set into
`resolveSocialReaction(act, { tags, preferences, cards })` at all three call sites (replace
their `cards: []`):

- **Session** (`merge.ts:planReactionAffinity`, `scene.ts:buildReactionLine`) — `cards` =
  the world's cards **∪ the target NPC's default cards** (both already snapshotted into the
  session bundle).
- **Character chat** (`chat-state.ts:applyChatPulse`, world-less) — `cards` = the
  **character's own default cards** only (decided 2026-06-25: characters carry a default card
  set, so chat is no longer `cards: []`).

Precedence is already specced and is **pure override**: bespoke preference → card
tag-override → card default → none. A card match returns a `SocialReaction { source: "card" }`
that rides the **same `evaluateSocialReaction` curve** as a preference, so affinity + mood +
trait scale + clamp all apply unchanged. (When both world and character cards match the same
concept, the **character's own card wins** — the personal line is more specific than the
society's; see Open questions for the exact ordering.)

**2. Witnessed breach (replaces continuity `normBreaches`).** A card-triggering act seen by
present NPCs makes **each witness react by their own tags**:

- **Detect** — re-point the continuity agent's `normBreaches` slot
  (`contracts/turns/agent-results.ts:150-182`) to **`cardBreaches`**: swap the freeform
  `normRule` string for a matched **card id (+ concept)**; the witness names it already
  emits stay. Update the continuity prompt (`engine/prompts/agents.ts:59-80` + the norms
  block in `buildContinuityPrompt`, ~`:219-227`) to flag breaches of the world's cards.
- **Resolve** *(merge, deterministic)* — for each eligible witness, resolve the card to a
  `SocialReaction` for that witness's tags (the foot-fetish flip applies per witness), then
  run **`evaluateSocialReaction` with that witness's own affinity + mood + traitScale** →
  fold the resulting delta into that **witness→player** edge and the `hint` into the
  next-turn directives (re-using the `normBreach → corrections → directives` plumbing at
  `merge.ts:1437-1450`). **The per-witness affinity fold is new behaviour** (today's path
  emits directives only).
- **Witness eligibility** is perception-gated — reuse `computeWitnessSet`
  (`merge.ts:~2273`, which calls `perceives` in `contracts/perception/witness.ts`); a
  witness is eligible iff present **and** they perceived the act (the analog of
  companion-app's exposure-gated `defaultEligibleWitnesses`).

**Narrator surfacing.** Cards relevant to present characters surface as **scene guidance**
in the turn context so the narrator plays the social fabric proactively — distinct from the
post-turn breach detection (today norms reach *only* the continuity agent, never the
narrator, so this is a net-new narrator surface). Stable cards ride the cached prefix;
per-turn breach directives ride the volatile tail. The matched-act `SocialReaction` also
becomes the EmotionLabel **beat** (`deriveEmotionLabel` already takes a `reaction?:
EvaluatedReaction`) — so a witnessed taboo can flash the right face for free.

## Forge & editor

- **World forge** proposes a starter card set for a premise (replacing today's norm
  generation, `server/authoring/world-forge.ts`) — pulled from a common-card library +
  bespoke.
- **Editor** — a card library view + a per-world card picker (reuse `LibraryPickerDialog` /
  `entity-library.tsx`, the same components the item picker uses) + tag-override authoring on
  each card. Character forge already proposes the **tags** these cards key on (personality
  Slice 1, `contracts/personality/tags.ts`).

## Removals when this ships (personality §10 — prefer removal over deprecation)

Line numbers verified 2026-06-25:

- `worldNormSchema` + `world.style.norms` — `contracts/world/profile.ts:98-113` (schema at
  98-102; `norms:` nested in `worldStyleSchema` at ~112). Today's severity is a 3-value enum
  `["odd","disapproval","outrage"]`; just deleted (no migration to map it onto the card
  tiers).
- The World-editor **Norms** UI — `components/worlds/world-editor.tsx:256-305` (PremiseTab
  Norms section: rule input + severity select + remove + "add norm").
- World-forge norm generation — `server/authoring/world-forge.ts`: `norms` in
  `premiseSectionSchema` (~`:130-138`), the "1-4 social norms" instruction (~`:142`), and the
  generation/assignment path (~`:155-182`).
- The continuity agent's freeform `normBreaches` schema + path — `contracts/turns/
  agent-results.ts:150-182` (schema), `engine/prompts/agents.ts:59-80` + `:196` +
  `buildContinuityPrompt` ~`:219-227` (prompt), `engine/merge.ts:1437-1450` (the
  breach→correction→directive loop) — **re-pointed** to `cardBreaches`, not merely deleted.
- **Migration** of existing `world.style.norms`: **drop, no backfill** (decided 2026-06-25 —
  dev has no real users). Delete the field, the editor UI, the forge generation, and the
  continuity path outright; no data migration. Seed a starter card library instead (Build
  order 6).

## Build order

1. **Card model + pure helpers** — fill `SocialReactionCard` (concept triggers, canonical-tag
   overrides, tier→`CardReaction`) in `contracts/personality/` (co-located with the seam it
   feeds); port `severityToTier`; add the `ReactionKind → valence` table; teach
   `resolveSocialReaction` the card-precedence branch (preference → card override → card
   default → null) so a card match returns a `SocialReaction { source: "card" }`. Tests
   (precedence, the foot-fetish flip, the curve runs identically for a card source).
2. **Storage + spawn** — `social_cards` + `world_social_cards` + character default-card
   storage (`character_social_cards` join, or a profile `defaultCards` array), all with
   snapshot copies (+ visibility/clone fields on the library table); snapshot the world's
   cards **and each cast member's default cards** into the session bundle as frozen arrays.
   DB workflow.
3. **Wire the personality seam** — pass the effective card set into all three
   `resolveSocialReaction` call sites: world ∪ NPC-default cards in session (`merge.ts`,
   `scene.ts`), the character's own default cards in chat (`chat-state.ts`). Player→target
   reactions now honour the fabric (with character-card-wins precedence).
4. **Witnessed-breach path** — re-point continuity `normBreaches` → `cardBreaches`; merge
   resolves perception-gated witness reactions through the §6 curve → per-witness affinity +
   directives (new affinity fold).
5. **Forge + editor** — world-card proposals; card library + per-world picker (reuse the item
   picker components) + per-character default-card attach + tag-override authoring.
6. **Removals + seed** — delete the freeform norms surface (above); **no norm migration**
   (dropped); seed a starter card library.
7. **Tests + docs** — pure helpers + resolution precedence + witness gating + degradation;
   docs `contracts/relationships.md` (or the personality contract doc), `turn-engine.md`,
   `database.md`, `authoring.md`, `perception.md` (witness reuse), and personality §10 (mark
   removed).

## Open questions

**Resolved 2026-06-25** (rulings now live in the cited sections; dropped from the open list):
- *Card → `SocialReaction` mapping* → cards emit a `SocialReaction` riding the §6 curve, not
  raw deltas; the `ReactionKind → valence` table + the **fixed tier→intensity ramp**
  (odd→2 / disapproval→5 / shunning→8 / ostracized→10) are the card model. · *Witness delta
  path* → run each witness through the **§6 curve** (per-witness affinity + mood). ·
  *Session storage* → **frozen snapshot array on the session bundle**, no
  `social_card_instances` table (cards are immutable; copy at every layer). · *Character chat
  & cards* → **characters carry a default card set** (snapshot copies), live in chat and
  merged with world cards in session. · *`world.style.norms` migration* → **drop, no
  backfill**. · *Type name* → keep **`SocialReactionCard`** (fill the placeholder, don't
  rename to `SocialCard`). · *Tag registry scope for imported/shared cards* (resolved
  2026-06-26) → **accept unknown-tag overrides as-is** (silent no-op until a character carries
  the tag; no validate-on-import — see the deferred-slice build plan, decision **c**).

**Still open:**
- **Card precedence ordering.** With three layers now (bespoke preference, character default
  card, world card), confirm the override chain. Proposed: bespoke preference → **character
  card override → character card default** → **world card override → world card default** →
  none (most-personal wins; the character's own line beats society's). Does a character's
  *default-tier* card outrank a world *override*-tier card, or should tier severity break
  ties across sources?
- **Severity → tier thresholds** — reuse companion-app's (26/51/76), or re-tune to Vesper's
  affinity scale + the §6 curve? (Playtest-tunable; not a v1 blocker.)
- **Public-browse query: generalize now or cards-first?** (resolved 2026-06-26 → **cards-first,
  fast-follow**) Step 6's `searchLibraryIds` scope variant is shared infra — once it lands, the
  only thing standing between characters/locations/items and a live discovery gallery is passing
  `scope` through their `config.list`. Ruling: **build the query generally, wire cards'
  `config.list` first, leave the other three for a quick follow-up** so the cards slice isn't
  gated on auditing every kind's gallery. (This graduates the auth.plan.md deferral — record it
  there when step 6 lands.)

## Not in scope

- The personality **preference loop** (its own shipped plan) — this supplies only the card
  layer.
- ~~**Mood deltas** from cards beyond the affinity path — fold in with the mood slice~~
  **(retired)** — Mood shipped 2026-06-24; a card reaction rides the curve's `moodNudge`
  automatically, so there is no separate card mood-delta to build.
