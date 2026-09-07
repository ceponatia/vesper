# Wardrobe

What the roster and the player are wearing: the resolve seam every consumer reads, the
garment store the worn lists project from, and the player's own wardrobe. The coverage
vocabulary itself — visibility, `exposedRegions`, garment-noun coverage, effective
coverage — is owned by [../contracts/items/README.md](../contracts/items/README.md); this page states how
the chat lane holds and changes it.

## The chat wardrobe

The chat lane carries **structured worn state**,
not one free-text string. A conversation holds `worn_item_ids` (the worn
item-definition ids, seeded from the active outfit preset), `outfit_preset_id` (which named
look is on), the free-text `outfit` (an overlay for narrated-but-unowned garments —
"a borrowed hoodie" — and the legacy fallback), and the retained `outfit_exposed` flag.

- **The seam.** `resolveChatWardrobe` (`engine/chat-wardrobe.ts`) is the ONE place worn state
  becomes what downstream reads — a rendered garment phrase (via `wardrobeOutfitText`,
  occlusion-filtered + subtype-led) plus **coverage-computed exposure** (via the shared
  wardrobe classifier `exposedRegions`, [../contracts/items/visibility.md](../contracts/items/visibility.md)) — reusing the
  shared renderers, never re-forking them — plus the resolved **hair-occlusion band**
  (`hairOcclusion`: the strongest band over the worn rows,
  [../contracts/items/README.md](../contracts/items/README.md) §Hair occlusion; `none` on the
  free-text path), carried to the narrator prompt state, the scene and look image cuts, and the
  hair-affordance read so all three answer from one resolve. The narrator prompt (`promptStateSlice`), the scene
  image (`queueChatScene` → `renderCharacterSceneImage`'s `exposure` override), and the
  `chat_look` key all read it. When `worn_item_ids` is empty the seam falls back to the
  free-text path (`outfit` + the manual `outfit_exposed`), self-healing the moment a preset
  switch / equip populates the worn list — so a conversation that never carried worn ids
  stays on the free-text path until it is re-dressed, and nothing sweeps it.
- **The overlay carries coverage.** Garment nouns in the free-text `outfit` resolve to real
  coverage rows (`contracts/items/garment-noun-coverage.ts`,
  [../contracts/items/garment-nouns.md](../contracts/items/garment-nouns.md)) and reach `exposedRegions` — and ONLY `exposedRegions`, never
  occlusion, cues, or the affordance read, which stay real items. Structured, they can only
  ADD cover: a modelled thong plus an overlay reading "pale lavender gown" must never
  compute `torso: "bare"` and put chest anatomy in the scene prompt. On the **free-text**
  path they are the whole wardrobe, and the precedence is: an exposure claim still wins
  (`outfit_exposed`, or a modelled actor wearing nothing — a stated bare has to beat any garment
  noun still sitting in the text it describes), then the named garments answer PER REGION
  ("wearing only a red thong" is pelvis-covered and torso-bare), then the covered default. A
  noun the text itself DENIES or
  DISPLACES ("without a shirt", "not wearing a shirt", "the gown pooled at her waist")
  contributes no coverage row, so the flag is the backstop rather than the only guard — and
  when the denials are ALL the text says, they answer per region themselves: "not wearing a
  shirt" reads torso-bare with the untouched rest still covered.
  Text naming no clothing — or naming only garments that answer for neither intimate region,
  like a hat — keeps that default: an unmodelled wardrobe is unknown, not nude. So does a
  DEGRADED load: worn ids that resolve to nothing land on this path too, and the nouns are
  gated on `worn_item_ids` being genuinely empty, so "a borrowed hoodie" can never bare the
  regions the unloadable items were covering ([../resilience.md](../resilience.md)).
- **Failure is marked, never bare.** The manual `outfit_exposed` flag speaks only on the
  genuinely free-text path (`worn_item_ids` empty) — with worn ids present a stale flag cannot
  undress a wardrobe whose load merely failed. A load that threw, a row whose `coverage`
  column would not parse, or a modelled instance whose blueprint dangles or parsed degraded
  (`resolveGarmentBlueprint`'s `reliable: false`) degrades exposure to fully covered, withholds
  `worn` so the contact/affordance reads fail closed, and marks the resolve `unreliable` — the
  `chat_look` mint skips a marked resolve (no render, no purge of the correct anchor) and the
  next outfit/appearance change retries. Rows genuinely deleted stay unmarked: that degraded
  resolve is permanent truth, and marking it would park the look forever. On the write side,
  garment materialization (`syncChatGarments`) withholds unloadable or coverage-unreadable ids
  and SKIPS the reconcile for any actor whose desired set contains one — warn diagnostics
  `chat_garments.definition_load_failed` / `chat_garments.coverage_unreadable` — instead of
  minting durable covers-nothing instances or doffing whatever the unreadable garment replaced.
  An unmodelled actor keeps the ids in the worn column and materializes on a later healthy
  reconcile; a modelled actor keeps their prior outfit (the projection re-persists the old worn
  set), so a failed load costs a lost outfit change, never a bare body. A partially readable
  player worn list (some elements corrupt, survivors kept) likewise cannot establish exposure:
  the parse marks it incomplete and the resolve takes the coverage-unreliable arm.
- **Editing.** The Character sheet's per-slot equip/remove editor + preset switcher
  (`components/characters/chat-wardrobe-editor.tsx` — [ui/conversation.md](../ui/conversation.md)).

## Archivist outfit changes

The archivist's `outfit` field (`contracts/turns/chat-archivist.ts`)
drives two grammars, folded by `foldOutfitProposal` in `chat-state/outfit-fold.ts`, called by `finalizeChatState`: a whole-outfit
`description` naming an authored preset ("her work clothes" → the Work preset) seeds the worn
list from it, an unmatched description over a MODELLED wardrobe replaces it **only when the
proposal's verbatim `changeEvidence` is present in this exchange's text, classifies as an
asserted, completed change, AND is attributable to the wardrobe's owner**
(`outfitChangeEvidenceValidated` — grounded + asserted + owner-attributed). Owner ruling
2026-08-01: nouns cannot tell a same-head change like "a black silk shirt" over a worn cotton
shirt from a paraphrase, nor an alias "t-shirt"-for-"tee" from a new garment, so only the
exchange SAYING the outfit changed replaces — and only for the owner it says it about.

- The **assertion** half is the pure `classifyOutfitChangeQuote`
  (`contracts/items/outfit-change-evidence.ts`): negated, modal, conditional, questioned,
  commanded, quoted, incomplete, hypothetical, habitual or idiomatic non-events all keep the
  wardrobe, and a wardrobe verb must put a garment in its object window ("takes off her jacket",
  never "takes off for work"). It returns the ONE sentence that asserted, which is the text the
  **attribution** half then reads.
- **Attribution is bounded, not coreference**: the owner's
  name/alias anywhere in that sentence carries it, possessives included (the actor need not be
  the owner — "Mara pulls off Sabrina's jacket" is SABRINA's evidence); a sentence naming only
  another participant never does; the player additionally takes first person in their own line
  and second person in the reply; 1-on-1 scenes stay lenient about third-person and markerless
  clauses; and ensemble scenes **fail closed** on a bare pronoun, so one character's change
  clause cannot license another's replacement. An exposure claim skips the gate entirely.
- Lacking validated evidence the structured list is kept
  (`chat_wardrobe.outfit_restatement`; a narrator paraphrase — even one naming no garment,
  like "sleeves shoved past her elbows" — is not a wardrobe action), and the diagnostic
  message names any garment identities the kept description mentioned that no worn item
  accounts for (the `contracts/items/garment-nouns.ts` registry: canonical
  plural/alias/compound identities; telemetry here, and the identity gate in `matchGarment`'s
  delta matching). With nothing structured worn there is nothing to protect and the
  free-text replacement runs unguarded — and garment-level
  `removed`/`added` fold through the pure `applyWornGarmentChanges` (contracts) against the
  loaded worn items + the character's preset pool — a removed garment drops its id, an
  unmatched added garment rides the overlay (both degrade with a diagnostic, never fail the
  turn).
- The ensemble members' **personal pass** runs the same two description rungs through
  the pure `settleEnsembleMember` ([multi-character.md](multi-character.md) §Multi-character):
  a whole-look description naming an authored preset re-seeds their worn list exactly like the
  primary and never reaches the gate, an unmatched one replaces a
  modelled worn list only past validated evidence (scoped to THAT member — on a roster of two
  or more, only their own name in the clause licenses it) or an exposure claim, and otherwise the list
  is kept with `chat_wardrobe.ensemble_outfit_restatement` — a bare message, since naming the
  description's unworn garments needs an item load and that fold is pure. Garment-level
  `removed`/`added` remain the primary's IO-backed path. Rollback-safe:
  `worn_item_ids`/`outfit_preset_id` ride `storedChatStateSchema`.

## The garment store — instances under the projection

The worn
lists above are a **derived projection** of a deeper truth: the chat-wide garment store on
`ChatScenario.garments` (`character_chats.garments` jsonb, migration 0090). Each worn
definition materializes lazily — on the next state write, never on read — into a
**garment instance**: a content-hash-deduplicated blueprint snapshot (sparse part graph
from its category template, rescoped so node coverage equals the definition's coverage
exactly), a locus (`worn`/`held`/`wardrobe`/`scene`/`gone` — a `scene` garment stays at its
snapshotted place name across scene moves), typed **presentation**
(closures, rolls, tucks, displacement; 0 = fastened → 1 = open), and a **condition** state
(fixed-point wetness/cleanliness/crease/wear base vector + per-part regional overrides +
located deposits and damage marks, integrated lazily to story minutes — only wetness moves
autonomously, drying at a material-scaled rate via the shared fixed-point kernel (`@/lib/fixed-point`, a barrel over `@vesper/contracts`)).

- **One dispatcher.** Every mutation is a typed `GarmentOperation` through
  `applyGarmentOperations` (contracts) — transfers, five presentation ops, six condition
  ops — validated against the blueprint's behavior bindings; rejections are stable
  `garment_op.*` diagnostics, never throws. The state route PATCH accepts
  `garmentOperations`; the state-tools sheet queues them per part.
- **One read.** Per-part effective coverage (baseline minus subtraction-only behavior
  deltas, `garment-effective-coverage.ts`) feeds the visibility resolver — the
  same resolution the narrator exposure gate and image prompts consume. Bands (with ±500
  hysteresis) surface in `garmentReadout`; raw fixed point never leaves the server.
- **A deleted library row keeps its band.** An instance snapshots its definition's resolved
  hair-occlusion band at mint time beside its name (`GarmentInstanceState.hairOcclusion`,
  sparse at `none`), and the resolve seam reads that snapshot only when the definition is
  gone — a live definition's band, absent included, always wins, so an editor override
  applies at once while an orphaned hijab still hides hair.
- **Rollback for free.** The store rides the `pre_exchange_scenario` blob, so retakes
  restore blueprints, loci, presentation, and gradients byte-identically (int-tested).
- **`outfit_exposed` demoted.** Authoritative only for unmodelled actors (no instances);
  a modelled actor's exposure always derives from coverage.
- **The extraction lane**: the archivist proposes typed garment operations
  over opaque handles the prompt enumerates (`mara.shirt.sleeve_left` — ~200 tokens
  for a 2-actor scene), resolved and applied through the dispatcher in fiction order;
  unresolved handles drop with diagnostics, ad-hoc garments mint from category
  templates, and the free-text fold runs only as a degraded bridge
  (`chat_garments.legacy_outfit_bridge`) — which remains the path for ensemble
  members beyond the primary. Per-exchange traces surface in the admin inspector.
- **Narration** (behind `CHAT_GARMENT_CUES`, default off): an authoritative per-actor
  digest (placement + structural presentation, bands
  only) plus at most two ranked, perception-gated garment cues with repeat-key
  gating; the cue/band memory lives at `ChatGarmentStore.cues` so it rides the same
  rollback anchor as the store. The `chat_look` refresh triggers on a pre/post
  garment fingerprint comparison (worn set, structural bands, wet-and-above,
  deposit/damage presence) regardless of the flag.

## The player's wardrobe

The **player** has one too — "she pulls your shirt over
your head" is a state change, not just prose. It lives on `character_chats.player_state`
(a `ChatPlayerState` jsonb: `personaId`, `wornItemIds`, `seeded`, `outfitPresetId`,
`overlay`) rather than `character_chat_state`, because there is one player and many roster
characters. That placement also puts it inside the `pre_exchange_scenario` rollback
snapshot for free, so "another take" cannot leave the player undressed by a discarded beat.

- **Structured-only, no manual flag.** A persona is a library entity with real outfit
  presets, so `resolvePlayerWardrobe` (the character seam's twin in `chat-wardrobe.ts`)
  always computes exposure from coverage. There is deliberately no `exposed` toggle: it
  would be a hole through the scene-image gate that decides whether the viewer's anatomy
  renders. Their `overlay` carries garment-noun coverage on
  the same terms as the character's (§The chat wardrobe) — additive over worn items, and the read of
  last resort when there was nothing to resolve and the player was never stripped. Worn ids
  that FAILED to resolve are not that case: the same degradation gate keeps the covered
  default rather than letting the prose bare what the missing items covered.
- **`seeded` breaks a real ambiguity.** An empty worn list means *"not dressed yet"* before
  seeding and *"stripped"* after it. Unseeded, `playerWornIds` resolves the persona's
  default preset — so a fresh chat, or a persona whose wardrobe was never authored, doesn't
  read as naked. The flag flips on the first actual change, so the seed materializes on a
  write rather than as a side effect of a read.
- **One archivist field, both directions.** `playerOutfit` (`description`/`removed`/`added`,
  no `exposed`) rides the **shared continuity leg** — never the per-member personal pass,
  where several ensemble members would each propose changes to the one player's clothes.
  The archivist reads the whole exchange, so the player writing "I pull my shirt off" and
  the character doing it are the same event to it. `foldPlayerOutfitProposal` reuses
  `applyWornGarmentChanges` verbatim against the **persona's** preset pool, and carries the
  same change-evidence gate as the character fold (grounded, asserted **and** owner-attributed)
  — tested against `playerWornIds` (so the default preset is protected before seeding too;
  `chat_wardrobe.player_outfit_restatement`) and owner-scoped to the PLAYER: first person
  attributes in the player's own line, second person in the reply, and the wrong half does not
  (first person in the reply is the character speaking).
- **Switching persona resets the wardrobe** (`seeded: false`) — the worn list described the
  person who was wearing it.
