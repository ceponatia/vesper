import { defineAttributeGroup } from "../types";

export const feetGroup = defineAttributeGroup("feet", [
  {
    id: "feet.size",
    label: "Foot size",
    kind: "physical",
    category: "feet",
    valueType: "enum",
    description: "Foot size and proportion.",
    mutability: "inherent",
    allowedValues: [
      "petite",
      "small",
      "narrow",
      "average",
      "long",
      "broad",
      "large",
    ],
    bodyLocationId: "feet",
    aliases: ["feet", "foot size"],
    imageReveal: "shape",
    // Persisted-baseline (pre-slice-3 foot facts): every stored body carries
    // these four structural facts, so the foot domain's reads never hinge on an
    // author having thought about feet. NOT coreVisual — they are contact
    // structure, not a look. `feet.smell` is deliberately unflagged: a default
    // must never manufacture scent, moisture, products, residue, or contact.
    defaultValue: "average",
    materializeDefault: true,
  },
  {
    id: "feet.arch",
    label: "Foot arch",
    kind: "physical",
    category: "feet",
    valueType: "enum",
    description: "Arch profile of the foot.",
    mutability: "inherent",
    allowedValues: ["flat", "low", "average", "high"],
    bodyLocationId: "feet",
    aliases: ["arches", "foot arch"],
    // Skin-level — only visible with bare feet (no footwear).
    imageReveal: "skin",
    // Structural axis of the foot affordance domain (arch subtree calibration).
    defaultValue: "average",
    materializeDefault: true,
  },
  {
    id: "feet.nails",
    label: "Toenails",
    kind: "presentation",
    category: "feet",
    valueType: "enum",
    description: "Toenail upkeep.",
    mutability: "mutable",
    allowedValues: [
      "neglected",
      "trimmed",
      "neat",
      "pedicured",
      "painted",
      "chipped",
    ],
    bodyLocationId: "toes",
    aliases: ["toenails", "pedicure"],
    imageReveal: "skin",
    promptHints: [
      "Toenails are only worth a mention when the feet are bare and in view.",
    ],
    // Structural axis of the foot affordance domain (the toenail surface).
    // "trimmed" is the neutral baseline: ordinary nail length without assuming
    // any additional grooming (owner correction, 2026-07-30).
    defaultValue: "trimmed",
    materializeDefault: true,
  },
  {
    // This is placeholder for testing.
    // Eventually need an evolving scent schema which is based on
    // current hygiene.
    id: "feet.smell",
    label: "Foot scent",
    kind: "presentation",
    category: "feet",
    valueType: "enum",
    description: "Starting foot scent.",
    mutability: "mutable",
    allowedValues: [
      "clean",
      "lightly_sweaty",
      "warm_skin",
      "faint_sock",
      "musky",
      "earthy",
      "ripe",
      "leathery",
      "vinegary",
      "cheesy",
      "sour_sweat",
      "musty",
      "worn_leather",
      "heavy_sweat",
      "pungent",
      "thick_musk",
      "feral",
      "intense_sweat",
      "stale_sock",
      "sharp_vinegar",
      "rank",
      "overpowering",
    ],
    bodyLocationId: "feet",
    aliases: ["feet", "foot", "sole", "heel"],
    promptHints: [
      "Foot scent is only worth a mention when the feet are bare and near the player's face.",
    ],
    // The palette runs clean → overpowering; glosses anchor each member's register so the
    // narrator elaborates within it (a "cheesy" foot never reads clean or merely salty).
    narratorGuidance: {
      lightly_sweaty: "fresh faint sweat — honest and mild, gone in a breath",
      warm_skin: "just warmed skin — soft, human, barely a scent at all",
      faint_sock: "a mild trace of cotton worn a few hours",
      musky: "warm animal depth — low, personal, unmistakably body",
      earthy: "damp-soil depth, grounded rather than sour",
      ripe: "a full day's depth — strong, human, just past earthy",
      leathery: "shoe leather steeped into warm skin",
      vinegary: "a sour acetic bite at the top of the nose",
      cheesy: "dense fermented funk, like aged cheese — thick and unmistakable up close",
      sour_sweat: "sweat gone acidic and stale",
      musty: "stale closed-shoe air, like a damp closet",
      worn_leather: "old leather gone deep and dry into the skin",
      heavy_sweat: "thick, humid, soaked-sock sweat",
      pungent: "forceful — it fills every breath taken near it",
      thick_musk: "musk so dense it almost has texture",
      feral: "raw animal reek — wild, heady, unignorable",
      intense_sweat: "fresh sweat at full, prickling strength",
      stale_sock: "flat, days-worn sock funk",
      sharp_vinegar: "acrid vinegar sting that pricks the eyes",
      rank: "aggressively foul — a wall of it",
      overpowering: "saturates every breath; the strongest thing in the room",
    },
  },
  {
    id: "feet.toes",
    label: "Toe length",
    kind: "physical",
    category: "feet",
    valueType: "enum",
    description: "Overall length of toes.",
    mutability: "inherent",
    allowedValues: ["tiny", "short", "average", "long"],
    bodyLocationId: "feet",
    aliases: ["feet", "foot", "sole", "heel"],
    // Skin-level — only visible with bare feet (no footwear).
    imageReveal: "skin",
    promptHints: [
      "Toe length is only worth a mention when the feet are bare and in view.",
    ],
    // Structural axis of the foot affordance domain (interdigital depth).
    defaultValue: "average",
    materializeDefault: true,
  },
]);
