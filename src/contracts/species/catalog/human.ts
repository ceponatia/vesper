import { defineSpecies } from "../types";
import { DEFAULT_BODY_PLAN_ID } from "../../body/plans";

export const human = defineSpecies({
  id: "human",
  label: "Human",
  aliases: ["humans", "humanlike", "human-like"],
  bodyPlanId: DEFAULT_BODY_PLAN_ID,
  description:
    "A natural humanoid species with ordinary human anatomy and broad individual variation. Which intimate anatomy a given character has is the per-character body-config, not the species.",
  lore: "",
  attributeRules: [],
});
