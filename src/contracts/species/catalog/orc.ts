import { defineSpecies } from "../types";
import { DEFAULT_BODY_PLAN_ID } from "../../body/plans";

export const orc = defineSpecies({
  id: "orc",
  label: "Orc",
  aliases: ["orcs", "orcish", "ork", "orks", "orkish", "orc-like"],
  bodyPlanId: DEFAULT_BODY_PLAN_ID,
  description: "A humanoid fantasy species with orcish presentation: broad, tall, and powerfully built.",
  lore: "",
  attributeRules: [
    {
      attributeId: "build.frame",
      applicability: "required",
      defaultValue: "broad",
      allowedValues: ["athletic", "stocky", "broad", "heavyset"],
      notes: "Orcs are broad and powerfully built.",
    },
    {
      attributeId: "build.height",
      applicability: "optional",
      defaultValue: "tall",
      allowedValues: ["above_average", "tall", "very_tall", "towering"],
    },
    {
      attributeId: "build.musculature",
      applicability: "optional",
      defaultValue: "muscular",
      allowedValues: ["toned", "defined", "muscular", "powerfully_built"],
    },
  ],
});
