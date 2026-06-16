import { defineSpecies } from "../types";
import { DEFAULT_BODY_PLAN_ID } from "../../body/plans";

export const elf = defineSpecies({
  id: "elf",
  label: "Elf",
  aliases: ["elves", "elven", "elfin", "elf-like", "half-elf", "half elf"],
  bodyPlanId: DEFAULT_BODY_PLAN_ID,
  description:
    "A humanoid fantasy species with elven presentation, defined by pointed ears.",
  appearance:
    "Slender and lithe with smooth, fine-boned features that read as ageless, and the unmistakable pointed ears that mark them at a glance.",
  lore: "Elf is an umbrella term for many types of elven races, who refer to themselves as Mer. True elves are referred to in Common tongue as High Elves due in part to the fact they see themselves as 'better' than the other elfin races (and humanity). They are adept at magic by nature but are physically less resiliant than most of the other humanoid races.",
  attributeRules: [
    {
      attributeId: "ears.shape",
      applicability: "required",
      defaultValue: "pointed",
      allowedValues: ["slightly_pointed", "pointed", "long_pointed"],
      notes:
        "Elves read by their points; the degree varies, the points do not.",
    },
  ],
});
