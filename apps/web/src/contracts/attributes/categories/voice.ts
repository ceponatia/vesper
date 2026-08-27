import { defineAttributeGroup } from "../types";
import { SYNTHETIC_VOICE_TIMBRES, SYNTHETIC_VOICE_TIMBRE_GUIDANCE } from "../shared-values";

export const voiceGroup = defineAttributeGroup("voice", [
  {
    id: "voice.pitch",
    label: "Voice pitch",
    kind: "sensory",
    category: "voice",
    valueType: "enum",
    description: "Resting speaking pitch.",
    mutability: "inherent",
    allowedValues: ["very_low", "low", "medium_low", "medium", "medium_high", "high", "very_high"],
    aliases: ["voice pitch", "deep voice", "high voice"],
  },
  {
    id: "voice.timbre",
    label: "Voice timbre",
    kind: "sensory",
    category: "voice",
    valueType: "enum",
    description: "Texture and color of the voice.",
    mutability: "inherent",
    allowedValues: [
      "clear", "warm", "soft_spoken", "husky", "raspy", "smoky",
      "breathy", "nasal", "resonant", "gravelly", "silvery", "reedy",
      ...SYNTHETIC_VOICE_TIMBRES,
    ],
    autoDefaultExcludes: [...SYNTHETIC_VOICE_TIMBRES],
    aliases: ["voice timbre", "husky voice", "raspy voice"],
    // Narrator-gloss authoring batch — DRAFTS AWAITING
    // OWNER REVIEW. Timbre = the texture/color of the voice only; pitch (its own
    // attribute) is kept out — no "low"/"deep". Sparse: clear/warm stay bare.
    narratorGuidance: {
      soft_spoken: "gentle, hushed delivery — never forced",
      husky: "grainy, caught-in-the-throat warmth and roughness",
      raspy: "a dry, rough edge, like sandpaper on the words",
      smoky: "dark, hazy richness — lounge-singer warmth",
      breathy: "air threaded through the words, soft and close",
      nasal: "pinched through the nose, thin and forward",
      resonant: "full and ringing, body behind every word",
      gravelly: "coarse and rumbling, a rough gravel scrape",
      silvery: "bright, clear, bell-like — light on the ear",
      reedy: "thin and faintly buzzing, like a reed",
      ...SYNTHETIC_VOICE_TIMBRE_GUIDANCE,
    },
  },
  {
    id: "voice.accent",
    label: "Accent",
    kind: "cultural",
    category: "voice",
    valueType: "text",
    description: "Accent or dialect as it would be described in prose (\"soft coastal lilt\").",
    mutability: "mutable",
    aliases: ["accent", "dialect"],
    promptHints: ["Render the accent through word choice and rhythm, not phonetic spelling."],
  },
  {
    id: "voice.cadence",
    label: "Cadence",
    kind: "sensory",
    category: "voice",
    valueType: "enum",
    description: "Habitual speaking rhythm.",
    mutability: "mutable",
    allowedValues: [
      "clipped", "measured", "languid", "rapid", "halting",
      "melodic", "deadpan", "animated", "drawling", "precise",
    ],
    aliases: ["cadence", "speaking rhythm"],
    promptHints: ["Cadence shapes dialogue beats and sentence length; keep it consistent across turns."],
    // Narrator-gloss authoring batch — DRAFTS AWAITING
    // OWNER REVIEW. Cadence = speech rhythm/pacing only. Sparse: rapid/animated stay bare.
    narratorGuidance: {
      clipped: "curt, cut-off words — brisk and economical",
      measured: "even, unhurried pacing — each word placed",
      languid: "slow and trailing, words allowed to linger",
      halting: "starts and stops, uncertain pauses between",
      melodic: "rising and falling like a tune",
      deadpan: "flat and level — no lift, no fall",
      drawling: "stretched vowels, lazy and slow to land",
      precise: "crisp and exact, every syllable deliberate",
    },
  },
]);
