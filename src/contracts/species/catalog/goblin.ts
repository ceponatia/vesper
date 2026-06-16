import { defineSpecies } from "../types";
import { DEFAULT_BODY_PLAN_ID } from "../../body/plans";

export const goblin = defineSpecies({
  id: "goblin",
  label: "Goblin",
  aliases: ["goblins", "goblin-like", "goblinoid"],
  bodyPlanId: DEFAULT_BODY_PLAN_ID,
  description: "A humanoid fantasy species with goblin presentation: small, with large pointed ears.",
  lore: "",
  attributeRules: [
    {
      attributeId: "build.height",
      applicability: "required",
      defaultValue: "very_short",
      allowedValues: ["very_short", "short"],
    },
    {
      attributeId: "ears.shape",
      applicability: "required",
      defaultValue: "large",
      allowedValues: ["pointed", "long_pointed", "large", "protruding"],
      notes: "Large, often pointed ears.",
    },
  ],
});
