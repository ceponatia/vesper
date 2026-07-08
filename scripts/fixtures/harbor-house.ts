import type { AttributeValue } from "@/contracts";

/**
 * "Harbor House" starter-world fixture: pure data consumed by scripts/db-seed.ts
 * and validated by harbor-house.test.ts against the contracts registries.
 * Entities reference each other by `key`; the seed script maps keys to row ids.
 */

/** Stable marker tag on every seeded library row; the seed wipes by it. */
export const SEED_TAG = "seed:harbor-house";

export const WORLD_NAME = "Harbor House";

export interface SeedAmbient {
  scent?: string;
  sound?: string;
  light?: string;
}

export interface SeedLocation {
  key: string;
  name: string;
  description: string;
  ambient: SeedAmbient;
  tags: string[];
}

export interface SeedLink {
  from: string;
  to: string;
  label: string;
}

export interface SeedItemExtras {
  coverage?: string[];
  layer?: 0 | 1 | 2 | 3;
  opacity?: "opaque" | "sheer";
  sensory?: { appearance?: string; scent?: string; tactile?: string };
  fields?: Record<string, unknown>;
}

export interface SeedItem {
  key: string;
  kind: "clothing" | "object" | "container";
  name: string;
  description: string;
  extras?: SeedItemExtras;
  tags?: string[];
}

export interface SeedScheduleEntry {
  startMinute: number;
  endMinute: number;
  /** Must match a SeedLocation.name exactly. */
  locationName: string;
  activity: string;
}

export interface SeedCharacter {
  key: string;
  name: string;
  tags: string[];
  bio: string;
  personality: string;
  voice: string;
  /** Real/chronological age (free text) — the narrator's `profile.age`, distinct from the visual `identity.apparent_age` attribute. */
  age: string;
  aliases: string[];
  attributes: AttributeValue[];
  /** SeedItem keys (clothing) worn at session spawn. */
  defaultOutfitKeys: string[];
  schedule: SeedScheduleEntry[];
}

export interface SeedCastEntry {
  characterKey: string;
  role: "companion" | "npc";
  startLocationKey: string;
}

/** Exactly one of locationKey / castKey / containerKey must be set. */
export interface SeedPlacement {
  itemKey: string;
  locationKey?: string;
  castKey?: string;
  worn?: boolean;
  /** SeedItem key of a container that itself has a placement. */
  containerKey?: string;
  quantity?: number;
}

export interface SeedLoreChunk {
  title: string;
  body: string;
  category: "history" | "geography" | "institution" | "culture" | "relationship" | "secret" | "tone";
  tier: "always" | "scene" | "retrieval";
  visibility: "public" | "secret";
  unlockTags?: string[];
  /** Lowercased session-location names (matching is name-based). */
  locationTags?: string[];
  characterKeys?: string[];
  sort: number;
}

export interface SeedFaction {
  id: string;
  name: string;
  description: string;
  memberCharacterKeys: string[];
  conflicts: Array<{ factionName: string; notes: string }>;
}

export interface SeedPlotAnchor {
  id: string;
  title: string;
  summary: string;
  priority: "background" | "active";
}

export interface SeedWorldFixture {
  name: string;
  description: string;
  style: {
    directives: string[];
    narratorGuidance: string;
    calendarStart: { year: number; month: number; day: number; hour: number; minute: number };
    socialCards: Array<{
      id: string;
      label: string;
      description: string;
      kind: "social_rule" | "taboo";
      triggers: string[];
      severity: number;
      reactionOverrides: never[];
    }>;
  };
  synopsis: string;
  factions: SeedFaction[];
  plotAnchors: SeedPlotAnchor[];
  locations: SeedLocation[];
  links: SeedLink[];
  items: SeedItem[];
  characters: SeedCharacter[];
  cast: SeedCastEntry[];
  placements: SeedPlacement[];
  loreChunks: SeedLoreChunk[];
}

const base = (id: AttributeValue["id"], value: AttributeValue["value"]): AttributeValue => ({
  id,
  value,
  source: "base",
});

// ---------------------------------------------------------------------------
// Locations
// ---------------------------------------------------------------------------

const locations: SeedLocation[] = [
  {
    key: "living-room",
    name: "Living Room",
    description:
      "The heart of the apartment: a deep bay window over the harbor, a sagging green sofa, shelves of tide tables and sea-swollen paperbacks. A brass barometer hangs by the door, polished where it gets tapped.",
    ambient: {
      scent: "salt air, old paper, and yesterday's coffee",
      sound: "gulls, and rigging lines ticking against masts below",
      light: "wide bay-window light that changes with the weather",
    },
    tags: ["interior", "apartment", "harbor"],
  },
  {
    key: "kitchen",
    name: "Kitchen",
    description:
      "A galley kitchen barely two arm-spans wide: an enamel stove, open shelves of mismatched crockery, and a window over the sink that catches the morning sun off the water.",
    ambient: {
      scent: "coffee grounds, lemon soap, and warm bread on good days",
      sound: "the kettle ticking on the stove, water in old pipes",
      light: "low morning sun off the harbor, warm bulb after dark",
    },
    tags: ["interior", "apartment", "galley"],
  },
  {
    key: "bedroom",
    name: "Bedroom",
    description:
      "A low-ceilinged room under the roof beams: a brass-framed bed heaped with quilts, a driftwood chest at its foot, and a skylight you can hear the rain on.",
    ambient: {
      scent: "lavender, clean linen, a ghost of cedar",
      sound: "muffled harbor bells, rain on the skylight when it comes",
      light: "soft and curtained, gold in the evening",
    },
    tags: ["interior", "apartment", "private"],
  },
  {
    key: "bathroom",
    name: "Bathroom",
    description:
      "Small and white-tiled, with a deep claw-foot tub, a shaving mirror gone cloudy at the edges, and a stubborn brass tap that runs hot only after it knocks twice.",
    ambient: {
      scent: "cedar soap and damp tile",
      sound: "pipes knocking, the slow drip of the cold tap",
      light: "frosted-glass daylight, dim and even",
    },
    tags: ["interior", "apartment", "private"],
  },
  {
    key: "balcony",
    name: "Balcony",
    description:
      "A narrow iron balcony hung off the seaward wall, just wide enough for two chairs and a pot of rosemary. The whole working harbor spreads out below: quays, cranes, the channel markers blinking out to sea.",
    ambient: {
      scent: "brine, rope tar, rosemary when you brush it",
      sound: "water slapping hulls, winch motors, far-off gull arguments",
      light: "open sky — hard and bright or grey and close, as the weather decides",
    },
    tags: ["exterior", "harbor", "view"],
  },
  {
    key: "hallway",
    name: "Hallway",
    description:
      "The shared top-floor landing: worn stair runner, a row of brass coat hooks, and two facing doors — the apartment's and Jonas's workshop-flat across the way, which breathes out wood-shavings when it opens.",
    ambient: {
      scent: "wood polish, dust, a thread of spruce shavings from across the landing",
      sound: "stairwell echoes, and sometimes a violin being coaxed through a phrase",
      light: "a single brass sconce, amber and a little tired",
    },
    tags: ["interior", "landing", "shared"],
  },
];

/** Traversable in both directions (engine treats links as bidirectional). */
const links: SeedLink[] = [
  { from: "hallway", to: "living-room", label: "front door" },
  { from: "living-room", to: "kitchen", label: "open doorway" },
  { from: "living-room", to: "balcony", label: "glass door" },
  { from: "hallway", to: "bedroom", label: "bedroom door" },
  { from: "hallway", to: "bathroom", label: "bathroom door" },
];

// ---------------------------------------------------------------------------
// Items: wardrobe, containers, household objects
// ---------------------------------------------------------------------------

const items: SeedItem[] = [
  // — Maya's wardrobe —
  {
    key: "underthings-maya",
    kind: "clothing",
    name: "Soft cotton underthings",
    description: "A plain matched set, washed to softness.",
    extras: {
      coverage: ["chest", "hips", "groin"],
      layer: 0,
      sensory: { tactile: "washed-thin cotton, warm from skin" },
    },
    tags: ["underwear"],
  },
  {
    key: "linen-shirt",
    kind: "clothing",
    name: "Linen work shirt",
    description: "Off-white linen, sleeves usually rolled past the elbow.",
    extras: {
      coverage: ["shoulders", "chest", "back", "waist", "arms", "forearms"],
      layer: 1,
      sensory: { appearance: "off-white linen, collar open, sleeves rolled", tactile: "dry, crisp weave" },
    },
    tags: ["shirt"],
  },
  {
    key: "cable-sweater",
    kind: "clothing",
    name: "Cable-knit sweater",
    description: "Cream wool, salt-faded at the cuffs, big enough to disappear into.",
    extras: {
      coverage: ["shoulders", "chest", "back", "waist", "arms", "forearms"],
      layer: 2,
      sensory: { appearance: "cream cable knit, cuffs gone grey", scent: "lanolin and faint woodsmoke" },
    },
    tags: ["sweater"],
  },
  {
    key: "deck-trousers",
    kind: "clothing",
    name: "Canvas deck trousers",
    description: "Heavy tan canvas, knees gone pale from kneeling on thwarts.",
    extras: {
      coverage: ["hips", "groin", "thighs", "calves"],
      layer: 1,
      sensory: { appearance: "tan canvas, pale at the knees", tactile: "stiff, broken-in canvas" },
    },
    tags: ["trousers"],
  },
  {
    key: "wool-socks",
    kind: "clothing",
    name: "Grey wool socks",
    description: "Thick-knit and darned twice at the heel.",
    extras: { coverage: ["ankles", "feet", "toes"], layer: 0 },
    tags: ["socks"],
  },
  {
    key: "deck-boots",
    kind: "clothing",
    name: "Leather deck boots",
    description: "Oiled brown leather, salt-rimed at the welt, resoled more than once.",
    extras: {
      coverage: ["feet", "ankles"],
      layer: 1,
      sensory: { appearance: "oiled brown leather with a white salt line", scent: "leather oil and brine" },
    },
    tags: ["boots"],
  },
  {
    key: "peacoat",
    kind: "clothing",
    name: "Harbor peacoat",
    description: "Navy wool with brass buttons gone dull; lives on the hook by the front door.",
    extras: {
      coverage: ["shoulders", "chest", "back", "waist", "arms", "forearms"],
      layer: 3,
      sensory: { appearance: "navy wool, dull brass buttons", scent: "wet wool and the whole harbor" },
    },
    tags: ["coat", "outerwear"],
  },
  {
    key: "watch-cap",
    kind: "clothing",
    name: "Knit watch cap",
    description: "Charcoal wool, usually balled in a pocket rather than worn.",
    extras: { coverage: ["head", "hair"], layer: 1 },
    tags: ["hat"],
  },
  {
    key: "sheer-gown",
    kind: "clothing",
    name: "Sheer dressing gown",
    description: "Sea-glass green chiffon, nearly weightless — a gift Maya claims she never wears.",
    extras: {
      coverage: ["shoulders", "chest", "back", "waist", "hips", "arms"],
      layer: 2,
      opacity: "sheer",
      sensory: { appearance: "sea-glass green chiffon that barely settles", tactile: "cool and slippery" },
    },
    tags: ["sleepwear"],
  },
  // — Jonas's wardrobe —
  {
    key: "undershirt",
    kind: "clothing",
    name: "Cotton undershirt",
    description: "White cotton gone ivory with washing.",
    extras: { coverage: ["chest", "back", "waist"], layer: 0 },
    tags: ["underwear"],
  },
  {
    key: "flannel-shirt",
    kind: "clothing",
    name: "Flannel shirt",
    description: "Green-and-grey plaid, elbows worn thin, buttons replaced in almost-matching horn.",
    extras: {
      coverage: ["shoulders", "chest", "back", "waist", "arms", "forearms"],
      layer: 1,
      sensory: { appearance: "soft green-grey plaid, thin at the elbows", tactile: "brushed soft" },
    },
    tags: ["shirt"],
  },
  {
    key: "cord-trousers",
    kind: "clothing",
    name: "Corduroy trousers",
    description: "Brown cord, the wale rubbed smooth across the knees from years at a workbench.",
    extras: { coverage: ["hips", "groin", "thighs", "calves"], layer: 1 },
    tags: ["trousers"],
  },
  {
    key: "work-apron",
    kind: "clothing",
    name: "Luthier's work apron",
    description: "Waxed canvas, pockets holding a fingerplane, a pencil stub, and a spool of gut.",
    extras: {
      coverage: ["chest", "waist", "thighs"],
      layer: 2,
      sensory: { appearance: "waxed canvas apron, pockets bristling with small tools", scent: "spruce shavings and rosin" },
      fields: { pockets: ["fingerplane", "pencil stub", "spool of gut string"] },
    },
    tags: ["apron", "workwear"],
  },
  {
    key: "felt-slippers",
    kind: "clothing",
    name: "Felt house slippers",
    description: "Grey felt, silent on the landing boards.",
    extras: { coverage: ["feet", "toes"], layer: 1 },
    tags: ["slippers"],
  },
  // — Containers —
  {
    key: "driftwood-chest",
    kind: "container",
    name: "Driftwood chest",
    description: "A low sea chest of silvered driftwood at the foot of the bed; the lid sticks unless you know the trick.",
    extras: { fields: { capacity: 8 }, sensory: { scent: "cedar lining and old lavender sachets" } },
    tags: ["furniture", "storage"],
  },
  {
    key: "biscuit-tin",
    kind: "container",
    name: "Copper biscuit tin",
    description: "A dented copper tin on the top kitchen shelf, polished only where hands reach it.",
    extras: { fields: { capacity: 3 } },
    tags: ["kitchen", "storage"],
  },
  {
    key: "violin-case",
    kind: "container",
    name: "Battered violin case",
    description: "Lined in moth-eaten green velvet; a second name has been worn off the handle tag.",
    extras: { fields: { capacity: 1 } },
    tags: ["music", "storage"],
  },
  // — Household objects —
  {
    key: "kettle",
    kind: "object",
    name: "Cast-iron kettle",
    description: "Heavy, blackened, and trusted; it announces a boil with a low whistle that builds.",
    extras: { sensory: { appearance: "black cast iron with a burnished handle" } },
    tags: ["kitchen"],
  },
  {
    key: "barometer",
    kind: "object",
    name: "Brass ship's barometer",
    description: "Salvaged, polished, and tapped twice every morning out of pure habit.",
    extras: { sensory: { appearance: "brass case, needle trembling at 'change'" } },
    tags: ["instrument"],
  },
  {
    key: "charts",
    kind: "object",
    name: "Roll of harbor charts",
    description: "Saltmere approaches and the channel, with pencil corrections in two different hands.",
    extras: { sensory: { appearance: "rolled charts, edges soft with handling" } },
    tags: ["charts", "navigation"],
  },
  {
    key: "storm-lantern",
    kind: "object",
    name: "Storm lantern",
    description: "Galvanized and dented, wick trimmed, kept full — festival habit and blackout insurance both.",
    tags: ["light"],
  },
  {
    key: "rosemary",
    kind: "object",
    name: "Potted rosemary",
    description: "Leggy from the wind but stubbornly alive, like most things on this balcony.",
    extras: { sensory: { scent: "sharp resinous rosemary when brushed" } },
    tags: ["plant"],
  },
  {
    key: "blanket",
    kind: "object",
    name: "Spare wool blanket",
    description: "Grey with a red stripe, harbor-issue, scratchy and warm.",
    extras: { sensory: { tactile: "scratchy dense wool" } },
    tags: ["bedding"],
  },
  {
    key: "letters",
    kind: "object",
    name: "Bundle of old letters",
    description: "Tied with tarred twine, the addresses fogged with age. The top one was never sent.",
    extras: { sensory: { appearance: "yellowed envelopes under tarred twine", scent: "dust and faded ink" } },
    tags: ["letters", "keepsake"],
  },
  {
    key: "violin",
    kind: "object",
    name: "Half-mended violin",
    description: "A hairline crack runs the lower bout; new spruce cleats inside show patient, unfinished work.",
    extras: { sensory: { appearance: "honey-varnished violin, crack cleated from inside", scent: "rosin and old varnish" } },
    tags: ["violin", "instrument"],
  },
];

// ---------------------------------------------------------------------------
// Characters
// ---------------------------------------------------------------------------

const maya: SeedCharacter = {
  key: "maya",
  name: "Maya",
  tags: ["companion", "harbor"],
  bio:
    "Maya has piloted ships through the Saltmere channel for eleven years — the youngest ever to hold the senior pilot's ticket, a fact she will tell you herself, deadpan, if you take too long to ask. She grew up two streets from the quay, keeps the top-floor apartment at Harbor House, and knows every captain, crane operator, and customs cat by name. She was aboard as junior pilot the night the freighter Meridian went down beyond the breakwater; she does not talk about it, and the harbor has learned not to ask.",
  personality:
    "Warm and wry, generous with teasing and stingy with complaints. Reads weather and people the same way: quietly, constantly, and a half-step ahead. Deflects anything tender with a joke, then circles back to it later when she's ready. Fiercely loyal to the harbor's people; allergic to being fussed over.",
  voice: "Low and unhurried, teasing delivered straight-faced; her coastal lilt broadens when she laughs or swears.",
  age: "38",
  aliases: ["Maya Brennan", "Captain Brennan", "the pilot"],
  attributes: [
    base("identity.gender", "female"),
    base("identity.apparent_age", "late_thirties"),
    base("identity.heritage", "Saltmere-born, coastal stock for generations"),
    base("build.height", "average"),
    base("build.frame", "average"),
    base("build.musculature", "toned"),
    base("build.weight_presentation", "average"),
    base("skin.tone", "brown"),
    base("skin.undertone", "warm"),
    base("skin.texture", "weathered"),
    base("skin.markings", ["scars", "sun_spots"]),
    base("hair.color", "black"),
    base("hair.length", "chin_length"),
    base("hair.texture", "coily"),
    base("hair.style", "salt-stiff curls pushed back off her face, forever escaping"),
    base("eyes.color", "dark_brown"),
    base("eyes.shape", "upturned"),
    base("face.shape", "heart"),
    base("face.freckles", "none"),
    base("face.expression_default", "wry"),
    base("brows.shape", "arched"),
    base("brows.thickness", "full"),
    base("lips.fullness", "full"),
    base("lips.shape", "wide"),
    base("ears.shape", "small"),
    base("ears.piercings", "single_lobe"),
    base("neck.length", "average"),
    base("neck.throat_prominence", "smooth"),
    base("shoulders.width", "broad"),
    base("shoulders.slope", "square"),
    base("chest.size", "modest"),
    base("chest.hair", "none"),
    base("waist.definition", "defined"),
    base("hips.width", "average"),
    base("arms.build", "toned"),
    base("arms.hair", "fine"),
    base("hands.size", "average"),
    base("hands.texture", "calloused"),
    base("hands.nails", "short"),
    base("legs.build", "athletic"),
    base("legs.length", "proportionate"),
    base("legs.hair", "light"),
    base("feet.size", "average"),
    base("feet.arch", "high"),
    base("feet.nails", "trimmed"),
    base("voice.pitch", "medium_low"),
    base("voice.timbre", "warm"),
    base("voice.accent", "soft coastal lilt that broadens when she laughs"),
    base("voice.cadence", "measured"),
    base("presentation.style", "practical"),
    base("presentation.grooming", "low_maintenance"),
    base("presentation.scent_baseline", "salt, engine oil, and orange peel"),
    base("movement.gait", "purposeful"),
    base("movement.posture_default", "easy"),
  ],
  defaultOutfitKeys: ["underthings-maya", "linen-shirt", "deck-trousers", "wool-socks", "deck-boots", "cable-sweater"],
  schedule: [
    { startMinute: 0, endMinute: 360, locationName: "Bedroom", activity: "sleeping" },
    { startMinute: 360, endMinute: 405, locationName: "Bathroom", activity: "shower, with the weather radio carrying through the door" },
    { startMinute: 405, endMinute: 480, locationName: "Kitchen", activity: "coffee, toast, and tide tables" },
    { startMinute: 480, endMinute: 1020, locationName: "Balcony", activity: "on call — glasses on the channel between pilot launches" },
    { startMinute: 1020, endMinute: 1140, locationName: "Living Room", activity: "mending charts, half-listening to the VHF" },
    { startMinute: 1140, endMinute: 1260, locationName: "Kitchen", activity: "cooking dinner with the radio low" },
    { startMinute: 1260, endMinute: 1380, locationName: "Living Room", activity: "reading in the bay window" },
    { startMinute: 1380, endMinute: 1439, locationName: "Bedroom", activity: "winding down" },
  ],
};

const jonas: SeedCharacter = {
  key: "jonas",
  name: "Jonas",
  tags: ["npc", "neighbor", "luthier"],
  bio:
    "Jonas keeps the workshop-flat across the landing, where he has repaired the harbor's fiddles, guitars, and one improbable hurdy-gurdy for nearly thirty years. He came to Saltmere from somewhere east he never names, married a violinist named Elise, and buried her eight winters ago. He pays his respects to the sea every morning from the stairwell window and has been mending the same violin, slowly, for years.",
  personality:
    "Quiet and exact, with a long fuse and a dry, surprising wit that arrives about once an evening. Listens more than he speaks; remembers everything. Kindness expressed through small repairs — a sticking door eased, a chair re-glued — rather than words. Carries old grief gently, like something fragile he's decided to keep.",
  voice: "Low and soft-spoken, words placed carefully with pauses you learn to wait through.",
  age: "54",
  aliases: ["Jonas Keller", "the luthier"],
  attributes: [
    base("identity.gender", "male"),
    base("identity.apparent_age", "fifties"),
    base("identity.heritage", "continental east — he has never named the country"),
    base("build.height", "tall"),
    base("build.frame", "slight"),
    base("build.musculature", "lightly_toned"),
    base("build.weight_presentation", "slim"),
    base("skin.tone", "fair"),
    base("skin.undertone", "neutral"),
    base("skin.texture", "dry"),
    base("skin.markings", ["scars", "moles"]),
    base("hair.color", "gray"),
    base("hair.length", "short"),
    base("hair.texture", "wavy"),
    base("hair.style", "combed back, carrying workshop dust by afternoon"),
    base("eyes.color", "gray_green"),
    base("eyes.shape", "deep_set"),
    base("face.shape", "oblong"),
    base("face.freckles", "faint"),
    base("face.expression_default", "melancholy"),
    base("brows.shape", "straight"),
    base("brows.thickness", "bushy"),
    base("lips.fullness", "thin"),
    base("lips.shape", "downturned"),
    base("ears.shape", "large"),
    base("ears.piercings", "none"),
    base("neck.length", "long"),
    base("neck.throat_prominence", "noticeable"),
    base("shoulders.width", "average"),
    base("shoulders.slope", "sloped"),
    base("chest.size", "average"),
    base("chest.hair", "moderate"),
    base("waist.definition", "straight"),
    base("hips.width", "narrow"),
    base("arms.build", "wiry"),
    base("arms.hair", "moderate"),
    base("hands.size", "large"),
    base("hands.texture", "calloused"),
    base("hands.nails", "neatly_trimmed"),
    base("legs.build", "slender"),
    base("legs.length", "long"),
    base("legs.hair", "moderate"),
    base("feet.size", "long"),
    base("feet.arch", "average"),
    base("feet.nails", "trimmed"),
    base("voice.pitch", "low"),
    base("voice.timbre", "soft_spoken"),
    base("voice.accent", "old-country vowels worn smooth by thirty years at the quay"),
    base("voice.cadence", "halting"),
    base("presentation.style", "vintage"),
    base("presentation.grooming", "neat"),
    base("presentation.scent_baseline", "spruce shavings, rosin, and black tea"),
    base("movement.gait", "ambling"),
    base("movement.posture_default", "relaxed"),
  ],
  defaultOutfitKeys: ["undershirt", "flannel-shirt", "cord-trousers", "felt-slippers", "work-apron"],
  schedule: [
    { startMinute: 540, endMinute: 570, locationName: "Hallway", activity: "collecting the post, unhurried" },
    { startMinute: 1050, endMinute: 1140, locationName: "Living Room", activity: "evening tea visit, violin case in hand" },
  ],
};

// ---------------------------------------------------------------------------
// Lore
// ---------------------------------------------------------------------------

const loreChunks: SeedLoreChunk[] = [
  {
    title: "The feel of Harbor House",
    body:
      "Harbor House runs on small rituals: the barometer tapped twice each morning, the kettle filled before anyone asks, lamps lit in the seaward windows at dusk. Scenes here are allowed to be slow. The drama is weather, tide, and what people almost say to each other.",
    category: "tone",
    tier: "always",
    visibility: "public",
    sort: 0,
  },
  {
    title: "Saltmere and its harbor",
    body:
      "Saltmere is a working harbor town: a deep-water channel walled by a granite breakwater, a quay of fish sheds and chandlers, and terraces of tall narrow houses stacked up the hill. Harbor House is the topmost flat of an old sail-loft on the quay row. Every ship larger than a coaster takes a guild pilot through the channel — the sandbars shift with each storm, and the charts are corrected by hand.",
    category: "geography",
    tier: "always",
    visibility: "public",
    sort: 1,
  },
  {
    title: "Kitchen rules",
    body:
      "The kitchen runs on Maya's one law: whoever is up first fills the kettle, and nobody touches the chipped blue mug — it was her father's. The copper biscuit tin on the top shelf is officially for biscuits; it has not held biscuits in years, and Maya gets quietly brisk if anyone reaches for it.",
    category: "culture",
    tier: "scene",
    visibility: "public",
    locationTags: ["kitchen"],
    sort: 2,
  },
  {
    title: "Maya and the channel",
    body:
      "Maya reads the channel the way other people read faces. She can tell the tide's mood from the sound of water on the quay stones and will interrupt anything mid-sentence to watch a ship she doesn't recognize come past the breakwater. When a pilot launch goes out at night, she stands at the window until it's back.",
    category: "relationship",
    tier: "scene",
    visibility: "public",
    characterKeys: ["maya"],
    sort: 3,
  },
  {
    title: "Reading weather from the rail",
    body:
      "From the balcony rail you can read the next twelve hours: gulls sitting on the water mean calm, smoke flattening off the fish sheds means a blow coming, and a green-grey light over the breakwater is the harbor's only true warning. Locals trust the rail more than the radio forecast.",
    category: "culture",
    tier: "scene",
    visibility: "public",
    locationTags: ["balcony"],
    sort: 4,
  },
  {
    title: "The luthier across the landing",
    body:
      "Jonas's door breathes out spruce shavings when it opens, and his evening visits follow a liturgy: two knocks, a pause, tea taken black, one piece of harbor news traded for one piece of advice nobody asked for. If his violin phrase drifts across the landing and stops mid-bar, he has thought of Elise, and the kind thing is to let it pass unremarked.",
    category: "relationship",
    tier: "scene",
    visibility: "public",
    characterKeys: ["jonas"],
    sort: 5,
  },
  {
    title: "The sail-loft years",
    body:
      "Before it was flats, Harbor House was Aldous & Co., Sailmakers — three generations cutting canvas on the long floor that is now the living room and bedroom. The bay window was the gaffer's perch, set wide so he could watch his sails come up the channel. Loft hooks still hide in the roof beams, and the floorboards keep their needle scars.",
    category: "history",
    tier: "retrieval",
    visibility: "public",
    sort: 6,
  },
  {
    title: "The Pilots' Guild",
    body:
      "The Saltmere Pilots' Guild is older than the town charter and acts like it: seven licensed pilots, a ledger of every transit since 1871, and a standing feud with the harbormaster's office over mooring fees. The guild looks after its own — widows' rents quietly paid, repairs quietly done — and closes like a fist around its mistakes.",
    category: "institution",
    tier: "retrieval",
    visibility: "public",
    sort: 7,
  },
  {
    title: "The wreck of the Meridian",
    body:
      "The freighter Meridian went down beyond the breakwater nine years ago in a November gale, with the senior pilot Edda Voss aboard. The inquiry blamed a shifted sandbar and closed the file. Maya was the junior pilot on the launch that night; she pulled two sailors from the water and could not reach the third. The guild ledger's page for that night has been razored out — and the salvage divers now circling the wreck line are looking for the same thing the guild hoped the sea had kept.",
    category: "secret",
    tier: "retrieval",
    visibility: "secret",
    unlockTags: ["meridian", "wreck", "salvage"],
    sort: 8,
  },
  {
    title: "What the letters hold",
    body:
      "The bundle in the copper biscuit tin is letters from Edda Voss to Maya — mentor to apprentice — and the unsent one on top is in Maya's hand, addressed to Edda's widower: Jonas. It says what the inquiry would not: that the Meridian was ordered into the channel against Edda's refusal, and by whom. Jonas has never read it. The violin he cannot finish mending was Edda's gift to Elise; the two households' griefs are knotted together more tightly than either survivor knows.",
    category: "secret",
    tier: "retrieval",
    visibility: "secret",
    unlockTags: ["letters", "violin", "biscuit tin"],
    sort: 9,
  },
];

// ---------------------------------------------------------------------------
// World assembly
// ---------------------------------------------------------------------------

export const harborHouse: SeedWorldFixture = {
  name: WORLD_NAME,
  description:
    "A snug top-floor apartment above the working harbor of Saltmere — slow weather, small rituals, and two neighbors with knotted histories.",
  style: {
    directives: [
      "Quiet, grounded domestic realism: weather, tide, and small sounds carry the mood.",
      "Let silences and small gestures do the emotional work; no melodrama.",
      "The harbor is always faintly present — gulls, bells, engines — even indoors.",
      "Sensory detail over plot momentum; scenes are allowed to be slow.",
    ],
    narratorGuidance:
      "Write close and warm. Maya teases gently and deflects tenderness with humor; Jonas says little and means all of it. Let the weather do some of the talking.",
    calendarStart: { year: 2024, month: 9, day: 14, hour: 7, minute: 30 },
    socialCards: [
      {
        id: "knock-and-wait",
        label: "Neighbors knock and wait",
        description: "Doors on the landing stay unlocked but are never opened uninvited; walking in unannounced earns a long pause and cooler conversation.",
        kind: "social_rule",
        triggers: [],
        severity: 40,
        reactionOverrides: [],
      },
      {
        id: "dont-press-the-wreck",
        label: "Don't press a pilot about her wrecks",
        description: "Harbor talk is fair game, but pressing Maya about wrecks she has worked is intrusive — she changes the subject and the room goes quiet.",
        kind: "social_rule",
        triggers: ["boundary_push"],
        severity: 40,
        reactionOverrides: [],
      },
      {
        id: "ask-the-keeper",
        label: "Ask before lending the harbor's things",
        description: "Nothing of the harbor's — rope, charts, lanterns — is lent onward without asking its keeper.",
        kind: "social_rule",
        triggers: [],
        severity: 15,
        reactionOverrides: [],
      },
    ],
  },
  synopsis:
    "Harbor House is the top floor of an old sail-loft above Saltmere's working harbor: Maya, a warm and wry channel pilot who never talks about the wreck that made her; and across the landing, Jonas, a quiet luthier mending the same violin for years. Salvage divers are circling the old wreck line, the Festival of Lamps is coming, and a bundle of unsent letters in a biscuit tin holds the truth both households have been living around.",
  factions: [
    {
      id: "pilots-guild",
      name: "Saltmere Pilots' Guild",
      description:
        "Seven licensed pilots and a ledger going back to 1871. Protective, proud, and quietly ruthless about its own reputation.",
      memberCharacterKeys: ["maya"],
      conflicts: [
        { factionName: "Harbormaster's Office", notes: "A standing feud over mooring fees and over who answers for the Meridian." },
      ],
    },
    {
      id: "quayside-traders",
      name: "Quayside Traders",
      description:
        "The fish-shed and chandlery families of the lower quay — the harbor's gossip network and its memory. They liked Edda Voss, and they notice the salvage boats.",
      memberCharacterKeys: [],
      conflicts: [],
    },
  ],
  plotAnchors: [
    {
      id: "meridian-question",
      title: "The Meridian question",
      summary:
        "Salvage divers have been working the old wreck line beyond the breakwater. Maya watches them through the glasses and says nothing; the guild is starting to ask what they might bring up.",
      priority: "active",
    },
    {
      id: "festival-of-lamps",
      title: "The Festival of Lamps",
      summary:
        "At the autumn festival every window facing the water sets a lamp for the harbor's dead. Jonas has been asked to play this year — on the violin he has never finished mending.",
      priority: "background",
    },
  ],
  locations,
  links,
  items,
  characters: [maya, jonas],
  cast: [
    { characterKey: "maya", role: "companion", startLocationKey: "living-room" },
    { characterKey: "jonas", role: "npc", startLocationKey: "hallway" },
  ],
  placements: [
    // containers in rooms
    { itemKey: "driftwood-chest", locationKey: "bedroom" },
    { itemKey: "biscuit-tin", locationKey: "kitchen" },
    { itemKey: "violin-case", locationKey: "living-room" },
    // container contents
    { itemKey: "blanket", containerKey: "driftwood-chest" },
    { itemKey: "sheer-gown", containerKey: "driftwood-chest" },
    { itemKey: "letters", containerKey: "biscuit-tin" },
    { itemKey: "violin", containerKey: "violin-case" },
    // household objects
    { itemKey: "kettle", locationKey: "kitchen" },
    { itemKey: "barometer", locationKey: "living-room" },
    { itemKey: "charts", locationKey: "living-room" },
    { itemKey: "storm-lantern", locationKey: "balcony" },
    { itemKey: "rosemary", locationKey: "balcony" },
    // loose clothing
    { itemKey: "peacoat", locationKey: "hallway" },
    { itemKey: "watch-cap", castKey: "maya", worn: false },
  ],
  loreChunks,
};
