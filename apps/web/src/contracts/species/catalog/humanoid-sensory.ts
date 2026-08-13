import type { AttributeRule } from "../../rules/attribute-rule";
import {
  SYNTHETIC_INTIMATE_TEXTURES,
  SYNTHETIC_SCENT_VALUES,
  SYNTHETIC_SENSITIVITY_VALUES,
  SYNTHETIC_SKIN_TEXTURES,
  SYNTHETIC_TASTE_VALUES,
  SYNTHETIC_VOICE_TIMBRES,
} from "../../attributes/shared-values";

/**
 * The ordinary biological-humanoid sensory envelope. Synthetic enum members live
 * in the shared attribute registry so stored values remain globally parseable, then
 * this reusable species rule set removes them from every organic humanoid's realized
 * editor/forge vocabulary. Android's Organic subtype uses the same set.
 */
const organicHumanoidSensoryExclusions = [
  ["skin.texture", SYNTHETIC_SKIN_TEXTURES],
  ["voice.timbre", SYNTHETIC_VOICE_TIMBRES],
  ["feet.smell", SYNTHETIC_SCENT_VALUES],
  ["anus.texture", SYNTHETIC_INTIMATE_TEXTURES],
  ["anus.sensitivity", SYNTHETIC_SENSITIVITY_VALUES],
  ["anus.scent", SYNTHETIC_SCENT_VALUES],
  ["perineum.texture", SYNTHETIC_INTIMATE_TEXTURES],
  ["perineum.sensitivity", SYNTHETIC_SENSITIVITY_VALUES],
  ["breasts.sensitivity", SYNTHETIC_SENSITIVITY_VALUES],
  ["vulva.texture", SYNTHETIC_INTIMATE_TEXTURES],
  ["vulva.scent", SYNTHETIC_SCENT_VALUES],
  ["vulva.taste", SYNTHETIC_TASTE_VALUES],
  ["penis.sensitivity", SYNTHETIC_SENSITIVITY_VALUES],
  ["penis.scent", SYNTHETIC_SCENT_VALUES],
  ["testicles.texture", SYNTHETIC_INTIMATE_TEXTURES],
  ["testicles.scent", SYNTHETIC_SCENT_VALUES],
] as const;

export const organicHumanoidSensoryRules = organicHumanoidSensoryExclusions.map(
  ([attributeId, disallowedValues]) => ({
    attributeId,
    applicability: "optional" as const,
    disallowedValues: [...disallowedValues],
  }),
) satisfies AttributeRule[];
