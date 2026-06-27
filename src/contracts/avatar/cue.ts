import { z } from "zod";
import { atmosphereLabelSchema, emotionLabelSchema } from "../mood";

/**
 * The avatar **cue** contract (docs/developer-notes/avatar-3d.spec.md §1). A
 * renderer-neutral, four-channel description of what the avatar should show *now* —
 * never collapsed to one "mood" (a tense scene ≠ a panicked companion). It is
 * **derived** from already-computed state (`deriveAvatarCue`, no new LLM leg), Zod-
 * validated, and serialized to the client, where the renderer maps its controlled
 * enum values through the per-character **manifest** (§4). No field is ever a
 * filename/URL — the model never authors this.
 *
 * `EmotionLabel`/`AtmosphereLabel` are imported from `contracts/mood` (mood owns
 * them); this module owns the avatar-only enums below.
 */

// --- Avatar-only enums (spec §2) ------------------------------------------------

/** `PoseLabel` — body stance, mapped from free-text `activityUpdates.posture`. */
export const poseLabelEnum = z.enum([
  "idle", // neutral resting
  "open", // receptive, leaning in
  "thinking", // considering, glancing aside
  "guarded", // closed, arms crossed
  "reassuring", // leaning toward, attentive
  "excited", // animated, energized
  "withdrawn", // turned partly away, distant
  "reclining", // relaxed / lying (intimate or at-ease scenes)
]);
export type PoseLabel = z.infer<typeof poseLabelEnum>;
export const POSE_LABELS = poseLabelEnum.options;
/** Parse-boundary schema (resilience.md): an unknown pose degrades to `idle`. */
export const poseLabelSchema = poseLabelEnum.catch("idle");

/** `ReactionLabel` — one-shot beats (mostly procedural motion, some a frame). */
export const reactionLabelEnum = z.enum([
  "none",
  "nod",
  "shake", // a "no"
  "laugh",
  "gasp",
  "flinch",
  "sigh",
  "blush",
  "perk", // perk-up
]);
export type ReactionLabel = z.infer<typeof reactionLabelEnum>;
export const REACTION_LABELS = reactionLabelEnum.options;
/** Parse-boundary schema: an unknown beat degrades to `none` (no beat). */
export const reactionLabelSchema = reactionLabelEnum.catch("none");

/** `TransitionLabel` — how a frame change plays. */
export const transitionLabelEnum = z.enum([
  "cut", // instant — rare, only on a scene change
  "crossfade", // default expression change
  "soft", // slow, settling to baseline
]);
export type TransitionLabel = z.infer<typeof transitionLabelEnum>;
export const TRANSITION_LABELS = transitionLabelEnum.options;
export const transitionLabelSchema = transitionLabelEnum.catch("crossfade");

// --- The cue (spec §1) ----------------------------------------------------------

/** A held baseline runs this long before it's considered for re-evaluation. */
export const BASELINE_HOLD_MS = 6_000;
/** A one-shot reaction beat plays this long, then the face returns to baseline. */
export const REACTION_HOLD_MS = 1_200;
export const CUE_HOLD_MS_MIN = 500;
export const CUE_HOLD_MS_MAX = 30_000;

export const avatarCueSchema = z.object({
  character: z.object({
    emotion: emotionLabelSchema,
    /** Expression weight, 0..1 (slight smile → beam). */
    intensity: z.number().min(0).max(1).catch(0),
    pose: poseLabelSchema,
    /** One-shot beat layered over the baseline expression. */
    reaction: reactionLabelSchema.default("none"),
  }),
  environment: z.object({
    /** Scene tone — NOT the character's sentiment. */
    atmosphere: atmosphereLabelSchema,
    /** Continuity key (active location / chat id); not sentiment. */
    sceneId: z.string().catch(""),
  }),
  wardrobe: z.object({
    outfitId: z.string().catch(""),
  }),
  timing: z.object({
    transition: transitionLabelSchema,
    holdMs: z.number().int().min(CUE_HOLD_MS_MIN).max(CUE_HOLD_MS_MAX).catch(BASELINE_HOLD_MS),
  }),
});
export type AvatarCue = z.infer<typeof avatarCueSchema>;

/**
 * The safe degraded cue (resilience.md): a neutral, idle, calm baseline. Used as the
 * `parseOr` fallback at the client trust boundary and before the first real cue lands.
 */
export const NEUTRAL_AVATAR_CUE: AvatarCue = {
  character: { emotion: "neutral", intensity: 0, pose: "idle", reaction: "none" },
  environment: { atmosphere: "calm", sceneId: "" },
  wardrobe: { outfitId: "" },
  timing: { transition: "soft", holdMs: BASELINE_HOLD_MS },
};

// --- The asset manifest (spec §4) -----------------------------------------------

/**
 * Per-character map from cue values to renderable assets (spec §4). Reactions are
 * mostly **procedural** (no frame), so they're absent here; expressions/poses/outfits
 * resolve to image-row ids. Partial — lazy-gen fills it over time; a render miss falls
 * back to `baseImageId` (the canonical avatar). Built server-side from image rows
 * (`loadAvatarManifest`); the model never invents keys. A Zod schema (not just a type) so
 * the client `parseOr`s it at the trust boundary — every field `.catch`es to empty/null.
 *
 * Keys are plain strings (not the `EmotionLabel`/`PoseLabel` unions) so an unknown tag on
 * a row never throws at the boundary; the renderer indexes by the cue's typed label.
 */
export const avatarManifestSchema = z.object({
  /** The canonical avatar — the always-present fallback frame. Null ⇒ no avatar yet. */
  baseImageId: z.string().nullable().catch(null),
  /** emotion label → image-row id (the resting frame for that expression). */
  expressions: z.record(z.string(), z.string()).catch({}),
  /** pose label → image-row id (later; empty for the slice-2 PoC). */
  poses: z.record(z.string(), z.string()).catch({}),
  /** outfitId → image-row id (later). */
  outfits: z.record(z.string(), z.string()).catch({}),
});
export type AvatarManifest = z.infer<typeof avatarManifestSchema>;

/** An empty manifest with no frames — the degraded default. */
export const EMPTY_AVATAR_MANIFEST: AvatarManifest = {
  baseImageId: null,
  expressions: {},
  poses: {},
  outfits: {},
};
