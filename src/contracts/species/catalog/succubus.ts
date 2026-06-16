import { defineSpecies } from "../types";
import { DEFAULT_BODY_PLAN_ID } from "../../body/plans";

export const succubus = defineSpecies({
  id: "succubus",
  label: "Succubus",
  aliases: ["succubi", "succuba", "succubae", "succubus-like"],
  bodyPlanId: DEFAULT_BODY_PLAN_ID,
  description:
    "A humanoid fantasy species whose default morphology includes wings, horns, and a tail. These are defaults, not hard requirements; bodyFeatures may override them per character.",
  lore: "",
  defaultFeatureGroups: ["wings", "horns", "tail"],
  attributeRules: [],
});
