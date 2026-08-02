import { defineSpecies } from "../types";
import { DEFAULT_BODY_PLAN_ID } from "../../body/plans";
import { organicHumanoidSensoryRules } from "./humanoid-sensory";

export const orc = defineSpecies({
  id: "orc",
  label: "Orc",
  aliases: ["orcs", "orcish", "ork", "orks", "orkish", "orc-like"],
  bodyPlanId: DEFAULT_BODY_PLAN_ID,
  description:
    "A humanoid fantasy species with orcish presentation: broad, tall, and powerfully built.",
  appearance:
    "Tall, broad, and heavily muscled, with a strong jaw set with prominent lower tusks, a heavy brow, and skin in earthy green or grey tones.",
  lore: "Orcs of old were nomadic warriors from the steppes of Mongolia. In modern society, they make up the bulk of nations' security services and hard manual labor jobs. Contrary to racist stereotypes, they aren't *stupid*... most Orcs possess the same intellect as the average human. They are, however, hot tempered and capable of far greater strength and resilience than the other humanoid races.",
  intimacy:
    "Runs hot — an orc brings frank appetite and real stamina to intimacy, ardent and physical, though far gentler and more attentive with a chosen partner than the stereotype allows.",
  attributeRules: [
    ...organicHumanoidSensoryRules,
    {
      attributeId: "build.frame",
      applicability: "required",
      defaultValue: "heavy_boned",
      allowedValues: ["sturdy", "heavy_boned"],
      notes: "Orcs are heavy-boned and powerfully built.",
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
