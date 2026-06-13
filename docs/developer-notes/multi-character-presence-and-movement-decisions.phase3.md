# Multi-character presence & movement — decisions (2026-06-11)

Resolutions for the open questions in
[multi-character-presence-and-movement-brainstorm.phase3.md](multi-character-presence-and-movement-brainstorm.phase3.md),
decided with Brian on 2026-06-11. Nuances captured during the Q&A are
folded back into the brainstorm doc's sections; this file is the
decision-of-record list.

## Off-screen world & memory

1. **World-tick cadence: scene change + time threshold.** Runs when the
   player changes location OR ~30+ game-minutes have elapsed since the
   last tick, whichever comes first. One batched call, slow lane.
2. **Active-set cap: 6–8 characters.** Companions + plot-warm NPCs;
   promotion by interaction/threads, demotion by staleness.
3. **Memory write policy: shared-event rows + knower links for everyone;
   per-witness perspective summaries only for major-tier characters at
   emotionally significant moments** (large affinity swings are the
   trigger heuristic). Start stamping `witnessed_by` on every new fact
   **immediately**, write-only, ahead of any recall filtering.
4. **Affordances: forge-suggested per location + item-derived
   contributions, all editable.** Items add their own affordances
   (piano ⇒ "plays the piano"); the location editor can override.

## Relationships, cast, comms

5. **Affinity v1: single scalar + registry stage labels.** Explicitly
   planned to get richer in later versions — axes (trust/attraction/…)
   are a widening, so nothing in v1 may assume the scalar is forever.
6. **NPC↔NPC affinity edges from day one**, seeded from authored
   relationships at session spawn, updated when both share an event.
7. **Tier: authored on the library character (forge suggests), with a
   per-session override.** Promotion path = the emergent-cast enrichment
   pipeline.
8. **Urgent comms escalation: director-only.** World-tick NPCs may text
   and call (one ring-out + optional follow-up text max); only the
   director can mark contact urgent or send the character in person.

## Time & map

9. **Turn time composition: max of components.** Plus a **soft cap on
   chained significant actions per turn** (~2: "go home and shower" is
   one beat; "…and then cook dinner" should likely force a stop after the
   shower — a lot can happen in that time). Flagged as possibly
   unimportant in practice — tune in play, don't over-engineer; the cap
   must not start classifying every small verb as an "event".
10. **Map fields (travelMinutes / area / scale): forge suggests, safe
    defaults elsewhere (intra-area links 1 min, `room` scale), all
    editable** in the map editor.
11. **Sound channel: design the link `audibility` field now (alongside
    travelMinutes), ship the channel after v1.** Loud events stop at the
    room boundary until then.
12. **Map scale: dev/test worlds are compact (10–30 locations); the
    eventual ambition is large (100+).** Design consequence: don't build
    district-level abstraction now, but treat the `area` tag as its seed
    and avoid anything that assumes a flat location list stays small
    (prompt rosters, map UI, pathfinding presentation).

## Perception & proximity

13. **Attention: derived from activity/posture for v1; explicit
    `attendingTo` field deferred.** Plus a new idea adopted into the
    design: **perception hints on furniture/affordances** — interacting
    with certain objects implies facing/awareness ("kitchen sink" implies
    facing away from the room) without modeling furniture positions. See
    brainstorm §Attention × salience.
14. **Default salience: obvious unless declared** — sneaking costs the
    player a word. With one carve-out: **stealth markers require a
    plausible concealment target**. "Quietly" whispered to a partner at
    `contact`/`entwined` proximity is intimacy, not a stealth attempt;
    a sneak interpretation needs someone present (or audible-adjacent)
    the action would be hidden *from*.
15. **Proximity: scene-volatile**, and stronger — **`entwined` is a
    movement lock**: a participant cannot change location while entwined;
    the move requires (or implies, when narration covers it) a disengage
    first. Merge-enforced invariant, not just narrator guidance.
16. **Contested checks: three bands, seeded roll only in the uncertain
    middle.** Expectation: the factor list (proximity, affinity, time of
    day, stealth, attention, later stats) will push most attempts into
    the deterministic ends most of the time — the roll is for genuine
    coin-flips only.
17. **Proximity ladder: `distant/apart/near/close/contact/entwined`,
    fixed in the engine** (physics, not per-world vocabulary); `distant`
    exists only at `open`/`expanse` scales.
18. **Location scale: mechanical + one framing line to the narrator**, so
    prose and perception rulings read the same value and cannot drift.

---

# Spec-gap decisions (2026-06-11, second pass)

Resolutions for the **Gaps & opportunities** sections across the seven
specs (see [multi-character-overview.phase3.md](multi-character-overview.phase3.md)).

## Memory & knowledge (character-memory-spec)

19. **Lies: `canon` flag on facts.** Non-canon facts are beliefs — known
    to their believers, excluded from the narrator's truth channel. The
    player's lie shapes the deceived character, never the world.
20. **Stale beliefs: knowledge sticks to fact versions.** Knower links do
    NOT auto-migrate on supersedence; a character updates only when they
    perceive or are told the new state. Dramatic irony by design.
21. **Telling: archivist `disclosures` field** (fact + audience).
    Missed detections degrade toward forgetfulness, never breakage.
22. **NPC lore: knower scope on lore chunks, ships with the ledger**
    (`all | tags | characterIds | none`; forge suggests; default `all`).
23. **No PC ledger — player = reader.** Explicit scope decision.

## Perception & presence (presence-and-perception-spec)

24. **Environment v1: darkness (time-of-day × location light) +
    `senseEffects` hook on conditions** (blindfolded, drunk). Fog/ambient
    refinements later.
25. **Hidden acts against the player: design the player-unperceived
    event path now (skips narration, lands in state + witness sets),
    ship v2** after the base loop is proven.
26. **Awareness blocks include NPC↔NPC lines** (terse) — not just
    NPC-of-player.
27. **Player-side-only adjacent sound ships in v1**: loud events next
    door become a narration line; NPC-side hearing waits for the full
    channel.

## Proximity (proximity-spec)

28. **Required proximity tiers on action kinds + auto-approach.** Gating
    auto-closes distance as part of the action; it only intervenes when
    the approach is contested or impossible.
29. **Failed contested attempts: full consequence wiring** — target (and
    witness) affinity, memory entry, norm check if observed.
30. **Triangle consistency: accept everywhere; diagnostic + clamp only
    at `open`/`expanse`** where contradictions are visible.
31. **Posture coupling: guidance + diagnostic, not hard validation.**
    The movement lock stays the hard invariant.

## Movement & map (npc-movement-spec)

32. **Link access control: schema + basic enforcement in v1**
    (`public | private | locked | timeWindow` + optional `doorItemId`).
    Locked blocks; private discourages NPC pathing; time-window
    redirects. Keys/lockpicking/permissions are later content.
33. **Schedules humanized in v1: seeded daily jitter (±10–15 min) +
    day-of-week mask.**
34. **Followers traverse with the player, same turn, arriving together.**
35. **Overt "I follow her" in v1; covert shadowing later** (as a
    contested-check application, not new machinery).

## Off-screen world & time (offscreen-simulation / time-and-travel)

36. **Background characters may appear in tick social events**: both
    parties get the shared memory + affinity update; only active-tier
    characters are simulated. Promotion stays with the engine rules.
37. **Physical traces: reserve the item-effects field in the event
    schema now; build bounded powers in v2** (own-location only,
    affordance-grounded, capped per tick).
38. **Full declared-rest in v1**: schedule-aware endpoints ("until
    morning"), generous clamp, meter drift across the span, ONE batched
    world-tick per rest with per-character event caps scaled to span.
39. **Mid-action events resolve at turn end in v1** ("as you finish…");
    a future interrupt mechanic reuses director-only urgency.
40. **Turn time = max(registered action, clamped estimate)** when both
    apply — the registry never undercounts a narration that clearly
    spanned longer.

## Cast & relationships (cast-tiers-and-affinity-spec)

41. **Affinity is directional — with the player-direction reframed as
    perception**: for NPC pairs, A→B is A's actual feeling. For edges
    involving the player, each NPC holds two values: their feeling
    toward the player, and their **perceived affinity from the player**
    ("Mara thinks Brian likes her") — inferred from the player's written
    behavior, since the player's actual feelings are unknowable and
    irrelevant. Both values are NPC-owned and evidence-updated.
42. **Extras spawn: authored encounter hints per location/area +
    director signal, hint-validated.** No hints ⇒ no spawns there.
43. **First impressions: full model in v1** — appearance, manner, norms,
    and context-of-meeting all seed the opening edge value at first
    encounter. (Chosen over the lean options with eyes open: this is a
    tuning minefield; build with guardrails — explicit-text-overrides,
    wide-when-unsure — mirroring the identity-range guardrails.)
44. **Factions: tag the data now (forge-suggested), build propagation
    post-ledger** — deltas propagate to same-faction members only when
    they *learn* of the event. (Factions existed in companion-app; this
    is a return, done right.)
45. **Norm breaches move witness affinity — modulated by per-character
    norm stances.** Characters can be tolerant of or vehement about
    specific norms (a partner thief shrugs at your theft; a zealot
    triples the penalty). Stance lives on the character (registry-style
    vocabulary), defaulting to the world's norm severity.
46. **Major-tier soft cap ~6 (warn, never block) — for now.** Planned
    later: algorithmic tier drift — a major untouched for ~50 turns
    decays toward minor; a heavily-engaged minor escalates. Tier
    becomes story-responsive rather than fixed.
47. **Starting locations must be authorable and honored.** Everyone
    currently appears to spawn at one location. `world_cast.
    startWorldLocationId` exists in the schema — verify it's honored at
    spawn and surface it in the forge/editor; add a player start
    location on the world. (Gap raised during review; predates these
    systems.)

## UI (cross-spec)

48. **All four v1 surfaces approved**: clock deltas with cause;
    relationships panel (stages, never numbers); pending texts + message
    history; off-screen feed in the Turn Inspector.
