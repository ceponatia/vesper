import { defineSpecies } from "../types";
import { DEFAULT_BODY_PLAN_ID } from "../../body/plans";

export const dwarf = defineSpecies({
  id: "dwarf",
  label: "Dwarf",
  aliases: ["dwarves", "dwarven", "dwarf-like"],
  bodyPlanId: DEFAULT_BODY_PLAN_ID,
  description: "A humanoid fantasy species with dwarven presentation: short and broad of frame.",
  lore: "",
  attributeRules: [
    {
      attributeId: "build.height",
      applicability: "required",
      defaultValue: "short",
      allowedValues: ["very_short", "short", "below_average"],
      notes: "Dwarves are a short people.",
    },
    {
      attributeId: "build.frame",
      applicability: "required",
      defaultValue: "stocky",
      allowedValues: ["stocky", "broad", "heavyset", "athletic"],
    },
  ],
});
