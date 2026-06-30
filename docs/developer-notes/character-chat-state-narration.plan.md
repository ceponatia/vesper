# Character chat — state as a narration system — plan

Status: **next** (queued — first priority; design mostly settled. Prompt-layer
work plus one no-migration overlay reuse; no new tables).

This plan is the task list and build order. It builds on the shipped **light state**
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

1. **Condition → attribute overlays in chat (high-leverage reuse, no migration).**
   Build an overlay array from `state.conditions[].attributeEffects` and pass it to
   `resolveAttributes(profile.attributes, overlays)` in `buildCharacterChatSystemPrompt`
   (today the second arg is `[]`). This reuses the session's proven condition→attribute
   mechanism verbatim (`engine/scene.ts` + `merge/phases/conditions.ts`) — a "flushed"
   or "disheveled" condition can now actually overlay skin/scent/hair attributes instead
   of contributing only its free-text `promptHint`. Requires giving chat conditions real
   `attributeEffects` (today `chat-state.ts` + the state-tools modal create every
   condition with `attributeEffects: []`); seed a small starter set (drunk → looser
   movement/speech; unwashed → scent/skin; flushed → already exists for arousal). Decide
   whether `senseEffects` (perception impairment) also applies in a single-character chat
   (probably yes for intoxication — it dulls the character's *own* read of the player).

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
   but prose-facing) that nudges the `guardedness` band down while intoxication/arousal is
   high, and restores as the meter drifts back. Standing trait values are never written —
   this is a render-time shift only, so it can never corrupt the character.

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
   turn" (outfit as a light scene anchor; cards as the live taboo/rule frame the pulse already
   resolves against).

6. **(Optional) one-turn intent cue.** Graduate the sensory plan's deferred **beat-cue
   wrapper**: a tiny pre-narrator classifier (regex first cut, mirroring `engine/intent.ts`;
   chat has *no* pre-turn agent today, so this is a clean insertion point) that reads the
   player input for proximity / approach / touch / intimacy / first-encounter signals and
   raises a one-turn hint so a state cue (scent on closeness, slur on a long exchange) fires
   when the beat invites it. Must not persist into chat history. Decide against the cheaper
   alternative (just hand the whole state to the narrator — viable because there's one
   character and no locations) in Open questions.

7. **State → scene image (graduate the deferred state-aware chat scene image).**
   `deferred.plan.md` "State-aware chat scene image" folds mood/meters (flushed, tipsy,
   tired), conditions, and the `mindNote` into `renderCharacterSceneImage`'s prompt. The
   intake's "modify … visual attributes to make them dirtier" wants exactly this for the
   visual axis. The state + render path already exist; this only enriches the prompt. Carry
   it here as a slice (or split to its own follow-up if it wants a separate playtest read).

8. **Debug surface.** Extend the State-tools modal (`components/characters/chat-state-tools.tsx`)
   to show *what actually reached the narrator* this turn — the resolved overlay set, the
   graded meter bands, the inhibition shift, and which cues were foregrounded vs. standing —
   so the gating is tunable by observation. (The larger inspector lives in the primary plan.)

9. **Docs + tests.** Update `../ui.md` (Chat tab — what the state strip now drives) and
   `../prompts.md` (chat lane — the new state-enactment block + the anti-repetition rule,
   alongside the existing Sensory cues section). Tests: pure derivations (graded bands,
   overlay assembly, inhibition shift) + a chat eval fixture asserting a state beat fires on
   a band change and **not** on the following steady-state turn.

## Open questions

- **Whole-state-to-narrator vs. pre-turn intent agent (step 6).** Single character + no
  locations makes "just give the narrator the whole state and trust the anti-repetition
  rule" cheap and viable; the intent classifier is more precise but more machinery.
  **Proposed:** ship steps 1–5 with whole-state + the change-gating rule first, add the
  classifier only if playtests show the narrator over- or under-firing cues.
- **Inhibition mechanism (step 3).** Transient `guardedness` band shift (proposed) vs. a
  dedicated `intoxicated`/`uninhibited` condition with `attributeEffects` vs. a real
  temporary disposition override. The band shift is the least invasive and reuses
  `dispositionBands`.
- **Scene image in or out (step 7).** Bundle here vs. keep as its own follow-up — depends on
  whether the visual hygiene/intoxication cues read well enough in the prompt to be worth the
  image-pipeline touch.
- **Where the "last-surfaced band" lives (step 4).** A new small jsonb on `character_chat_state`
  (durable across turns, survives reload) vs. derive from the prior verbatim/snapshot
  (no migration). Prefer no-migration if the prior snapshot is reliably in hand.

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
  (`attributeEffects`/`senseEffects`), `contracts/personality/modulation.ts`,
  `contracts/mood/emotion-label.ts`. Session-side reference for condition→attribute overlays:
  `engine/scene.ts` + `engine/merge/phases/conditions.ts`.
- Sibling arc: [character-chat-primary.plan.md](character-chat-primary.plan.md).
