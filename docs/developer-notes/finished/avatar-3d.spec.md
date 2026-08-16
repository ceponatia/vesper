# Avatar cue & rendering — design truth (spec)

Status: **draft** — the design detail behind [avatar-3d.plan.md](avatar-3d.plan.md).
Owns the **`AvatarCue`** contract and the avatar-only enums (`PoseLabel`,
`ReactionLabel`, `AtmosphereLabel`, `TransitionLabel`) + the **asset manifest** and
the **state→cue derivation**. `EmotionLabel` is imported from
[mood.spec.md](../finished/mood.spec.md) (mood owns it). Read the plan first.

Slug `avatar-3d`. The cue is **renderer-neutral** — sprites today, Rive/VRM later
read the same contract.

## 1. The `AvatarCue` contract

Four channels, never collapsed to one "mood" (a tense scene ≠ a panicked
companion). Zod-validated at the trust boundary; serialized to the client.

```ts
const AvatarCueSchema = z.object({
  character: z.object({
    emotion: EmotionLabelSchema,            // imported from contracts/mood
    intensity: z.number().min(0).max(1),    // expression weight
    pose: PoseLabelSchema,
    reaction: ReactionLabelSchema.default("none"),  // one-shot beat
  }),
  environment: z.object({
    atmosphere: AtmosphereLabelSchema,      // scene tone, NOT character sentiment
    sceneId: z.string(),                    // continuity key
  }),
  wardrobe: z.object({
    outfitId: z.string(),
  }),
  timing: z.object({
    transition: TransitionLabelSchema,
    holdMs: z.number().int().min(500).max(30_000),
  }),
});
```

The model never authors this raw — it is **derived** (§3) and `parseOr`'d. No field
is ever a filename/URL; controlled enum values resolve through the manifest (§4).

## 2. The avatar-only enums

### `PoseLabel` — body stance (from `activityUpdates.posture`)

| `PoseLabel` | Reads as |
| --- | --- |
| `idle` | neutral resting |
| `open` | receptive, leaning in |
| `thinking` | considering, glancing aside |
| `guarded` | closed, arms crossed |
| `reassuring` | leaning toward, attentive |
| `excited` | animated, energized |
| `withdrawn` | turned partly away, distant |
| `reclining` | relaxed / lying (intimate or at-ease scenes) |

### `ReactionLabel` — one-shot beats (procedural or a frame)

`none` · `nod` · `shake` (no) · `laugh` · `gasp` · `flinch` · `sigh` · `blush` ·
`perk` (perk-up). Played once for `holdMs`, then the face returns to baseline.

### `AtmosphereLabel` — scene tone (also a mood input, see mood.spec §5)

`calm` · `warm` · `romantic` · `tense` · `ominous` · `melancholy` · `hopeful`.

### `TransitionLabel`

`cut` (instant — rare) · `crossfade` (default expression change) · `soft` (slow,
for settling to baseline).

## 3. State → cue derivation (token-free)

Each field comes from state the engine already computes — **no new LLM leg**:

| Cue field | Source |
| --- | --- |
| `character.emotion` + `intensity` | `deriveEmotionLabel(...)` ([mood.spec.md](../finished/mood.spec.md) §4) |
| `character.reaction` | the latest social-reaction band → `ReactionLabel` (liked→`nod`/`laugh`; disliked→`flinch`/`sigh`; surprise/boundary→`gasp`; flirt-low-affinity→`blush`) |
| `character.pose` | `activityUpdates.posture` (free text) → `PoseLabel` via keyword map; default `idle` (a `poseId` registry is the later, cleaner source) |
| `environment.atmosphere` | location ambient + director scene tone → `AtmosphereLabel`; default `calm` |
| `environment.sceneId` | active location / chat id |
| `wardrobe.outfitId` | session wardrobe (`item_instances`) / character `defaultOutfit` |
| `timing.transition` | `crossfade` on emotion change, `soft` settling, `cut` only on scene change |
| `timing.holdMs` | short for a reaction beat, long for a held baseline |

Derivation is pure (`src/contracts`/`src/lib`); it's built where the turn result is
assembled and serialized into the turn stream. The **client renderer never imports
`server/*`** (CLAUDE.md boundaries) — it receives the validated cue.

**Two derivation surfaces (shipped).** (1) **Character-chat** — `chatStateSnapshot`
(`engine/chat-state.ts`) wraps the chat state's emotion (pose `idle`, atmosphere `calm`).
(2) **In-session play** — `buildStatusPayload` derives an `avatarCue` per participant from
the richer session state (real `posture` → pose, `bundle.brief.atmosphere`, active location
as `sceneId`) and ships it on `StatusParticipant` alongside the library `characterId` (the
manifest key). The standing avatar mounts in the Scene tab for the **stable focal** NPC
(present-with-player → companion → tier → id; never the per-turn reaction target, so it
doesn't swap mid-scene).

**The one-shot beat (in-session).** The cue's `reaction` is always `none` in the payload;
the transient beat travels a **separate top-level `reactionBeat`** ({participantId, concept,
valence, magnitude, turn}). It is sourced from the **merge** — `planReactionAffinity` emits a
`ReactionBeat` on both the carded-reaction branch (the curve verdict, agreeing with the
narrator's `## Reaction` line) **and** the un-carded **touch** branch (synthesized from
welcome-ness — the romance beats the pre-narration evaluator misses), threaded
`ctx.reactionResult.beat` → `MergePlan.reactionBeat` → `apply.ts` writes
`agentResults.reaction`. The status route projects it with the turn number; the client fires
it **once** via a mount-baseline guard (`reactionBeat.turn > baseline` and the target is the
focal), reusing the chat avatar's `beatTick` mechanism. Surfacing touch reactions to the
**narrator** line (not just the avatar) is a deferred follow-up.

## 4. Asset manifest & lazy-gen keying

Controlled enum values map to asset keys; keys resolve to generated/cached frames
(or procedural motion presets for reactions):

```ts
// As shipped (contracts/avatar/cue.ts) — emotion/pose/outfit → image-row id, plus the
// always-present base. Reactions are NOT in the manifest (they are procedural motion). The
// keys are plain strings so an unknown tag never throws at the parse boundary.
type AvatarManifest = {
  baseImageId: string | null;                       // the canonical avatar (fallback frame)
  expressions: Record<EmotionLabel, AssetKey>;      // the only channel slice 3 generates
  poses: Record<PoseLabel, AssetKey>;               // reserved; not generated yet (renderer reads only expressions)
  outfits: Record<string /*outfitId*/, AssetKey>;   // reserved
};
```

A renderable still is keyed by **(emotion × pose × outfit × exposure)**, where
*exposure* is the rendered region-coverage state (`covered`/`sheer`/`bare` from
`resolveWardrobeVisibility`) — i.e. what the frame actually shows, distinct from the
`aroused` emotion's intimate-context gate (mood.spec §2). Slice 3 generates the
**expression** channel only (the renderer reads only that); pose/outfit/exposure stay the
lazy-gen seam. Reaction beats are mostly **procedural motion** (a scale-bounce, a
quick overlay), not generated frames.

**Staleness keying — Model B (shipped 2026-06-30, supersedes the `sourceImageId` filter
idea).** The manifest has **no avatar-membership filter**: `loadAvatarManifest` is
newest-wins per `meta.avatarExpression`. A frame belongs to whatever avatar it was edited
from; when the canonical **face changes** (regen / promote / upload),
`clearAvatarExpressionFrames` deletes the stale set and seed/lazy-gen refill. A
`sourceImageId === avatarImageId` filter was rejected — `cloneEntityImages` writes
`sourceImageId` as original-image provenance and clones remap only `avatarImageId`, so that
filter would strip every frame from a cloned character. Model B is clone-safe by
construction (a clone's avatar is a pixel-copy, so its copied frames still depict it).

## 5. The layering decision (key asset-architecture question)

How granular are the generated assets?

- **Full-frame per combo** (simplest for AI-gen): each (emotion, pose, outfit) is one
  flat image. Easy to generate via the existing identity-locked pipeline; more assets,
  but lazy-gen bounds them to what occurs. **Recommended v1.**
- **Layered** (GPT's model): body/pose layer + transparent face/expression overlay +
  outfit layer, composited at runtime → far fewer assets (N+M+K, not N×M×K). But
  AI-generated portraits don't cleanly separate a registered, alignable face overlay
  — producing aligned transparent layers from a generator is itself hard.

**Lean: full-frame + lazy-gen for v1** (leans on the pipeline we have); revisit
layering if asset volume bites or when moving to a Rive/VRM rig (where layering is
native and this question dissolves). Record the choice when made.

## 6. Runtime & resilience

- **Renderer interface** (notes): `AvatarRenderer { preload; apply; playReaction;
  dispose }`; implementations `Sprite → Rive → ThreeVrm`. `AvatarDirector` owns the
  cue→renderer flow.
- **State split**: Zustand (persistent: scene, outfit, baseline emotion,
  reduced-motion) · XState (transient: load→ready, reaction queue, crossfade timing,
  return-to-baseline, interruption/priority).
- **Hysteresis**: don't re-baseline on every slightly-different label; hold the
  baseline, let beats pulse, change sustained emotion only at beat boundaries.
- **Degradation**: unknown enum / missing asset → `parseOr` to `neutral`/`idle`/
  `none` and the nearest cached frame; honor `prefers-reduced-motion` (freeze idle
  loops, keep a static expression). Never block the turn.

## Related

- [avatar-3d.plan.md](avatar-3d.plan.md) — scope, renderer options, build order.
- [avatar-3d.notes.md](avatar-3d.notes.md) — GPT's `AvatarCue`/`AvatarDirector`
  source design (Motion/Rive/VRM specifics).
- [mood.spec.md](../finished/mood.spec.md) — `EmotionLabel` + `deriveEmotionLabel` (consumed
  here); `AtmosphereLabel` is defined here and imported there as a mood input.
- `docs/images.md` — the identity-locked pipeline that generates the frames.
