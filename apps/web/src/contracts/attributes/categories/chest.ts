import { defineAttributeGroup } from "../types";

export const chestGroup = defineAttributeGroup("chest", [
  {
    // Chest BUILD: the visible upper-torso / ribcage / pectoral silhouette of a
    // body WITHOUT the breasts region. When the body-config switches `breasts`
    // on, `breasts.size` owns the silhouette and this attribute is inapplicable
    // (`supersededByIntimateRegions`) — a prompt never carries both size facts.
    // Not owned here: shoulder width (`shoulders.width`), whole-body frame
    // (`build.frame`), or muscular definition (`build.musculature`).
    id: "chest.size",
    label: "Chest build",
    kind: "physical",
    category: "chest",
    valueType: "enum",
    description: "Upper-torso and ribcage structure as it visibly reads on a body without breasts.",
    mutability: "inherent",
    renderVisual: true,
    allowedValues: ["flat", "narrow", "slight", "average", "broad", "barrel"],
    bodyLocationId: "chest",
    supersededByIntimateRegions: ["breasts"],
    aliases: ["chest", "chest build", "ribcage"],
    imageAppearance: { class: "reinforcement", minimumFraming: "portrait" },
    promptHints: ["Describe the chest only as far as wardrobe exposure and the exposure mask allow."],
  },
  {
    // Follows the breasts region exactly like `chest.size`: a body WITH the
    // region carries the `breasts.*` fields alone, so by default the control
    // appears on a male seed and not on a female one — the body-config, never
    // the gender label, decides.
    id: "chest.hair",
    label: "Chest hair",
    kind: "physical",
    category: "chest",
    valueType: "enum",
    description: "Chest hair density; grooming can change it.",
    mutability: "mutable",
    allowedValues: ["none", "sparse", "light", "moderate", "thick"],
    bodyLocationId: "chest",
    supersededByIntimateRegions: ["breasts"],
    aliases: ["chest hair"],
    imageAppearance: { class: "fine", minimumFraming: "portrait", maximumFraming: "waist_up" },
    imageReveal: "skin",
  },
]);

/**
 * `chest.size` bust-scale values → their `breasts.size` successor, for a body
 * WITH the breasts region. The one translation across the anatomy split: a
 * chest-build word that reads as a bust size (a stored row from before the
 * split, or a forge answer that put the bust under chest build) becomes the
 * size the realized body applies instead of being discarded. `broad` and
 * `barrel` describe ribcage structure and have no breast-size reading, so they
 * are absent. Shared by the stored-value sweep (`scripts/sweep-chest-size-anatomy.ts`)
 * and the forge's body conform step; the sweep test proves every target parses.
 */
export const BUST_SCALE_TO_BREAST_SIZE: Readonly<Record<string, string>> = {
  flat: "flat",
  slight: "nearly_flat",
  modest: "modest",
  average: "medium",
  full: "full",
  very_full: "very_large",
};
