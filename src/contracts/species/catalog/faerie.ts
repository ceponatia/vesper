import { defineSpecies } from "../types";
import { DEFAULT_BODY_PLAN_ID } from "../../body/plans";

export const faerie = defineSpecies({
  id: "faerie",
  label: "Faerie",
  aliases: ["faeries", "faery", "fae", "fairy", "fairies", "fair folk"],
  bodyPlanId: DEFAULT_BODY_PLAN_ID,
  description:
    "A humanoid fantasy species whose default morphology includes wings. These are defaults, not hard requirements; bodyFeatures may override them per character.",
  appearance:
    "Small and delicate, roughly the height of an adolescent human, with brightly colored butterfly-like wings and a nimble, weightless grace.",
  lore: "Faerie is the root species designation for a variety of winged humanoids. Pixies, Sprites, and True Faeries differ wildly in appearance and personality. Faeries themselves have brightly colored butterfly-like wings and are roughly the height of an adolescent human. They are nimble and lithe, with hollow bones that make them light as a feather. Even with their light weight, flight would ordinarily be impossible, but this is augmented by an inborn magical aura that allows them to be light as air when in flight.",
  defaultFeatureGroups: ["wings"],
  attributeRules: [],
});
