import { defineSpecies } from "../types";
import { DEFAULT_BODY_PLAN_ID } from "../../body/plans";
import { organicHumanoidSensoryRules } from "./humanoid-sensory";

/**
 * Humanoid artificial persons. Both subtypes use the complete humanoid body plan:
 * Synthetic expands the shared sensory vocabularies with constructed-body values;
 * Organic overlays the same biological sensory envelope as Human.
 */
export const android = defineSpecies({
  id: "android",
  label: "Android",
  aliases: [
    "androids",
    "humanoid synthetic",
    "humanoid synthetics",
    "artificial human",
    "artificial humans",
  ],
  bodyPlanId: DEFAULT_BODY_PLAN_ID,
  subtypeLabel: "Subtype",
  defaultHeritageId: "synthetic_android",
  description:
    "A humanoid artificial person whose AI mind inhabits either a fully synthetic body or a cloned organic human body integrated with cybernetics.",
  appearance:
    "Human-shaped and intentionally personlike; the chosen subtype determines whether the body is constructed or biologically human.",
  lore:
    "Androids are artificial intelligences embodied as humanoid people. Their personhood is continuous across synthetic and clone-derived bodies even though the bodies' sensory and maintenance needs differ.",
  attributeRules: [],
  heritages: [
    {
      id: "synthetic_android",
      label: "Synthetic Android",
      aliases: ["synth android", "synthetic humanoid", "mechanical android"],
      appearance:
        "A fully constructed humanoid body with convincingly human proportions and features; close contact may reveal engineered skin, precision movement, or subtle machine cues.",
      lore:
        "Synthetic androids inhabit purpose-built humanoid chassis. Their bodies reproduce human appearance and touch while allowing deliberately engineered voices, tactile feedback, scents, tastes, and surface materials.",
      attributeRules: [],
    },
    {
      id: "organic_android",
      label: "Organic Android",
      aliases: ["bio-android", "biological android", "clone-body android", "cloned-body android"],
      appearance:
        "A biologically human clone body whose AI-support cybernetics are integrated beneath ordinary living tissue, leaving human warmth, scent, texture, and movement intact.",
      lore:
        "Organic androids inhabit cloned human bodies with built-in cybernetics that sustain and connect the AI mind. Their bodies are biologically human in ordinary sensory detail even though the mind and neural interface are artificial.",
      attributeRules: organicHumanoidSensoryRules,
    },
  ],
});
