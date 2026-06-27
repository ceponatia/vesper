import { describe, expect, it } from "vitest";
import type { EvaluatedReaction } from "../personality/reactions";
import { avatarCueSchema } from "./cue";
import { type AvatarCueInputs, deriveAvatarCue, deriveReactionBeat, poseFromPosture } from "./derive";

const baseEmotion = { emotion: "neutral", intensity: 0.2 } as const;

function inputs(over: Partial<AvatarCueInputs> = {}): AvatarCueInputs {
  return { emotion: { ...baseEmotion }, sceneId: "chat-1", ...over };
}

function reaction(over: Partial<EvaluatedReaction> = {}): EvaluatedReaction {
  return { valence: "like", magnitude: 1, band: "is mildly pleased", hint: "", ...over };
}

describe("poseFromPosture", () => {
  it("defaults to idle for empty/unknown posture", () => {
    expect(poseFromPosture(null)).toBe("idle");
    expect(poseFromPosture("")).toBe("idle");
    expect(poseFromPosture("stands there ambiguously")).toBe("idle");
  });

  it("maps keywords to the right stance, most-specific first", () => {
    expect(poseFromPosture("she reclines on the bed")).toBe("reclining");
    expect(poseFromPosture("crosses her arms, guarded")).toBe("guarded");
    expect(poseFromPosture("turns partly away, distant")).toBe("withdrawn");
    expect(poseFromPosture("leans in close to reassure him")).toBe("reassuring");
    expect(poseFromPosture("bounces, animated and excited")).toBe("excited");
    expect(poseFromPosture("glances aside, thinking it over")).toBe("thinking");
    expect(poseFromPosture("open and receptive")).toBe("open");
  });
});

describe("deriveReactionBeat", () => {
  it("is none with no reaction or a sub-threshold one", () => {
    expect(deriveReactionBeat(undefined, undefined, "neutral")).toBe("none");
    expect(deriveReactionBeat(reaction({ magnitude: 0.1 }), undefined, "neutral")).toBe("none");
  });

  it("startles on a boundary push regardless of valence", () => {
    expect(deriveReactionBeat(reaction({ valence: "dislike", magnitude: 3 }), "boundary_push", "angry")).toBe("gasp");
  });

  it("blushes on a flirt when the baseline already reads flustered", () => {
    expect(deriveReactionBeat(reaction({ magnitude: 1 }), "flirt", "flustered")).toBe("blush");
  });

  it("does not blush on a flirt once at ease (not flustered)", () => {
    expect(deriveReactionBeat(reaction({ magnitude: 1 }), "flirt", "affectionate")).toBe("nod");
  });

  it("scales liked/disliked beats by magnitude", () => {
    expect(deriveReactionBeat(reaction({ magnitude: 1 }), undefined, "happy")).toBe("nod");
    expect(deriveReactionBeat(reaction({ magnitude: 3 }), undefined, "happy")).toBe("laugh");
    expect(deriveReactionBeat(reaction({ valence: "dislike", magnitude: 1 }), undefined, "sad")).toBe("sigh");
    expect(deriveReactionBeat(reaction({ valence: "dislike", magnitude: 3 }), undefined, "angry")).toBe("flinch");
  });
});

describe("deriveAvatarCue", () => {
  it("produces a schema-valid cue from minimal inputs", () => {
    const cue = deriveAvatarCue(inputs());
    expect(avatarCueSchema.safeParse(cue).success).toBe(true);
    expect(cue.character.emotion).toBe("neutral");
    expect(cue.character.pose).toBe("idle");
    expect(cue.character.reaction).toBe("none");
    expect(cue.environment.atmosphere).toBe("calm");
    expect(cue.environment.sceneId).toBe("chat-1");
  });

  it("carries the derived emotion + clamps intensity", () => {
    const cue = deriveAvatarCue(inputs({ emotion: { emotion: "affectionate", intensity: 1.4 } }));
    expect(cue.character.emotion).toBe("affectionate");
    expect(cue.character.intensity).toBe(1);
  });

  it("holds short for a reaction beat, long for a settled baseline", () => {
    const beat = deriveAvatarCue(inputs({ reaction: reaction({ magnitude: 3 }) }));
    expect(beat.character.reaction).toBe("laugh");
    expect(beat.timing.holdMs).toBeLessThan(2_000);

    const settled = deriveAvatarCue(inputs());
    expect(settled.timing.holdMs).toBeGreaterThanOrEqual(5_000);
  });

  it("picks the transition from scene/emotion change flags", () => {
    expect(deriveAvatarCue(inputs({ sceneChanged: true })).timing.transition).toBe("cut");
    expect(deriveAvatarCue(inputs({ emotionChanged: false })).timing.transition).toBe("soft");
    expect(deriveAvatarCue(inputs({ emotionChanged: true })).timing.transition).toBe("crossfade");
    expect(deriveAvatarCue(inputs()).timing.transition).toBe("crossfade");
  });

  it("passes atmosphere + outfit through", () => {
    const cue = deriveAvatarCue(inputs({ atmosphere: "romantic", outfitId: "evening-1" }));
    expect(cue.environment.atmosphere).toBe("romantic");
    expect(cue.wardrobe.outfitId).toBe("evening-1");
  });
});
