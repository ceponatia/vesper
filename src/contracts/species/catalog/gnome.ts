import { defineSpecies } from "../types";
import { DEFAULT_BODY_PLAN_ID } from "../../body/plans";

export const gnome = defineSpecies({
  id: "gnome",
  label: "Gnome",
  aliases: ["gnomes", "gnomish", "gnome-like"],
  bodyPlanId: DEFAULT_BODY_PLAN_ID,
  description: "A humanoid fantasy species with gnomish presentation: the smallest of the common folk.",
  lore: "",
  attributeRules: [
    {
      attributeId: "build.height",
      applicability: "required",
      defaultValue: "very_short",
      allowedValues: ["very_short", "short"],
      notes: "Gnomes are the smallest of the common humanoid folk.",
    },
  ],
});
