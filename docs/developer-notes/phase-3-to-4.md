# Phase 3 → phase 4 — doc-split migration plan

Status: **plan** (2026-06-13) — a one-off migration plan, not a working-phase
plan. It says how to cut the overloaded `.phase3.md` corpus into a strict
phase 3 plus a real phase 4 (and to push the steps-5/6 specs out of phase 3's
way). Execute the steps below, then delete this file or mark it completed.

## Update 2026-06-13 (open-question rulings)

The phase-3-plan open questions were answered. Net effect on this plan:

- **Scope narrowed.** Phase 3 is now settled as **presence & perception v1
  only** — narrower than this plan's original "presence + romance-core
  proximity." The romance-core proximity slice (tiers / engagement / scale
  gating / staging) moves to **phase 4**, *except* the minimal proximity
  *primitive* presence's `sight` channel needs — the tier ladder +
  scale-derived tier existence + entry defaults — which rides phase 3 (ruled
  2026-06-13). Comms ships its channel + player-side in phase 3; NPC-initiated
  comms defers to phase 4.
- **Pairwise NPC↔NPC awareness (co-located)** is confirmed **in phase 3** and
  maintained every turn; cross-location off-camera awareness defers to phase 5.
- **Product direction:** Vesper stays able to be a **full NSFW RPG** when a user
  wants one. The Bucket-1 items below are therefore *deferred / deprioritized
  for the romance-first path, not deleted from the engine.*

## Why this exists

The `.phase3.md` suffix is **overloaded**. Per the naming convention a
cross-phase doc carries the suffix of the phase where its *remaining* work
lives — but the whole multi-character corpus got stamped `.phase3.md` as the
parking suffix when phase 3 became the next working phase. In reality the
[overview](multi-character-overview.phase3.md) build order is six steps, and
phases 1–2 ([phase-2-plan.md](phase-2-plan.md), completed 2026-06-12) only
shipped step 1 + pulled-forward low-hanging fruit. The remaining content spans
**four** future working phases:

| Build-order step | Working phase | Primary spec(s) |
| --- | --- | --- |
| 2 — presence & perception (+ proximity romance-core) | **phase 3** | presence-and-perception, proximity (part), location-design (part), cast-tiers first-impressions |
| 3/4 — proximity remainder + movement | **phase 4** | npc-movement, proximity (movement-coupled part), time-and-travel leftovers, location-design (ownership/access), emergent-cast phase 1 |
| 5 — off-screen simulation | phase 5 | offscreen-simulation |
| 6 — character memory | phase 6 | character-memory |

The phase-3-plan today still says "presence & perception v1, or more — decide
at phase start" and nests *every* spec under itself. The decision this migration
encodes: **phase 3 is presence/perception v1 + the romance-core slice of
proximity, and nothing else.** Movement and everything downstream become
phase 4+.

## Bucket 1 — romance-relevant vs general-RPG cruft

Vesper is an intimate-romance product, not a broad-cast/combat RPG. Several
specs inherit reverie's general-engine ambition. Flag these **before** moving
them, because they should be deprioritized for the romance-first path (deferred,
**not deleted** — see the 2026-06-13 note above):

**Keep — core to romance** (these justify the whole presence/proximity build):
- Attention × salience witness matrix — *who perceives what during intimacy* is
  the product. Includes the "quietly to a lover ≠ stealth" concealment-target
  carve-out (decision 14).
- Presence channels (sight + comms) + reference-vs-enact — keeps a two-person
  private scene actually two-person.
- Proximity tiers `contact`/`entwined` + engagement detail — the intimacy-staging
  spine.
- First impressions (attraction seeding), affinity stages + perceived affinity
  (shipped).
- Darkness + `senseEffects`, time-banded ambient light — night/candlelight/
  blindfold staging.
- Approach/social/follow drives — the love interest crosses the room to greet
  you / comes to find you. Comms (texting/calling a love interest).
- Character episodes + perspective memories (phase 6) — her colored recollection
  of an intimate moment. Highest romance value in the late phases.
- Per-location forge, ownership cheap uses ("her apartment" for consent framing).

**Defer — lower priority for the romance-first cut, kept on the roadmap** (don't
carry into the phase-4 plan as committed scope; record as deferred in the owning
spec — Vesper stays able to be a full NSFW *RPG*, so these are deprioritized, not
deleted):
- Non-human senses (scent/tremorsense), sense-acuity profiles.
- Full NPC-side sound channel (hear-through-walls, eavesdropping, guard-
  investigates) — keep only the cheap *player-side* adjacent-sound line.
- Player-unperceived hidden-acts path (pickpocket/poison) — already v2.
- Contested-transition seeded-roll banding (combat-y) — but **extract the
  consequence loop**: a rebuffed advance → affinity hit + memory is romance-core.
- Factions / faction propagation; algorithmic tier drift; template-instanced
  extras (mob spawning); multi-party/group engagement composition; NPC↔NPC group
  staging.
- LOD tiering machinery for a large absent cast + background-town simulation —
  descope phase 5 to "tick the 1–few love interests," skip the tier engine.
- Lore knower scopes; covert shadowing; witnessed-events drive; crowding scorer;
  travel-speed modifiers (mounts/injuries); elaborate needs-routing; weapon/item
  reach; area-hierarchy big-map/district motivation (keep only the home-with-rooms
  slice); encounter hints / norm overlays / location perception hints.

## Bucket 2 — strictly phase 3

"Perception done right for intimate scenes." The irreducible core:

- **Presence channels** sight + comms (present/absent), replacing the interim
  co-location roster shipped as followups.phase2 #13.
- **Attention × salience witness matrix** + awareness blocks (incl. terse NPC↔NPC
  lines, decision 26); concealment-target carve-out (decision 14).
- **Witness-set computation** post-turn — real `witnessed_by` values replacing the
  interim co-location stamp.
- **Two new continuity-violation classes**: `narrated_absent_character`,
  `reacted_to_unperceived_event`.
- **Darkness** (time-of-day × location light) + `senseEffects` on conditions
  (decision 24); player-side adjacent-sound line (decision 27).
- **Banded ambient light** (location-design) — the one location-design piece that
  rides phase 3, because it feeds darkness as authored truth (no new column;
  `ambient.light` exists, only `byBand` is new).
- **First impressions** channel-fidelity seeding (decision 43) — must land with
  presence or it contradicts the channel model; romance-core.
- **Proximity romance-core slice**: tier ladder (`distant…entwined`) + adjacent-step
  validation, engagement detail on `contact`/`entwined`, location-`scale` entry
  defaults + conversation gating, `proximityEvents` simulant field, implicit
  transitions, a minimal Turn Inspector staging readout.
- **Comms v1, minimal**: runtime link + `commsEvents` + pending-messages context
  line. (NPC-*initiated* comms escalation needs the world-tick/director — defer.)
- Schema/contract: `contracts/perception/` module, `simulant` proximityEvents +
  salience, `attentionHint?` on items, `encounteredParticipantIds` semantics →
  full encounters only.

**Phase-3 stretch / phase-4-safe** (cheap, witness-set-dependent — land in 3 if
witness sets are solid, else 4): norm-stance → affinity merge rule (jealousy /
witnessed-intimacy); library-character `tier` field.

## Bucket 3 — defer to phase 4 (movement) and re-suffix steps 5–6 out of phase 3

**Phase 4 — "the world moves":**
- **npc-movement** engine in full: drives (schedule/needs/social/goals),
  traversal/pathfinding/LOD, commitment, world-tick *proposals*, approach scores,
  follow schedule-conflict term, companion travel atomicity. (Player-side access +
  arrival/departure staging already shipped in phase 2.)
- **movement-authority** ([spec](movement-authority-spec.phase4.md), drafted
  2026-06-13 from a broken session): the precondition npc-movement's traversal
  assumes — who may *commit* a movement (player narration must not relocate NPCs),
  implied sub-rooms must not promote to graph hops, and multi-hop player intent
  must route one hop instead of dropping. Its open questions (authority mechanism,
  co-travel adjudication, implied-room modelling, partial-traversal granularity)
  belong in the phase-4 plan when it is authored (step 3 below).
- **Proximity movement-coupled remainder**: the movement-lock + `entwined` merge
  invariant (its consumer is the movement scorer), and contested transitions
  (extract the consequence loop per Bucket 1; the seeded-roll banding is optional/
  descopable).
- **time-and-travel leftovers**: mid-action interruptions, partial-traversal brief
  note (both want real multi-hop arrivals).
- **location-design remainder**: ownership cheap slice + owner↔private-link
  reconciliation (the phase-3 open question that *blocks* phase-4 access
  enforcement), full link access model (`private` discourages NPC pathing),
  per-location forge if authoring UX is the pain.
- **emergent-cast phase 1** (provisional cast) — *demand-dependent*; validate in
  phase-3 play that rivals/confidants/exes actually emerge before building. Phases
  2–3 of emergent-cast (async enrichment, polish) defer to phase 5+.

**Steps 5–6 — push out of phase 3, not into phase 4:**
- offscreen-simulation → phase 5 (descoped per Bucket 1).
- character-memory → phase 6. Exception: the write-only `witnessed_by` stamp
  *becomes real* in phase 3 when witness sets land — that part is already phase 3.

## Per-doc disposition

| Doc | Disposition |
| --- | --- |
| `phase-3-plan.md` | **Rewrite** as the real, strict phase-3 plan (Bucket 2). Remove the "or more" candidate-scope language and the nesting of non-phase-3 specs. |
| `presence-and-perception-spec.phase3.md` | **Stays phase 3.** Add a status note scoping out the already-v2 items (full sound channel, NPC-initiated comms escalation, player-unperceived path) to phase 4. |
| `proximity-spec.phase3.md` | **Split.** Romance-core → phase 3; movement-lock + contested checks → phase 4. Keep `.phase3.md` until phase 3 ships (it has phase-3 work), with a "Phase split" note delineating the phase-4 sections; re-suffix the leftover to `.phase4.md` when phase 3 closes. |
| `cast-tiers-and-affinity-spec.phase3.md` | **Mostly shipped.** First-impressions stays phase 3. Add a note that factions/tier-drift/extras/promotion are deferred general-RPG (Bucket 1) and re-suffix that remainder later. |
| `location-design-spec.phase3.md` | **Split.** Banded ambients → phase 3; ownership/access-reconciliation/per-location-forge/area-hierarchy → phase 4. Same keep-then-re-suffix pattern as proximity. Resolve its banded-vocabulary open question before the phase-3 work. |
| `npc-movement-spec.phase3.md` | **Re-suffix → `.phase4.md`.** It is build step 4; the engine is net-new phase-4 work. |
| `time-and-travel-spec.phase3.md` | **Re-suffix → `.phase4.md`.** Spec is effectively complete; the three leftovers are movement-coupled. |
| `dynamic-character-introduction-spec.phase3.md` + `-brainstorm` | **Re-suffix → `.phase4.md`** (provisional cast = phase 4, demand-dependent). Note phases 2–3 defer to phase 5+. Phase 0 already shipped (T11). Also fix the stale heritage-is-free-text body (resolved: defined enum). |
| `offscreen-simulation-spec.phase3.md` | **Re-suffix → `.phase5.md`.** Record the romance descope (tick the few love interests; skip the LOD tier engine). |
| `character-memory-spec.phase3.md` | **Re-suffix → `.phase6.md`.** Note the write-only `witnessed_by` stamp turns real in phase 3. |
| `multi-character-overview/-data-model/-v1-defaults/-decisions/-presence-and-movement-brainstorm` | **Program-spine references**, not single-phase docs. Decide once: stop re-suffixing them per phase — either drop the phase suffix or freeze at a `.program.md`/`.phase3.md` convention — and say so in the overview, so future phase rolls don't churn them. |

## Extraction steps (ordered)

1. **Author the strict `phase-3-plan.md`.** Rewrite from Bucket 2: scope, task
   list, "out of scope (→ phase 4)" section pointing at the phase-4 plan. Drop the
   draft/candidate-scope framing; set `Status: in progress` when phase 3 starts.
2. **Split the straddling specs** (proximity, location-design; cast-tiers note
   only). Add a top-of-file "Phase split" status note that names exactly which
   sections are phase 3 vs phase 4. Don't physically move sections yet — the
   re-suffix happens when phase 3 closes (convention: suffix = where *remaining*
   work lives, and these still have phase-3 work).
3. **Author `phase-4-plan.md`** (skeleton/draft, same as phase-3-plan was). Anchor:
   npc-movement as the spine; nest the phase-4 specs and the extracted
   proximity/location-design/time-and-travel/emergent-cast sections under it.
   Open with a `Status: draft` line and an `## Open questions` section seeded from
   the items below.
4. **Re-suffix the clean phase-4 specs**: `npc-movement-spec`,
   `time-and-travel-spec`, `dynamic-character-introduction-spec` (+ brainstorm)
   `.phase3.md → .phase4.md`.
5. **Re-suffix the late specs out of phase 3**: offscreen-simulation `→ .phase5.md`,
   character-memory `→ .phase6.md`. (These are *not* phase-4 content — they just
   shouldn't masquerade as phase 3.)
6. **Settle the program-spine convention** for the overview/data-model/v1-defaults/
   decisions/brainstorm and record it in the overview.
7. **Fix every pointer.** `grep -rn '\.phase3\.md' docs/ src/` currently returns
   ~82 lines across the docs plus 8 `src/` files (`contracts/actions/registry.ts`,
   `contracts/relationships/stages.ts`, `contracts/world/access.ts`, `lib/clock.ts`,
   `api/worlds.ts`, `engine/intent.ts`, `engine/merge.ts`, `engine/pipeline.ts`,
   `engine/prompts/narrative.ts`, `engine/scene.ts`). Update each link to the doc's
   new suffix. Do this in the same change as each rename.

## Remaining phase-3 language to update

Extracting phase-4 content leaves dangling phase-3 prose that must change so phase
3 reads as self-contained:

- **`phase-3-plan.md` candidate-scope** ("presence & perception v1, or more of the
  build order"): replace with the fixed Bucket-2 scope; the open question
  "Phase-3 scope" is now *resolved* — remove it.
- **Open-questions section**: keep only genuinely phase-3 items (player-unperceived
  events v2 framing, NPC-invented-action post-hoc check, banded-ambient vocabulary,
  comms scope). **Move to the phase-4 plan**: tier-drift engagement signal,
  owner↔private-link reconciliation, item-instance ownership shape, area path
  hierarchy — all gate phase-4 work.
- **Notes-for-phase-start carry-forwards**: the access-check/`keyItemId` note, the
  tier-drift `lastEngagedTurn` note, and the `encounteredParticipantIds`
  full-encounter note are phase-3-relevant only where they touch presence; the
  movement/traversal halves move to the phase-4 plan.
- **Cross-spec "Implementation status" notes** that say "the presence phase gates
  this when it lands" (e.g. arrival/departure witness gating in npc-movement, T9):
  once npc-movement is `.phase4.md`, reword so phase 3 *produces* the witness
  machinery and phase 4 *consumes* it — keep the dependency direction legible
  across the rename.
- **The naming note** at the bottom of `phase-3-plan.md`: once steps 5–6 are
  re-suffixed, update its "when phase 3 ships, re-suffix surviving docs" guidance to
  reflect that the roll already happened for movement/offscreen/memory.

## Bottom line

Not everything stays in phase 3 — the corpus is four phases wide. The clean cut is
**phase 3 = presence/perception v1 + romance-core proximity + first impressions +
banded ambients**, **phase 4 = movement + the movement-coupled proximity/location/
time leftovers + (demand-permitting) provisional emergent cast**, with off-screen
sim and character memory re-suffixed to phases 5–6 so they stop hiding inside
phase 3. Defer the general-RPG-heavy items (Bucket 1) at the spec level rather
than carrying them into committed phase-4 scope — but keep them on the roadmap;
Vesper stays a capable NSFW RPG.
