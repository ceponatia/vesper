import { defineSpecies } from "../types";
import { DEFAULT_BODY_PLAN_ID } from "../../body/plans";

export const elf = defineSpecies({
  id: "elf",
  label: "Elf",
  aliases: ["elves", "elven", "elfin", "elf-like", "half-elf", "half elf"],
  bodyPlanId: DEFAULT_BODY_PLAN_ID,
  description: "A humanoid fantasy species with elven presentation, defined by pointed ears.",
  lore: "",
  attributeRules: [
    {
      attributeId: "ears.shape",
      applicability: "required",
      defaultValue: "pointed",
      allowedValues: ["slightly_pointed", "pointed", "long_pointed"],
      notes: "Elves read by their points; the degree varies, the points do not.",
    },
  ],
});
