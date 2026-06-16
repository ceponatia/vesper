import type { SpeciesDefinition } from "../types";
import { human } from "./human";
import { elf } from "./elf";
import { dwarf } from "./dwarf";
import { gnome } from "./gnome";
import { faerie } from "./faerie";
import { orc } from "./orc";
import { goblin } from "./goblin";
import { succubus } from "./succubus";

/**
 * Central species list — the single registration point for species vocabulary.
 * Add a species file in this folder and list it here; the registry derives
 * everything else (docs/contracts.md §Body model). Mirrors the attribute
 * categories pattern (`attributes/categories/index.ts`).
 */
export const speciesCatalog: readonly SpeciesDefinition[] = [
  human,
  elf,
  dwarf,
  gnome,
  faerie,
  orc,
  goblin,
  succubus,
];
