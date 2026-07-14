import { defineAttributeGroup } from "../types";

export const movementGroup = defineAttributeGroup("movement", [
  {
    id: "movement.gait",
    label: "Gait",
    kind: "physical",
    category: "movement",
    valueType: "enum",
    description: "How the character habitually moves through space; injuries override via conditions.",
    mutability: "mutable",
    allowedValues: [
      "gliding", "light", "brisk", "purposeful", "ambling",
      "swaggering", "prowling", "bouncing", "heavy", "shuffling",
    ],
    aliases: ["gait", "walk", "stride"],
    // Slice-4 authoring batch (attribute-narrator-guidance.plan.md) — DRAFTS AWAITING
    // OWNER REVIEW. Gait = how the walk reads only. Sparse: brisk/purposeful stay bare.
    narratorGuidance: {
      gliding: "smooth and floating — feet barely seem to land",
      light: "quiet, weightless steps — barely heard coming",
      swaggering: "loose, cocky roll of shoulders and hips",
      prowling: "low, deliberate, predatory — a hunter's walk",
      ambling: "relaxed and meandering, in no hurry",
      bouncing: "springy and buoyant, energy in every step",
      heavy: "each step lands with weight and force",
      shuffling: "dragging, low-effort steps that scuff the floor",
    },
  },
  {
    id: "movement.posture_default",
    label: "Default posture",
    kind: "physical",
    category: "movement",
    valueType: "enum",
    description: "Resting posture when unobserved; scene posture in participant state overrides it.",
    mutability: "mutable",
    allowedValues: [
      "ramrod_straight", "upright", "relaxed", "easy", "languid",
      "coiled", "stiff", "slouched", "hunched",
    ],
    aliases: ["posture", "bearing"],
    promptHints: ["Treat default posture as the baseline the character returns to between beats."],
    // Slice-4 authoring batch (attribute-narrator-guidance.plan.md) — DRAFTS AWAITING
    // OWNER REVIEW. Posture = the resting carriage of the body. Sparse: upright/relaxed stay bare.
    narratorGuidance: {
      ramrod_straight: "rigidly erect — a military spine, no give",
      easy: "loose and open, no tension held anywhere",
      languid: "draped and loose, weight poured into the lean",
      coiled: "taut and ready, spring-loaded to move",
      stiff: "held tight and unrelaxed, tension in the line",
      slouched: "shoulders dropped, spine curved and casual",
      hunched: "curled inward, shoulders up toward the ears",
    },
  },
]);
