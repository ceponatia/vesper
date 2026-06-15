import { defineAttributeGroup } from "../../types";

/**
 * Breasts — intimate region, gated by the body-config group "breasts" (distinct
 * from the always-present `chest` silhouette). Clinical values; prose promptHints.
 * Surfaces only as far as wardrobe exposure + the exposure mask allow.
 */
export const breastsGroup = defineAttributeGroup("breasts", [
  {
    id: "breasts.size",
    label: "Breast size",
    kind: "physical",
    category: "breasts",
    valueType: "enum",
    description: "Breast size as it reads unclothed.",
    mutability: "mutable",
    allowedValues: ["flat", "small", "average", "full", "large", "very_large"],
    bodyLocationId: "breasts",
    aliases: ["breast size", "cup size"],
    promptHints: ["Describe breasts only as far as wardrobe exposure and the exposure mask allow; one impression, not a checklist."],
  },
  {
    id: "breasts.shape",
    label: "Breast shape",
    kind: "physical",
    category: "breasts",
    valueType: "enum",
    description: "The overall shape the breasts present.",
    mutability: "mutable",
    allowedValues: ["round", "teardrop", "soft", "pert", "wide_set"],
    bodyLocationId: "breasts",
    aliases: ["breast shape"],
  },
  {
    id: "breasts.nipples",
    label: "Nipples",
    kind: "physical",
    category: "breasts",
    valueType: "enum",
    description: "Nipple character, surfaced only when the chest is bare to the scene.",
    mutability: "inherent",
    allowedValues: ["small", "average", "large", "puffy", "inverted"],
    bodyLocationId: "nipples",
    aliases: ["nipples"],
  },
]);
