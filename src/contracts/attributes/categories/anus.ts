import { defineAttributeGroup } from "../types";
import {
  INTIMATE_SCENT_BASE,
  INTIMATE_SCENT_GUIDANCE,
  INTIMATE_SCENT_SWEAT,
  INTIMATE_SCENT_SWEAT_GUIDANCE,
} from "../shared-values";

/**
 * Anus — UNIVERSAL anatomy (present on every realized body, like `buttocks` /
 * `hips`), NOT a per-character body-config toggle, so it is a top-level category
 * here rather than a fenced `intimate/` group. It is still moderation-sensitive:
 * its category is listed in INTIMATE_ATTRIBUTE_CATEGORIES, so chat withholds it
 * unless the turn's focus targets the region and images withhold it unless the
 * caller opts in. Bound to the universal `anus` body location (locations/intimate.ts).
 *
 * NB — image reveal is intentionally UNSET on every field (placeholder pending
 * image-prompt re-evaluation, owner ruling 2026-07-23): today all renders view
 * the character from the front, where anal detail never shows and would only
 * confuse the model, so the anus category is deliberately absent from the image
 * exposure maps (server/images/prompts.ts). Revisit when rear/exposure framing
 * lands.
 */
export const anusGroup = defineAttributeGroup("anus", [
  {
    id: "anus.appearance",
    label: "Anus appearance",
    kind: "physical",
    category: "anus",
    valueType: "enum",
    description: "External presentation of the anus when the area is bare.",
    mutability: "inherent",
    allowedValues: [
      "tight_pucker",
      "small",
      "wrinkled",
      "star_shaped",
      "average",
      "puffy",
      "prominent",
      "inverted",
      "relaxed",
    ],
    bodyLocationId: "anus",
    aliases: ["anus", "asshole", "butthole"],
    promptHints: ["Surfaces only at the intimate exposure/touch tier; one grounded impression, not a checklist."],
  },
  {
    id: "anus.color",
    label: "Anus color",
    kind: "physical",
    category: "anus",
    valueType: "enum",
    description: "Natural pigmentation of the anus and the skin immediately around it.",
    mutability: "inherent",
    allowedValues: [
      "pale_pink",
      "soft_pink",
      "rose",
      "deep_pink",
      "reddish",
      "tan",
      "brown",
      "dark_brown",
      "dusky",
      "purplish",
    ],
    bodyLocationId: "anus",
  },
  {
    id: "anus.tightness",
    label: "Anus tightness",
    kind: "physical",
    category: "anus",
    valueType: "enum",
    description:
      "Baseline tightness — a response tendency that shifts with arousal and use (live state rides the arousal meter).",
    mutability: "mutable",
    allowedValues: ["loose", "trained", "relaxed", "average", "snug", "tight", "very_tight"],
    bodyLocationId: "anus",
    promptHints: ["Only surfaces during intimate contact."],
  },
  {
    id: "anus.texture",
    label: "Anus texture",
    kind: "physical",
    category: "anus",
    valueType: "enum",
    description: "Surface feel of the anus and the ring of skin around it.",
    mutability: "inherent",
    allowedValues: ["smooth", "soft", "delicate", "wrinkled", "puckered", "ridged"],
    bodyLocationId: "anus",
  },
  {
    id: "anus.hair",
    label: "Anal hair",
    kind: "physical",
    category: "anus",
    valueType: "enum",
    description: "Hair around the anus and up the cleft — natural growth or grooming.",
    mutability: "mutable",
    allowedValues: ["none", "smooth", "trimmed", "sparse", "light", "moderate", "thick", "dense"],
    bodyLocationId: "anus",
  },
  {
    id: "anus.sensitivity",
    label: "Anus sensitivity",
    kind: "physical",
    category: "anus",
    valueType: "enum",
    description: "Baseline responsiveness to touch — a tendency, not live arousal.",
    mutability: "mutable",
    allowedValues: ["numb", "low", "average", "high", "responsive", "extremely_sensitive"],
    bodyLocationId: "anus",
  },
  {
    id: "anus.lubrication",
    label: "Anus lubrication",
    kind: "physical",
    category: "anus",
    valueType: "enum",
    description: "Natural moisture state — mutable with arousal, hygiene, and preparation.",
    mutability: "mutable",
    allowedValues: ["dry", "slightly_moist", "slick", "ready"],
    bodyLocationId: "anus",
    promptHints: ["Rendered only at the intimate touch tier."],
  },
  {
    id: "anus.scent",
    label: "Anal scent",
    kind: "sensory",
    category: "anus",
    valueType: "enum",
    description: "Intimate scent; shifts with hygiene and arousal. Surfaces only when scent is earned at intimate range.",
    mutability: "mutable",
    allowedValues: [...INTIMATE_SCENT_BASE, ...INTIMATE_SCENT_SWEAT],
    bodyLocationId: "anus",
    narratorGuidance: { ...INTIMATE_SCENT_GUIDANCE, ...INTIMATE_SCENT_SWEAT_GUIDANCE },
  },
]);
