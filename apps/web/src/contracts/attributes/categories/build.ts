import { defineAttributeGroup } from "../types";

// Four independent silhouette dimensions: frame is bone, musculature is muscle,
// weight is adiposity, pregnancy is gestation. None may be encoded through another —
// a slim, firm body can be heavily pregnant.
//
// Narrator-gloss authoring batch — DRAFTS AWAITING
// OWNER REVIEW. Each gloss stays strictly in its own dimension per the orthogonality
// rule: frame speaks bone gauge (never height/weight), musculature speaks muscle only,
// weight speaks adiposity only, pregnancy speaks gestation only. Sparse — self-evident
// members (average) stay bare.

export const buildGroup = defineAttributeGroup("build", [
  {
    id: "build.height",
    label: "Height",
    kind: "physical",
    category: "build",
    valueType: "enum",
    description: "Overall height as it visibly reads.",
    mutability: "inherent",
    allowedValues: [
      "very_short",
      "short",
      "below_average",
      "average",
      "above_average",
      "tall",
      "very_tall",
      "towering",
    ],
    aliases: ["height", "tall", "short", "petite"],
    imageAppearance: {
      class: "reinforcement",
      minimumFraming: "full_figure",
      phrase: {
        // Height is nobody's build, hair or face, so it is stated on its own
        // rather than folded into another feature's clause. "Stature" is the noun
        // that carries every member: "a below-average height" is not English and
        // "a below-average build" would be a claim about mass.
        group: "other",
        role: "with",
        fragmentByValue: {
          very_short: "a very short stature",
          short: "a short stature",
          below_average: "a below-average stature",
          average: "an average stature",
          above_average: "an above-average stature",
          tall: "a tall stature",
          very_tall: "a very tall stature",
          towering: "a towering stature",
        },
      },
    },
    promptHints: [
      'Convey height through comparison and blocking ("she has to look up at him"), never as a number.',
    ],
    coreVisual: true,
    defaultValue: "average",
  },
  {
    id: "build.frame",
    label: "Frame",
    kind: "physical",
    category: "build",
    valueType: "enum",
    description:
      "Skeletal gauge — bone structure and joint heft, independent of height and weight.",
    mutability: "inherent",
    allowedValues: [
      "delicate",
      "slight",
      "average",
      "sturdy",
      "heavy_boned",
    ],
    aliases: ["frame", "build", "figure", "physique", "bone structure"],
    imageAppearance: {
      class: "core",
      referenceFreeRequired: true,
      minimumFraming: "portrait",
      phrase: { group: "build", role: "adjective", fragment: "{compound}" },
    },
    coreVisual: true,
    defaultValue: "slight",
    narratorGuidance: {
      delicate: "fine, bird-light bones — thin wrists and ankles",
      slight: "lightly built bone, a step up from delicate",
      sturdy: "dense, solid bone — thick at wrist and joint",
      heavy_boned: "big-jointed and thick-framed, heavy bone throughout",
    },
  },
  {
    id: "build.musculature",
    label: "Musculature",
    kind: "physical",
    category: "build",
    valueType: "enum",
    description: "Visible muscle development.",
    mutability: "mutable",
    renderVisual: true,
    allowedValues: [
      "untoned",
      "lightly_toned",
      "sinewy",
      "toned",
      "defined",
      "muscular",
      "powerfully_built",
    ],
    aliases: ["muscles", "muscle tone", "musculature"],
    imageAppearance: {
      class: "core",
      minimumFraming: "portrait",
      phrase: {
        group: "build",
        role: "adjective",
        fragment: "{value}",
        // Order 1, ahead of the frame's and the weight's 0: muscle is the
        // adjective nearest the noun, so the build reads "a slim, lightly toned
        // build" rather than the claim order's "a lightly toned, slim build".
        order: 1,
        // "a powerfully built build" says the noun twice; "a defined build" is the
        // one member whose bare word reads as vague rather than as muscle.
        fragmentByValue: { defined: "well-defined", powerfully_built: "powerful" },
      },
    },
    narratorGuidance: {
      untoned: "no muscle definition — soft and unworked",
      lightly_toned: "the faintest firmness, barely worked",
      sinewy: "lean, wiry cord and tendon — no bulk",
      toned: "clearly fit and firm, definition without size",
      defined: "sharp, visible separation between muscles",
      muscular: "substantial, obvious muscle mass",
      powerfully_built: "heavy, powerful muscle — built for force",
    },
  },
  {
    id: "build.weight_presentation",
    label: "Weight presentation",
    kind: "physical",
    category: "build",
    valueType: "enum",
    description: "How body weight visibly presents.",
    mutability: "mutable",
    renderVisual: true,
    allowedValues: [
      "underweight",
      "slim",
      "average",
      "soft",
      "plump",
      "heavy",
      "very_heavy",
    ],
    aliases: ["weight", "body weight"],
    imageAppearance: {
      class: "core",
      referenceFreeRequired: true,
      minimumFraming: "portrait",
      phrase: { group: "build", role: "adjective", fragment: "{value}" },
    },
    promptHints: [
      "Describe weight as silhouette and presence, never as a number or a judgement.",
    ],
    narratorGuidance: {
      underweight: "visibly thin — the edges of bone showing",
      slim: "lean and light, little softness carried",
      soft: "a gentle layer of softness over the body",
      plump: "rounded and full, softness carried everywhere",
      heavy: "carries real weight — full and substantial",
      very_heavy: "large-bodied; the weight is the first impression",
    },
  },
  {
    // Gestation, the fourth silhouette dimension — never folded into weight or
    // softness. Values are visible stages, not trimesters: an early pregnancy
    // that does not show is a story fact for the bio, not an appearance fact.
    // No coreVisual/renderVisual/defaultValue: unset means nothing is invented,
    // and "none" is elided from every prompt by the standard none rule.
    // `requiresIntimateRegions` gates the row on the vulva region, so anatomy —
    // not the gender label — decides whether the fact exists at all.
    // The image-projection opt-in follows the owner ruling that pregnancy joins
    // the Core description class and a waist-up portrait states it;
    // `referenceFreeRequired` is deliberately absent, since pregnancy is unset
    // on most characters and requiring it would leave every reference-free
    // render incomplete.
    id: "build.pregnancy",
    label: "Pregnancy",
    kind: "biological",
    category: "build",
    valueType: "enum",
    description: "Visible stage of pregnancy, independent of frame, weight, or softness.",
    mutability: "mutable",
    allowedValues: ["none", "barely_showing", "showing", "heavily_pregnant", "full_term"],
    bodyLocationId: "waist",
    requiresIntimateRegions: ["vulva"],
    aliases: ["pregnant", "pregnancy", "expecting", "with child", "baby bump"],
    imageAppearance: {
      class: "core",
      minimumFraming: "waist_up",
      phrase: {
        group: "build",
        role: "with",
        // A silhouette the build sentence carries — "a slim build with a heavily
        // pregnant belly" — never an adjective on the build itself, which would
        // fold pregnancy into weight (the promptHint above forbids exactly that).
        fragmentByValue: {
          barely_showing: "an early pregnancy bump",
          showing: "a visibly pregnant belly",
          heavily_pregnant: "a heavily pregnant belly",
          full_term: "a full-term pregnant belly",
        },
      },
    },
    imageReveal: "shape",
    promptHints: [
      "Pregnancy is its own silhouette; a slim, firm body can be heavily pregnant. Never fold it into weight or softness.",
    ],
    narratorGuidance: {
      barely_showing: "a small early bump, easy to miss under clothing",
      showing: "an unmistakable rounded belly, mid-pregnancy",
      heavily_pregnant: "a large, heavy belly, late pregnancy",
      full_term: "at term, the belly at its largest and carrying low",
    },
  },
]);
