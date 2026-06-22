# Mood — app-wide emotional state (plan)

Status: **draft** — not settled. Graduates the **event→mood table** that
`personality-and-state` deferred (spec §4: *"the event→mood inputs and the full
coupling matrix are planned with the mood slice"*) and promotes **mood** to a
first-class, cross-app read with multiple consumers — the avatar being only one.

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
2. **No labeled read.** Consumers that need a *discrete emotion* (the avatar cue's
   `emotion`, a UI mood chip) have only a `0–1` valence + a prose descriptor. This
   plan adds a pure **labeled-emotion projection**.

## What already exists (do not rebuild)

| Piece | State | Source |
| --- | --- | --- |
| **`mood` meter** | valence `0`(low)–`0.5`(even)–`1`(bright); baseline 0.5, recovery 0.06/hr; trait `optimism` shifts baseline | `src/contracts/meters/registry.ts:94` |
| **`deriveMoodDescriptor()`** | blends mood × stress × energy → prose ("bright and playful"); fed to the narrator | `:156`, `engine/scene.ts:946` |
| **Mood ↔ affinity coupling** | mood scales reaction magnitude (`μ`); a reaction nudges mood (affinity-scaled) | `contracts/personality/reactions.ts`, `modulation.ts`, `engine/merge.ts` |
| **Trait-derived baselines** | `optimism→mood.baseline`, `libido→arousal`, `composure→stress.recovery` via `personalizeMeters` | `engine/merge.ts` |

## Design principles (from personality-and-state spec §4 — the truth)

- **One valence axis + a derived read — NOT a multi-axis mood vector.** The
  codebase already carries a PAD-ish picture: `arousal` (meter), `stress`/`energy`
  (activation/tension), `dominance` (trait), and `mood` (valence). Mood stays a
  *read* over these, never a second source of truth. Any "emotion" is a projection,
  not stored state.
- **Mood is transient; affinity is standing.** Mood = how she feels *right now*
  (driven by interactions **and** events); affinity = overall regard. Don't blur
  them — they *couple*, they aren't the same axis.
- **Deterministic, pure, testable.** The event→mood table is data (like the
  reaction curve / `modulation.ts`); the merge applies it as bounded, clamped math.
  Constants live in `contracts` (IO-free), per the existing pattern.
- **Resilience.** `parseOr` at boundaries; a missing/odd input degrades to drift,
  never a failed turn (`docs/resilience.md`).

## The event→mood table (headline new piece)

Today only the social-reaction curve moves mood. Generalize to a **registry of
event kinds → mood deltas**, each scaled by the coupling matrix (affinity/traits).
Candidate inputs (lock the v1 subset in open questions):

- **Social reactions** (exists) — keep; the curve's `reactionMagnitude` is one row.
- **Scene atmosphere** — a tense/ominous scene depresses mood + raises stress; a
  warm/romantic one lifts it. *Note the avatar keeps scene `atmosphere` as a
  separate channel (a tense scene ≠ a panicked character) — atmosphere is an
  **input** to her mood, weighted by traits (composure), not an override.*
- **Conditions** — `tipsy`/`flustered`/`hurt` already carry prompt hints; map each
  to a mood delta (reuse `conditions/` effects).
- **Story beats** — director thread signals (develop/resolve) nudge mood (a
  resolved arc lifts; a betrayal drops).
- **Physical state cross-talk** — low energy/hygiene drags mood; rest restores it
  (meter→meter, already half-expressed via baselines).
- **Presence** — high-affinity company lifts a low mood a little (spec §4 Note 5);
  isolation lets it sag toward baseline.
- **Intimacy beats** — arousal/exposure progression (gated, ties to
  [intimacy-notes.plan.md](intimacy-notes.plan.md)).

**Coupling matrix** (extend what shipped): affinity scales how far an event moves
mood; mood scales reaction magnitude (`μ`, exists); traits damp/amplify
(`composure` steadies, `optimism` raises the floor). Document the full matrix here
as it's built; keep every path clamped.

## The labeled-emotion projection (the read consumers need)

A pure function — sibling to `deriveMoodDescriptor` — mapping the emotion state to
a **discrete label + intensity**:

```
(mood, arousal, stress, energy, recentReactionBand, conditions)
  → { emotion: EmotionLabel, intensity: 0..1 }
```

- **Baseline** comes from the meters (valence × activation/tension); the **transient
  beat** comes from the latest social-reaction band (a flash of delight/hurt that
  decays). Two timescales, one read.
- **Lock one `EmotionLabel` vocabulary app-wide** and share it with the avatar cue
  (`neutral`/`happy`/`concerned`/`sad`/`angry`/`afraid`/`surprised`/`affectionate`
  — align with [avatar-3d.notes.md](avatar-3d.notes.md)). This is the single enum
  the avatar, UI, and any future consumer agree on.
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
- **Character-chat** — chat-scale mood via [character-chat-state.plan.md](character-chat-state.plan.md)
  (its light-state slice reuses this system, not a parallel one).
- **NPC puppeting** — richer contradiction judging "once mood exists"
  (`npc-puppeting.deferred.md`).

## Scope boundaries (v1)

- **One valence axis**, derived reads only — no multi-axis vector.
- **Player-driven events** for classification in v1 (NPC→NPC mood deferred, per
  personality scope).
- **Per-relationship mood deferred** (personality §11) — one mood per character,
  not per-edge, for now.
- Don't duplicate affinity; mood couples to it, doesn't replace it.

## A possible build order

1. **Labeled-emotion projection** (pure read) — unblocks the avatar cue
   immediately, zero new state, fully unit-testable.
2. **Event→mood registry + coupling matrix** — generalize the lone social-reaction
   nudge into a table of event kinds with affinity/trait scaling.
3. **Wire event sources** into the merge (scene atmosphere, conditions, beats,
   presence), one source at a time, each with a degradation test.
4. **UI surfacing** — mood chip; then the relationship/meter timeline.
5. **Chat** — fold into `character-chat-state`'s light-state slice.

## Open questions

- **v1 event vocabulary** — which inputs move mood first (lean: social reactions +
  conditions + scene atmosphere; defer beats/presence/intimacy)?
- **`EmotionLabel` enum** — lock the shared vocabulary (with the avatar cue) and
  the valence×activation→label mapping thresholds.
- **Atmosphere as input vs channel** — confirm scene atmosphere *nudges* mood
  (trait-damped) while remaining a *separate* avatar channel (so a calm companion
  can hold a tense scene).
- **Per-relationship mood** — keep deferred, or needed sooner for multi-character
  scenes?
- **Decay/return cadence** — is the existing meter recovery enough, or does mood
  need event-driven return-to-baseline beats (e.g. after a reaction spike)?

## Related

- `docs/developer-notes/finished/personality-and-state.spec.md` §4 (mood) / §11 —
  the deferred event→mood table this graduates, and the design truth.
- [avatar-3d.plan.md](avatar-3d.plan.md) / [avatar-3d.notes.md](avatar-3d.notes.md)
  — the avatar consumes the labeled-emotion projection + reaction beat.
- [character-chat-state.plan.md](character-chat-state.plan.md) — chat-scale mood
  reuses this system.
- [intimacy-notes.plan.md](intimacy-notes.plan.md),
  [social-reaction-cards.plan.md](social-reaction-cards.plan.md) — feed mood inputs.
- [deferred.plan.md](deferred.plan.md) "Relationship & meter timeline" (#4) — mood
  surfacing; `npc-puppeting.deferred.md` — a downstream consumer.
