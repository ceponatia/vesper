import { defineAttributeGroup } from "../../types";

/** Horns — visible fantasy morphology, gated by bodyFeatures group "horns". */
export const hornsGroup = defineAttributeGroup("horns", [
  {
    id: "horns.shape",
    label: "Horn shape",
    kind: "physical",
    category: "horns",
    valueType: "enum",
    description: "Overall horn silhouette.",
    mutability: "inherent",
    allowedValues: ["short_curved", "swept_back", "straight", "spiraled", "branching"],
    bodyLocationId: "horns",
    aliases: ["horn shape", "curved horns", "spiral horns"],
    promptHints: ["Visible fantasy morphology; describe as part of the always-visible appearance."],
  },
  {
    id: "horns.length",
    label: "Horn length",
    kind: "physical",
    category: "horns",
    valueType: "enum",
    description: "How prominent the horns are.",
    mutability: "inherent",
    allowedValues: ["nubs", "short", "medium", "long"],
    bodyLocationId: "horns",
    aliases: ["horn length"],
  },
  {
    id: "horns.color",
    label: "Horn color",
    kind: "physical",
    category: "horns",
    valueType: "text",
    description: "Horn color or material impression.",
    mutability: "inherent",
    bodyLocationId: "horns",
    aliases: ["horn color"],
  },
]);
