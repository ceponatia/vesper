import { defineSpecies } from "../types";
import { DEFAULT_BODY_PLAN_ID } from "../../body/plans";
import { organicHumanoidSensoryRules } from "./humanoid-sensory";

export const gnome = defineSpecies({
  id: "gnome",
  label: "Gnome",
  aliases: ["gnomes", "gnomish", "gnome-like"],
  bodyPlanId: DEFAULT_BODY_PLAN_ID,
  description:
    "A humanoid fantasy species with gnomish presentation: the smallest of the common folk.",
  appearance:
    "The smallest of the common folk, with a slight, slender frame, fine sharp features, and quick, bright eyes.",
  lore: "Gnomes are short humanoids loosely related to Dwarves and Goblins, and are highly adept at engineering and technological development. It was the Gnomes who invented modern computing, spaceflight, and other modern marvels. They stand at roughly the height of an adolescent human (4-feet tall) and have generally a more slender frame than Dwarves do.",
  attributeRules: [
    ...organicHumanoidSensoryRules,
    {
      attributeId: "build.height",
      applicability: "required",
      defaultValue: "very_short",
      allowedValues: ["very_short", "short"],
      notes: "Gnomes are the smallest of the common humanoid folk.",
    },
  ],
});
