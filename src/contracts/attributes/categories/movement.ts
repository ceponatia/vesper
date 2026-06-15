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
  },
]);
