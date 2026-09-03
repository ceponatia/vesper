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
    promptHints: ["Describe the chest only as far as wardrobe exposure and the exposure mask allow."],
  },
  {
    id: "chest.hair",
    label: "Chest hair",
    kind: "physical",
    category: "chest",
    valueType: "enum",
    description: "Chest hair density; grooming can change it.",
    mutability: "mutable",
    allowedValues: ["none", "sparse", "light", "moderate", "thick"],
    bodyLocationId: "chest",
    aliases: ["chest hair"],
  },
]);
