# Mood — app-wide emotional state (plan)

Status: **shipped — 2026-06-24**. All of mood's **own** scope landed: the projection +
`EmotionLabel`, welcome/unwelcome touch, the condition + scene-atmosphere baseline shifts,
and the mood chip on both the cast card and the character-chat strip (see _Shipped_
below). The two ideas once parked under "remainder" belong to **other** plans, not this
one — the relationship/meter timeline ([deferred.plan.md](../deferred.plan.md) #4) and the
avatar's consumption of the projection ([avatar-3d.plan.md](avatar-3d.plan.md)) — so the
mood topic itself is complete and archived to `finished/`. Settled (open questions
resolved 2026-06-24; see _Decisions_). Graduated the **event→mood table** that
`personality-and-state` deferred (spec §4: _"the event→mood inputs and the full coupling
matrix are planned with the mood slice"_) and promoted **mood** to a first-class,
cross-app read.

Design detail / vocabularies: [mood.spec.md](mood.spec.md) — the `EmotionLabel`
enum, the `deriveEmotionLabel` projection, and the event→mood table shapes.

Topic slug `mood`. Drafted 2026-06-21 at the user's request ("plan out the mood
separately as it will be for more than just animations").

## Why now

The avatar work ([avatar-3d.plan.md](avatar-3d.plan.md)) needs a live emotional
signal, but mood is bigger than the avatar: it already feeds the narrator, is
mood-adjacent in scene images, and wants UI surfacing and chat support. Two gaps
remain from the shipped mood meter:

1. **Only social reactions move mood.** The general **event→mood** inputs (scenes,
   conditions, story beats, physical state, presence) and the full coupling matrix
   were explicitly deferred. This plan builds them.
2. **No labeled read.** Consumers that need a _discrete emotion_ (the avatar cue's
   `emotion`, a UI mood chip) have only a `0–1` valence + a prose descriptor. This
   plan adds a pure **labeled-emotion projection**.

## What already exists (do not rebuild)

| Piece                        | State                                                                                                      | Source                                                                   |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| **`mood` meter**             | valence `0`(low)–`0.5`(even)–`1`(bright); baseline 0.5, recovery 0.06/hr; trait `optimism` shifts baseline | `src/contracts/meters/registry.ts:94`                                    |
| **`deriveMoodDescriptor()`** | blends mood × stress × energy → prose ("bright and playful"); fed to the narrator **and** the 1-on-1 chat  | `registry.ts:156`, `engine/scene.ts:946`, `prompts/character-chat.ts:97` |
| **Mood ↔ affinity coupling** | mood scales reaction magnitude (`μ`); a reaction nudges mood (affinity-scaled), in both the main turn **and** the chat reaction pulse | `personality/reactions.ts` (`moodNudge`), `modulation.ts`, `engine/merge.ts` |
| **Trait-derived baselines**  | `optimism→mood.baseline`, `libido→arousal`, `composure→stress.recovery` via `personalizeMeters`            | `engine/merge.ts`                                                        |

## Design principles (from personality-and-state spec §4 — the truth)

- **One valence axis + a derived read — NOT a multi-axis mood vector.** The
  codebase already carries a PAD-ish picture: `arousal` (meter), `stress`/`energy`
  (activation/tension), `dominance` (trait), and `mood` (valence). Mood stays a
  _read_ over these, never a second source of truth. Any "emotion" is a projection,
  not stored state.
- **Mood is transient; affinity is standing.** Mood = how she feels _right now_
  (driven by interactions **and** events); affinity = overall regard. Don't blur
  them — they _couple_, they aren't the same axis.
- **Deterministic, pure, testable.** The event→mood table is data (like the
  reaction curve / `modulation.ts`); the merge applies it as bounded, clamped math.
  Constants live in `contracts` (IO-free), per the existing pattern.
- **Resilience.** `parseOr` at boundaries; a missing/odd input degrades to drift,
  never a failed turn (`docs/resilience.md`).

## The event→mood table (headline new piece)

Today only the social-reaction curve moves mood. Generalize to a **registry of
event kinds → mood deltas**, each scaled by the coupling matrix (affinity/traits).
v1 subset locked (see _Decisions_); the rest is a later slice.

- **Social reactions** _(v1, exists)_ — keep; the curve's evaluated magnitude is one row.
- **Welcome/unwelcome touch** _(v1, new)_ — the same touch lands as tenderness from a
  partner and a violation from a stranger, so welcome-ness is **affinity-stage gated
  with a preference override**: welcome at/above a warmth stage (mood ↑), unwelcome
  below it (mood ↓, stress ↑), trait-damped; an explicit like/dislike preference wins
  over the stage default. Reuses the reaction curve's affinity terms — no new
  authoring. (Detail: [mood.spec.md](mood.spec.md) §5.)
- **Conditions** _(v1)_ — `tipsy`/`flustered`/`hurt` already carry prompt hints; map
  each to a mood delta (reuse `conditions/` effects).
- **Scene atmosphere** _(v1)_ — a tense/ominous scene depresses mood + raises stress;
  a warm/romantic one lifts it. _Note the avatar keeps scene `atmosphere` as a
  separate channel (a tense scene ≠ a panicked character) — atmosphere is an
  **input** to her mood, weighted by traits (composure), not an override._
- **Story beats** _(deferred)_ — director thread signals (develop/resolve) nudge mood
  (a resolved arc lifts; a betrayal drops).
- **Physical state cross-talk** _(deferred)_ — low energy/hygiene drags mood; rest
  restores it (meter→meter, already half-expressed via baselines).
- **Presence** _(deferred)_ — high-affinity company lifts a low mood a little (spec §4
  Note 5); isolation lets it sag toward baseline.
- **Intimacy beats** _(deferred)_ — arousal/exposure progression (gated, ties to
  [intimacy-notes.plan.md](intimacy-notes.plan.md)).

**Coupling matrix** (extend what shipped): affinity scales how far an event moves
mood; mood scales reaction magnitude (`μ`, exists); traits damp/amplify
(`composure` steadies, `optimism` raises the floor). Document the full matrix here
as it's built; keep every path clamped.

## The labeled-emotion projection (the read consumers need)

A pure function — sibling to `deriveMoodDescriptor` — mapping the emotion state to
a **discrete label + intensity**:

```
(mood, arousal, stress, energy, affinityStage, recentReaction, conditions, intimateContext)
  → { emotion: EmotionLabel, intensity: 0..1 }
```

(Full typed shape — using the real `EvaluatedReaction` / `RelationshipStage` /
`ActiveCondition` types, not the `ReactionBand`/`AffinityStage` names earlier drafts
invented — is in [mood.spec.md](mood.spec.md) §3.)

- **Baseline** comes from the meters (valence × a derived activation axis); the
  **transient beat** comes from the latest social-reaction result (a flash of
  delight/hurt that decays). Two timescales, one read.
- **One `EmotionLabel` vocabulary, locked app-wide** (decision 2026-06-24): the
  **11-label** set in [mood.spec.md](mood.spec.md) §2 — `neutral`/`happy`/
  `affectionate`/`playful`/`flustered`/`concerned`/`sad`/`angry`/`afraid`/
  `surprised`/`aroused` (the last intimate-context gated). Mood **owns** the enum;
  the avatar cue widens from its original 8 ([avatar-3d.notes.md](avatar-3d.notes.md))
  to import these, and the UI / any future consumer agree on the same one.
- Stays a **read** — no new stored state, consistent with the spec's principle.

## Consumers (why it's "more than animations")

- **Narrator** — the prose descriptor (exists); could also read the label.
- **Avatar animations** — `AvatarCue.emotion`/`intensity` derived from the
  projection (the immediate reason this plan exists, but not the only one).
- **Scene images** — reflect current mood in expression, not just static
  attributes (the pipeline already reads mood-adjacent state).
- **UI surfacing** — a mood chip in the Cast panel + the deferred
  **relationship & meter timeline** (`deferred.plan.md` #4) charting mood over a
  session.
- **Character-chat** — chat-scale mood **already ships**
  ([character-chat-state.plan.md](../finished/character-chat-state.plan.md), shipped
  2026-06-24): its reaction pulse moves the `mood` meter via the same §6 curve and
  surfaces `deriveMoodDescriptor` in the prompt. Mood adds the **labeled projection**
  (a chat mood chip / avatar) and the richer event inputs on top — one system, not a
  parallel one.
- **NPC puppeting** — richer contradiction judging "once mood exists"
  (`npc-puppeting.deferred.md`).

## Scope boundaries (v1)

- **One valence axis**, derived reads only — no multi-axis vector.
- **v1 inputs**: social reactions, welcome/unwelcome touch, conditions, scene
  atmosphere. Story beats, presence, physical cross-talk, and intimacy beats are
  deferred to a later slice.
- **Player-driven events** for classification in v1 (NPC→NPC mood deferred, per
  personality scope).
- **Per-relationship mood deferred** (personality §11) — one mood per character,
  not per-edge, for now.
- Don't duplicate affinity; mood couples to it, doesn't replace it.

## Build order (✓ = shipped 2026-06-24)

1. ✓ **Labeled-emotion projection** (pure read) — `deriveEmotionLabel` + `EmotionLabel`
   in `src/contracts/mood/`. Zero new state, fully unit-tested.
2. ✓ **Event→mood table + coupling matrix** — touch welcome-ness, condition + atmosphere
   baseline shifts (pure, tested). Split into **impulse** (one-time delta) vs **standing**
   (baseline shift) modes — see spec §5.
3. **Wire the v1 event sources** into the merge — ✓ welcome/unwelcome touch, ✓ conditions
   (baseline shift in drift), ✓ **scene atmosphere** (producer + wiring shipped 2026-06-24,
   [scene-atmosphere.plan.md](scene-atmosphere.plan.md)). Story beats, presence, physical
   cross-talk, intimacy beats are later.
4. **UI surfacing** — ✓ mood chip (cast card / `StatusParticipant.emotion`); ⏳ the
   relationship/meter timeline.
5. ✓ **Chat** — the chat already moved mood (the reaction pulse); the **labeled projection**
   now surfaces as a mood chip in the chat strip (`ChatStateSnapshot.emotion`, computed in
   `chatStateSnapshot` with the character's dominance + intimate-capable context). The chip
   is a shared `MoodChip` component reused by the cast card.
6. ⏳ **Avatar** — the avatar cue consumes `deriveEmotionLabel` + widens its enum to the
   11 ([avatar-3d.plan.md](avatar-3d.plan.md)).

### Shipped 2026-06-24

`src/contracts/mood/` (`emotion-label`, `atmosphere`, `affinity`, `projection`, `events`
+ tests, wired through `contracts/index.ts`): the locked 11-label `EmotionLabel`, the
total `deriveEmotionLabel` projection (activation axis + precedence ladder), the
`AtmosphereLabel` enum (mood owns it until the avatar lands), welcome/unwelcome touch
(`resolveTouchWelcomeness` + `touchMoodDeltas`, wired into `merge.ts planReactionAffinity`
as the no-preference affinity-gated fallback + a stress hit), the condition→mood baseline
shift (wired into the drift loop), and the mood chip — a shared `MoodChip`
(`components/ui/mood-chip.tsx`) on both the cast card (`status-payload.ts`/
`participant-card.tsx`) and the character-chat strip (`ChatStateSnapshot.emotion` via
`chatStateSnapshot`, `character-chat.tsx`). The scene-atmosphere producer shipped
separately ([scene-atmosphere.plan.md](scene-atmosphere.plan.md)). Deferred: the
meter/relationship timeline and the avatar consumption.

## Decisions (resolved 2026-06-24)

No open questions remain — the rulings, with detail recorded in the spec:

- **v1 event vocabulary** — social reactions (exists) + **welcome/unwelcome touch** +
  **conditions** + **scene atmosphere**. Story beats, presence, physical cross-talk,
  and intimacy beats are a later slice. (Detail: §"event→mood table"; spec §5.)
- **Welcome vs. unwelcome touch** — welcome-ness is **affinity-stage gated with a
  preference override**: welcome at/above a warmth stage (mood ↑), unwelcome below it
  (mood ↓, stress ↑), trait-damped (composure/agreeableness); an explicit
  like/dislike preference overrides the stage default. Reuses the reaction curve's
  affinity terms — no new authoring. (Detail: spec §5 "Welcome/unwelcome touch".)
- **`EmotionLabel` enum** — **locked at 11** app-wide (spec §2): the original 8 plus
  `playful`, `flustered`, and the intimate-gated `aroused`. Mood owns the enum; the
  avatar cue widens to match. The valence×activation→label thresholds are *starting
  values* tuned in playtest. (Ruling: spec §2/§4.)
- **Atmosphere as input vs. channel** — **confirmed**: scene atmosphere _nudges_ mood
  (trait-damped) while staying a _separate_ avatar channel, so a composed companion
  holds calm in a tense room. (Design principle above; spec §5.)
- **Per-relationship mood** — **kept deferred** (personality §11): one mood per
  character, not per-edge, for now. (Scope boundaries above.)
- **Decay/return cadence** — the existing meter recovery (0.06/hr toward 0.5) is
  **enough for v1**; event-driven return-to-baseline beats come later as the sim
  grows more realistic. No new mechanism this slice.

## Related

- `docs/developer-notes/finished/personality-and-state.spec.md` §4 (mood) / §11 —
  the deferred event→mood table this graduates, and the design truth.
- [avatar-3d.plan.md](avatar-3d.plan.md) / [avatar-3d.notes.md](avatar-3d.notes.md)
  — the avatar consumes the labeled-emotion projection + reaction beat.
- [character-chat-state.plan.md](../finished/character-chat-state.plan.md) (shipped) —
  chat-scale mood reuses this system.
- [intimacy-notes.plan.md](intimacy-notes.plan.md),
  [social-reaction-cards.plan.md](social-reaction-cards.plan.md) — feed mood inputs.
- [deferred.plan.md](../deferred.plan.md) "Relationship & meter timeline" (#4) — mood
  surfacing; `npc-puppeting.deferred.md` — a downstream consumer.
