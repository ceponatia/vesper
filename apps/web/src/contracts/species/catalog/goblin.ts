import { defineSpecies } from "../types";
import { DEFAULT_BODY_PLAN_ID } from "../../body/plans";
import { organicHumanoidSensoryRules } from "./humanoid-sensory";

export const goblin = defineSpecies({
  id: "goblin",
  label: "Goblin",
  aliases: ["goblins", "goblin-like", "goblinoid"],
  bodyPlanId: DEFAULT_BODY_PLAN_ID,
  description:
    "A humanoid fantasy species with goblin presentation: small, with large pointed ears.",
  appearance:
    "Short and wiry, with a greenish cast to the skin and long, floppy, oversized ears.",
  lore: "Goblins are distant relatives to gnomes and have been looked down upon by society, even in contemporary times. They are known for their slightly green skin, long floppy ears, and skill with machinery (though less so digital technology). They share the short height of gnomes, standing at about 4 feet tall on average.",
  attributeRules: [
    ...organicHumanoidSensoryRules,
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
