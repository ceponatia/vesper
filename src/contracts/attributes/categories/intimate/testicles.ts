import { defineAttributeGroup } from "../../types";
import {
  INTIMATE_SCENT_BASE,
  INTIMATE_SCENT_GUIDANCE,
  INTIMATE_SCENT_SWEAT,
  INTIMATE_SCENT_SWEAT_GUIDANCE,
} from "../../shared-values";

/**
 * Testicles — intimate region, gated by the body-config group "testicles".
 * Clinical values; prose promptHints. Surfaces only at the intimate exposure tier.
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
    allowedValues: ["small", "average", "large", "full", "heavy", "swollen"],
    bodyLocationId: "testicles",
    aliases: ["testicle size", "balls"],
    promptHints: ["Surfaces only at the intimate exposure tier; a single grounded impression."],
  },
  {
    id: "testicles.hang",
    label: "Testicle hang",
    kind: "physical",
    category: "testicles",
    valueType: "enum",
    description: "How high or low the testicles sit — shifts with warmth and arousal.",
    mutability: "mutable",
    allowedValues: ["tight_to_body", "high", "average", "low", "very_low"],
    bodyLocationId: "testicles",
  },
  {
    id: "testicles.texture",
    label: "Testicle texture",
    kind: "physical",
    category: "testicles",
    valueType: "enum",
    description: "Surface feel of the scrotum.",
    mutability: "inherent",
    allowedValues: ["smooth", "soft", "firm", "wrinkled", "heavy"],
    bodyLocationId: "testicles",
  },
  {
    id: "testicles.scent",
    label: "Testicle scent",
    kind: "sensory",
    category: "testicles",
    valueType: "enum",
    description: "Intimate scent; shifts with hygiene and arousal. Surfaces only when scent is earned at close/intimate range.",
    mutability: "mutable",
    allowedValues: [...INTIMATE_SCENT_BASE, ...INTIMATE_SCENT_SWEAT],
    bodyLocationId: "testicles",
    narratorGuidance: { ...INTIMATE_SCENT_GUIDANCE, ...INTIMATE_SCENT_SWEAT_GUIDANCE },
  },
]);
