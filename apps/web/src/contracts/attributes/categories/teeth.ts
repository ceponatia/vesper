import { defineAttributeGroup } from "../types";

/**
 * Teeth — mouth-area detail anchored at the face (like lips), so "look at her
 * face / mouth" surfaces it. Sharp/fanged shapes support vampiric, demonic, and
 * bestial casts; they are flagged `autoDefaultExcludes` so a human is never
 * auto-assigned fangs (the forge/editor may still pick them, or a species rule
 * can require them).
 */
export const teethGroup = defineAttributeGroup("teeth", [
  {
    id: "teeth.shape",
    label: "Teeth",
    kind: "physical",
    category: "teeth",
    valueType: "enum",
    description: "Overall character of the teeth, including non-human points and fangs.",
    mutability: "inherent",
    allowedValues: [
      "even", "slightly_crooked", "gapped", "prominent_canines",
      "sharp_canines", "sharp_incisors", "fanged", "all_pointed", "serrated",
    ],
    autoDefaultExcludes: ["sharp_canines", "sharp_incisors", "fanged", "all_pointed", "serrated"],
    bodyLocationId: "face",
    aliases: ["teeth", "fangs", "canines"],
    imageAppearance: {
      class: "fine",
      maximumFraming: "close_up",
      phrase: {
        group: "face",
        role: "with",
        fragmentByValue: {
          even: "even teeth",
          slightly_crooked: "slightly crooked teeth",
          gapped: "gapped teeth",
          prominent_canines: "prominent canines",
          sharp_canines: "sharp canines",
          sharp_incisors: "sharp incisors",
          fanged: "fangs",
          all_pointed: "pointed teeth throughout",
          serrated: "serrated teeth",
        },
      },
    },
    promptHints: ["Sharp canines / fangs read vampiric, demonic, or predatory — surface them on a smile, a hiss, or up close."],
  },
  {
    id: "teeth.condition",
    label: "Teeth condition",
    kind: "physical",
    category: "teeth",
    valueType: "enum",
    description: "Color and upkeep of the teeth.",
    mutability: "mutable",
    allowedValues: ["pristine", "white", "neat", "yellowed", "stained", "chipped", "gold_capped"],
    bodyLocationId: "face",
    aliases: ["teeth condition"],
    imageAppearance: {
      class: "fine",
      maximumFraming: "close_up",
      phrase: {
        group: "face",
        role: "with",
        fragment: "{value} teeth",
        fragmentByValue: { gold_capped: "gold-capped teeth" },
      },
    },
  },
]);
