import { defineSpecies } from "../types";
import { DEFAULT_BODY_PLAN_ID } from "../../body/plans";

export const faerie = defineSpecies({
  id: "faerie",
  label: "Faerie",
  aliases: ["faeries", "faery", "fae", "fairy", "fairies", "fair folk"],
  bodyPlanId: DEFAULT_BODY_PLAN_ID,
  description:
    "A humanoid fantasy species whose default morphology includes wings. These are defaults, not hard requirements; bodyFeatures may override them per character.",
  lore: "",
  defaultFeatureGroups: ["wings"],
  attributeRules: [],
});
