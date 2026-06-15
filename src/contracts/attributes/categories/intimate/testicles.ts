import { defineAttributeGroup } from "../../types";

/**
 * Testicles — intimate region, gated by the body-config group "testicles".
 * Clinical value; prose promptHint. Surfaces only at the intimate exposure tier.
 */
export const testiclesGroup = defineAttributeGroup("testicles", [
  {
    id: "testicles.size",
    label: "Testicle size",
    kind: "physical",
    category: "testicles",
    valueType: "enum",
    description: "How the testicles read unclothed.",
    mutability: "mutable",
    allowedValues: ["small", "average", "large"],
    bodyLocationId: "testicles",
    aliases: ["testicle size"],
    promptHints: ["Surfaces only at the intimate exposure tier; a single grounded impression."],
  },
]);
