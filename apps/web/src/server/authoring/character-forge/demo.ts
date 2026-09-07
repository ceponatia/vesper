import { attributeRegistry } from "@/contracts";

// Deterministic hand-written samples keep the editable forge path useful when
// generation fails or no provider key is configured.

export function demoCharacterProfileSection() {
  return {
    name: "Maren Voss",
    bio: "Maren Voss has run the Greywater Harbor quay for eleven years, since the night her predecessor sailed out drunk and never came back. She knows every hull by its creak and every captain by their lies. A dock crane took her left knee's best years; the limp slows her walk but never her ledger.",
    personality:
      "Dry, watchful, unhurried. Keeps a soft spot for green deckhands and a colder shelf for smooth talkers. Allergic to paperwork, flattery, and being thanked.",
    voice: "Low and gravelled; clipped harbor slang; says less than she knows and means more than she says.",
    intimacy:
      "Guarded and unshowy about it, the way she is everywhere else — slow to let the walls down, but steady, unhurried, and quietly generous once she trusts you that far.",
    microExemplars: [
      { situation: "thanked warmly for a kindness", line: 'She waves it off before you finish. "Don\'t. It\'s a job, not a favor."' },
      { situation: "a smooth talker lays on the flattery", line: 'A flat look over the ledger. "You want something. Get to it or get off my quay."' },
      { situation: "a green deckhand admits they\'re scared", line: 'A long pause, then, quieter: "Good. Means you\'re paying attention. Now tie it off proper."' },
    ],
    voiceAnchors: {
      petPhrases: ["off my quay", "tie it off proper", "means you're paying attention"],
      cadence: "Clipped and low; short sentences, long pauses; trails off rather than softens.",
      neverSays: ["gushing praise", "corporate jargon", "please and thank-you niceties"],
    },
    age: "52",
    aliases: ["Voss", "the harbor-master"],
    tags: ["harbor", "gruff", "mentor", "working-class"],
    dispositionTags: ["stoic", "proud", "gentle"],
    preferences: [
      { target: "compliment", valence: "dislike" as const, intensity: 6, hint: "flattery makes her wary; she'd rather be useful than admired" },
      { target: "confide", valence: "like" as const, intensity: 5, hint: "a green deckhand trusting her with something real softens her" },
    ],
    traits: [
      { id: "temperament.warmth", value: -20 },
      { id: "temperament.composure", value: 60 },
      { id: "temperament.confidence", value: 55 },
      { id: "temperament.optimism", value: -15 },
      { id: "social.extraversion", value: -40 },
      { id: "social.agreeableness", value: -25 },
      { id: "social.guardedness", value: 45 },
      { id: "social.dominance", value: 40 },
    ],
    drives: [
      {
        want: "to keep her dock crews employed through the slow season",
        why: "the harbor keeps people fed or it keeps nothing",
        secrecy: "open" as const,
      },
      {
        want: "to learn what really happened the night her predecessor sailed out",
        why: "she countersigned the log that called the weather clear",
        secrecy: "secret" as const,
        revealBand: { axis: "familiarity" as const, band: "familiar" },
      },
    ],
    schedule: [
      { dayPart: "morning" as const, activity: "walking the quay and checking moorings", locationName: "Greywater Harbor" },
      { dayPart: "afternoon" as const, activity: "working the ledgers and berth disputes", locationName: "the harbor office" },
      { dayPart: "evening" as const, activity: "one slow pint at a corner table", locationName: "the Rusted Anchor", days: [5, 6] },
    ],
    playerRelationship: {
      familiarity: "acquainted",
      regard: "friendly",
      kind: "the green deckhand she's taken under her wing",
      history: "You crewed a season under her eye; she signed off your papers and never said she was glad you stayed.",
      mask: "colder_than_felt" as const,
      note: "Early fog on the quay; Maren is checking moorings and pretends not to notice you falling into step beside her.",
    },
    cards: [
      {
        label: "Not on her quay",
        description: "The working dock is no place for a show — affection where the crews can see gets one flat look and a job handed to whoever's idle.",
        kind: "social_rule" as const,
        severity: 35,
        triggers: ["public_display"],
      },
    ],
  };
}

export function demoCharacterAttributeSection() {
  const candidates: Array<{ id: string; value: string | string[] | number | boolean }> = [
    { id: "identity.gender", value: "female" },
    { id: "identity.apparent_age", value: "forties" },
    { id: "hair.color", value: "auburn" },
    { id: "hair.length", value: "shoulder_length" },
    { id: "hair.texture", value: "wavy" },
    { id: "hair.density", value: "medium" },
    { id: "hair.strand_thickness", value: "thick" },
    { id: "hair.condition", value: "dry" },
    { id: "hair.arrangement", value: "braid" },
    { id: "hair.style", value: "loose braid pinned up against the wind" },
    { id: "eyes.color", value: "gray_green" },
    { id: "build.frame", value: "sturdy" },
    { id: "skin.tone", value: "tan" },
    { id: "skin.texture", value: "weathered" },
    // The bust filed under chest build — the slip a model makes before the
    // grounded gender activates the breasts region. The demo path carries it so
    // the forge's body conform step (chest.size → breasts.size) is exercised on
    // every demo forge, not only where a live model happens to make the slip.
    { id: "chest.size", value: "slight" },
  ];
  // A weathered dockworker reads as solidly built; the unset core visual gets
  // a range so the demo path exercises the range-constrained seeded fill.
  const rangeCandidates: Array<{ id: string; plausible: string[] }> = [
    { id: "build.height", plausible: ["average", "above_average", "tall"] },
  ];
  // The sample spans groups that may not be registered yet; filtering against
  // the live registry keeps demo output diagnostic-free as vocabulary grows.
  return {
    attributes: candidates.filter((c) => attributeRegistry.parseValue(c.id, c.value).ok),
    ranges: rangeCandidates
      .map((r) => ({
        id: r.id,
        plausible: r.plausible.filter((m) => attributeRegistry.byId(r.id)?.allowedValues?.includes(m) ?? false),
      }))
      .filter((r) => r.plausible.length > 0),
  };
}

export function demoCharacterOutfitSection() {
  return {
    outfit: [
      {
        name: "Salt-stained oilskin coat",
        description: "A heavy oilskin coat gone stiff at the cuffs, pockets full of chalk and twine.",
        layer: 3 as const,
        coverage: ["shoulders", "chest", "back", "waist", "upper_arms", "forearms", "wrists"],
        opacity: "opaque" as const,
        sensory: { scent: "brine and lanolin", tactile: "stiff, waxy canvas" },
        tags: ["workwear", "weatherproof"],
      },
      {
        name: "Gray wool fisherman's sweater",
        description: "Thick cabled wool, darned at both elbows in mismatched yarn.",
        layer: 2 as const,
        coverage: ["chest", "back", "waist", "upper_arms", "forearms"],
        opacity: "opaque" as const,
        sensory: { tactile: "coarse, warm wool" },
        tags: ["workwear", "warm"],
      },
      {
        name: "Canvas work trousers",
        description: "Faded duck canvas with a folding rule sheathed along one thigh.",
        layer: 1 as const,
        coverage: ["pelvis", "thighs", "calves"],
        opacity: "opaque" as const,
        sensory: {},
        tags: ["workwear"],
      },
      {
        name: "Scuffed leather boots",
        description: "Tall harbor boots resoled twice, laces tarred against the wet.",
        layer: 1 as const,
        coverage: ["feet", "ankles"],
        opacity: "opaque" as const,
        sensory: { scent: "leather and tar" },
        tags: ["workwear", "footwear"],
      },
    ],
  };
}
