# Character chat — state as a narration system — plan

Status: **shipped — 2026-06-30** (all nine build steps + the seven decisions D1–D7).
See the Completion note at the foot.

Design/decisions: [character-chat-state-narration.spec.md](character-chat-state-narration.spec.md)
— read it first; it is the truth (types, the overlay guard, the anti-repetition algorithm,
the collected open questions). This plan is the task list and build order. It builds on the shipped **light state**
([character-chat-state.plan.md](finished/character-chat-state.plan.md) · spec
[character-chat-state.spec.md](finished/character-chat-state.spec.md), the truth for
the tracked meters/affinity/conditions/mindNote) and the shipped **opportunistic
sensory cues** ([character-chat-sensory.plan.md](character-chat-sensory.plan.md)),
whose "surface a cue only when the beat earns it" rule this generalizes from scent to
all state. Sibling to the larger [character-chat-primary.plan.md](character-chat-primary.plan.md):
this is the fast, prompt-layer slice of that arc — it ships first and stands alone.

## Goal

Character chat already **tracks** a full state row (`character_chat_state`: meters
`hygiene` / `energy` / `stress` / `arousal` / `intoxication` / `mood`, plus `affinity`,
`conditions`, `mindNote`) but the narrator barely **acts on it**. Today only
threshold-crossing meter hints (`crossedThresholdHints`), a derived mood phrase
(`deriveMoodDescriptor`), an affinity warmth steer, condition `promptHint` strings,
and the `mindNote` reach the prompt — all assembled by `buildStateSection` in
`engine/prompts/character-chat.ts`. Sub-threshold gradients, meter **severity**, and
every condition's structured **`attributeEffects`** are dropped, because the chat
builder resolves `resolveAttributes(profile.attributes, [])` with an **empty overlay
list** (the session lane passes `state.attributeOverlays` here).

Make the tracked state **enacted**, the way the roadmap intake describes:
intoxication ≈ 0.75 ⇒ looser posture, slurred edges, a **temporary inhibition drop**;
low hygiene ⇒ modified scent / texture / visual read, dirtier, mentioned occasionally.
The hard constraint (called out explicitly in the intake and in the sensory plan): the
narrator must **not re-describe these every single turn** — state is standing
*coloring*, surfaced as a fresh beat only when it changes or the moment invites it.

## Build order

1. **Condition → attribute overlays in chat (high-leverage, no migration).**
   Build an overlay array from `state.conditions[].attributeEffects` and pass it to
   `resolveAttributes(profile.attributes, overlays)` in `buildCharacterChatSystemPrompt`
   (today the second arg is `[]`). Note: this is a **designed-but-unbuilt seam** — the
   `attributeEffects` field and the `condition` provenance source (precedence 3) both exist,
   but *nothing consumes them* (both creation sites set `attributeEffects: []`), so this slice
   builds the conversion (the session lane can adopt the same pure helper later). A "flushed"
   or "unwashed" condition then actually overlays skin/scent/hair attributes instead of
   contributing only its free-text `promptHint`. **Guard:** the overlay helper filters each
   effect through `overlaySourceMayChange(def.mutability, "condition")` so a condition can
   never rewrite an inherent attribute (eye colour, species) in the prompt — `resolveAttributes`
   itself is unguarded last-write-wins. Requires giving chat conditions real `attributeEffects`
   via a small label→effects catalog (today `chat-state.ts` + the state-tools modal create
   every condition with `attributeEffects: []`). `senseEffects` is **out of v1** (spec §2; D6).

2. **Graded meter → prose (beyond the single on/off threshold).** `meterDefinitions[].thresholds`
   in `contracts/meters/registry.ts` is the single source of meter→prose (e.g. intoxication
   `>0.7` → "Drunk: slurred edges on words"). Surface a **graded** band (tipsy → drunk →
   sloppy) rather than one boolean crossing, and carry an intensity the narrator can scale.
   Keep it a pure derivation next to `crossedThresholdHints`/`deriveMoodDescriptor` so it
   stays testable and registry-driven (vocabulary edits, not code).

3. **Temporary disposition shift — the "inhibition" lever.** The intake's example is that
   high intoxication should *temporarily* lower inhibition. Drive this through the existing
   Disposition block (`dispositionBands` in the prompt) rather than mutating authored traits:
   a transient modulation (mirroring `personalizeMeters` in `contracts/personality/modulation.ts`,
   but prose-facing) that lowers **three** traits while intoxication/arousal is high —
   `intimate.inhibition`, `social.guardedness`, **and** `temperament.composure` (drunk reads
   more volatile, not just looser; **D2**) — applied as `source:"condition"` trait overlays
   pre-resolved into `dispositionBands`, restoring as the meter drifts back. Standing trait
   values are never written — render-time only, so it can never corrupt the character.

4. **Anti-repetition: standing vs. changed cues.** The core risk. Model state cues as
   **standing background coloring** plus a **foregrounded beat only on change** — i.e. a cue
   is stated as a fresh sensory/behavioral beat the turn its band *crosses* (sobering up,
   tipping into drunk, hygiene dropping), then recedes to "let this color how you speak,
   never recite it." Mechanically: track the last-surfaced band per meter (cheap — a small
   map on `character_chat_state` or derived from the prior snapshot) and only emit the
   "new beat" framing on a delta. Add a `CHAT_RULES` rule mirroring the sensory rule ("one
   state beat when it shifts or the moment earns it; otherwise let it color tone, never list
   or restate it"). This is the heart of the plan — the overlay/meter wiring is mechanical;
   the gating is the design.

5. **Surface outfit + active social cards to the narrator (graduate the scenario deferral).**
   `character-chat-scenario.plan.md` deferred "Surfacing active cards to the chat narrator
   prompt" and "Should the chat narrator also see the outfit text and active cards." The
   route already has `outfit` / `outfitExposed` / `activeSocialCards` on the drifted state but
   does **not** pass them to `buildStateSection`. Thread them in as part of "what colors this
   turn": outfit as a light scene anchor; cards as **soft framing only** — their theme ("what
   you care about / won't stand for"), never their mechanical `severity`, so the narrator can't
   pre-play the reaction the post-turn pulse owns (**D3**).

6. **One-turn intent cue (both layers — D1).** Whole-state surfacing (steps 1–5) is the base;
   *also* build a pre-narrator classifier (regex first cut, mirroring `engine/intent.ts`; chat
   has *no* pre-turn agent today, so this is a clean insertion point) that reads the player
   input for proximity / approach / touch / intimacy / first-encounter signals and raises a
   one-turn hint so an opportunistic cue (scent on closeness, a state beat on a touch) fires
   when the beat invites it. Must not persist into chat history; runs regex-first (no hot-path
   LLM call). Seeds the pre-narrator intake the primary-feature plan wants — build once, shared.

7. **State → scene image (bundled — D4).** Fold the §-state derivations (graded bands +
   condition overlays) into `renderCharacterSceneImage`'s prompt so low hygiene / intoxication
   make the render dirtier / flushed — the visual axis of the intake's "modify … visual
   attributes." Reuse the **same** helpers as steps 1–3 so prose, the standing avatar
   (`chatStateSnapshot.avatarCue`), and the scene image agree. Graduates the
   `deferred.plan.md` entry (leave a tombstone there).

8. **Debug surface.** Extend the State-tools modal (`components/characters/chat-state-tools.tsx`)
   to show *what actually reached the narrator* this turn — the resolved overlay set, the
   graded meter bands, the inhibition shift, and which cues were foregrounded vs. standing —
   so the gating is tunable by observation. (The larger inspector lives in the primary plan.)

9. **Docs + tests.** Update `../ui.md` (Chat tab — what the state strip now drives),
   `../prompts.md` (chat lane — the new state-enactment block + the anti-repetition rule,
   alongside the existing Sensory cues section), and `../images.md` (chat scene image now
   state-aware); tombstone the graduated entry in `deferred.plan.md`. Tests: pure derivations
   (graded bands, overlay assembly incl. the inherent-attribute guard, the three-trait
   disposition shift, the intent classifier) + a chat eval fixture asserting a state beat fires
   on a band change and **not** on the following steady-state turn.

## Decisions

All seven open questions are resolved — the rulings (D1–D7) live in the spec's **## Decisions**
section ([character-chat-state-narration.spec.md](character-chat-state-narration.spec.md)). In
brief: build **both** whole-state surfacing and the intent classifier here (D1); the inhibition
shift lowers inhibition + guardedness + composure (D2); cards are **soft framing only** (D3);
the scene-image visual axis is **bundled** here (D4); `surfaced_cues` is a new jsonb column
(D5); `senseEffects` is out of v1 (D6); one state change-beat per turn (D7). D5–D7 are adopted
defaults — flag if you want them revisited.

## Not in scope (this plan)

- RAG / episodic / semantic-fact memory, mutable-attribute **evolution** over a chat, and the
  pre-narrator agent fan-out — all the larger architectural parity work lives in
  [character-chat-primary.plan.md](character-chat-primary.plan.md). This plan only *reads* the
  state that already exists and renders it well.
- Location entities / presence — chat stays single-character, location via narration only.

## Related

- Spec it leans on: [character-chat-state.spec.md](finished/character-chat-state.spec.md)
  (the tracked meters/conditions/affinity mechanics).
- Pattern it generalizes: [character-chat-sensory.plan.md](character-chat-sensory.plan.md)
  ("surface a cue only when the beat earns it").
- Deferrals it graduates: scenario plan's narrator-sees-outfit/cards
  ([finished/character-chat-scenario.plan.md](finished/character-chat-scenario.plan.md)) and
  the state-aware chat scene image ([deferred.plan.md](deferred.plan.md)).
- Reused contracts: `contracts/meters/registry.ts`, `contracts/conditions/condition.ts`
  (`attributeEffects`/`senseEffects`), `contracts/registry/provenance.ts` (the `condition`
  source), `contracts/attributes/value.ts` (`overlaySourceMayChange`),
  `contracts/personality/modulation.ts` (`personalizeMeters` is the pattern for the new
  `stateDispositionOverlays`), `contracts/mood/emotion-label.ts`. The condition→attribute
  overlay is **unbuilt in both lanes today** (the `attributeEffects` field is consumed
  nowhere) — this plan builds the pure helper; the session can adopt it later.
- Sibling arc: [character-chat-primary.plan.md](character-chat-primary.plan.md).

## Completion note (2026-06-30)

All nine steps shipped; `pnpm verify` green (1620 tests). What landed and where:

- **Contracts (pure):** `conditions/overlays.ts` (`conditionAttributeOverlays`, inherent-attr
  guard), `conditions/catalog.ts` (label→effects), `meters/registry.ts` (`meterStateCue` +
  `splitStateCues` for the band-change gate), `personality/modulation.ts`
  (`stateDispositionOverlays` — inhibition + guardedness + composure, **D2**). All barrel-exported.
- **Prompt builder** (`engine/prompts/character-chat.ts`): condition overlays into
  `resolveAttributes`; disposition pre-resolved with the disinhibition overlays; `buildStateSection`
  renders standing vs. one foreground beat; `buildSocialFramingSection` (soft cards, **D3**); outfit
  line; new `CHAT_RULES` rule 11 (state is behavioral law, mark only on shift) + the `cueInvite` slot.
- **Intent classifier** (`engine/chat-intent.ts`, **D1** "both"): regex-first `detectChatCue` +
  `chatCueInviteLine`, route-rendered (no model call), non-persisted.
- **State + schema:** `character_chat_state.surfaced_cues` jsonb (migration `0017`), computed from the
  drifted pre-pulse meters and persisted in both `saveChatState` (guarded) and `persistChatState`
  (opening). Conditions seeded from the catalog in `editChatState`. Snapshot carries `surfacedCues`.
- **Scene image (D4):** `images/character-scene.ts` `visualStateNote` + condition overlays; route
  threads `meters`/`conditions`.
- **Debug surface:** the State-tools modal's "State → narration" readout (foreground/standing/surfaced/overlays).
- **Docs:** `prompts.md` (§Character-chat state as a narration system), `ui.md` (Chat tab),
  `images.md` (state-aware chat scene). Deferred scene-image entry tombstoned in `deferred.plan.md`.

**Deferred to follow-ups:** `senseEffects` (D6, out of v1); a model-upgrade of the regex intent
classifier; richer catalog vocabulary. None block the feature.
