import { defineSpecies } from "../types";
import { DEFAULT_BODY_PLAN_ID } from "../../body/plans";

export const dwarf = defineSpecies({
  id: "dwarf",
  label: "Dwarf",
  aliases: ["dwarves", "dwarven", "dwarf-like"],
  bodyPlanId: DEFAULT_BODY_PLAN_ID,
  description:
    "A humanoid fantasy species with dwarven presentation: short and broad of frame.",
  appearance:
    "Short and powerfully sturdy, broad through the chest and shoulders, with thick, weathered features and very often a heavy beard.",
  lore: "Dwarves are one of the most ancient races in the world. From their lineage came the Gnomes and Goblins. Although they have joined the other races in the cities in contemporary times, Dwarves traditionally lived underground in massive vaulted undercities. Many of these cities still exist today and serve as capitols of the Dwarven people. They are a proud, somewhat private race and adept merchants and miners. They work closely with Orcs, employing them to perform the labor duties that Dwarves are not as capable of.",
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
      defaultValue: "sturdy",
      allowedValues: ["sturdy", "heavy_boned"],
    },
  ],
});
