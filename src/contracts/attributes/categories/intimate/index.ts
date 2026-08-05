import type { AttributeGroup } from "../../types";
import { breastsGroup } from "./breasts";
import { vulvaGroup } from "./vulva";
import { penisGroup } from "./penis";
import { testiclesGroup } from "./testicles";

/**
 * Intimate anatomy attribute groups — explicit/sexual anatomy, fenced into this
 * one subfolder (Decision 11) so the whole set is easy to find and to withhold
 * from moderation-prone routes (the scene composer runs on a moderation-prone
 * tool model, so its appearance summaries keep `allowIntimate: false`; image
 * generation is now uncensored end-to-end). Gated per character by
 * the body-config; see species/realize.ts.
 */
export const intimateGroups: readonly AttributeGroup[] = [breastsGroup, vulvaGroup, penisGroup, testiclesGroup];
