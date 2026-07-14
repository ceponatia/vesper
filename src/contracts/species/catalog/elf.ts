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
  intimacy:
    "Long-lived and unhurried, an elf treats intimacy as an art to be savoured rather than rushed — attentive, graceful, and quietly exacting about a partner's pleasure.",
  attributeRules: [
    {
      attributeId: "ears.shape",
      applicability: "required",
      defaultValue: "pointed",
      allowedValues: ["slightly_pointed", "pointed", "long_pointed"],
      notes: "Always pointed — only how sharply pointed varies.",
    },
  ],
  heritages: [
    {
      id: "dark_elf",
      label: "Dark Elf",
      aliases: ["dark elf", "dark elves", "drow"],
      appearance:
        "Ashen grey to deep charcoal skin, most often paired with stark white or silver hair and pale, luminous eyes; their ears sweep long and sharp.",
      lore: "The Dark Elves — Drow in the old tongue — split from the High Elves generations ago and made their home in the deep places beneath the world. They are insular, sharp-tongued, and quietly matriarchal, and the surface races still regard them with wary suspicion. They excel in necromancy and dark magic.",
      intimacy:
        "Insular and quietly matriarchal, a dark elf takes the lead by second nature — composed, commanding, and slow to bare real vulnerability, so that yielding it means something.",
      attributeRules: [
        // Overrides the species ears rule: Dark Elf points are longer and sharper.
        {
          attributeId: "ears.shape",
          applicability: "required",
          defaultValue: "long_pointed",
          allowedValues: ["pointed", "long_pointed"],
          notes: "Longer and sharper than other elves' points.",
        },
        // Heritage-only rule: the signature grey/violet skin the base elf never constrains.
        // Note: defaultValue must be included in allowedValues!
        {
          attributeId: "skin.tone",
          applicability: "optional",
          defaultValue: "ashen",
          allowedValues: [
            "ashen",
            "light_grey",
            "slate_grey",
            "blue_grey",
            "dusky_violet",
          ],
          notes: "Subterranean tones — ashen through to dusky violet.",
        },
      ],
    },
  ],
});
