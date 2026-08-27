/**
 * Shared attribute value vocabularies — reusable `allowedValues` lists so a value set
 * lives in one place instead of being copy-pasted across category files. The pattern is
 * **base + per-field augment**: a field spreads a shared constant and may add its own
 * terms — `allowedValues: [...HAIR_DENSITY]` or `allowedValues: [...INTIMATE_SCENT_BASE, "sweet"]`.
 *
 * Pure (`const` data only — no IO/env). A shared list MUST reproduce the exact value
 * strings of any list it replaces: `allowedValues` members are persisted on character
 * profiles (`AttributeValue.value`), so renaming one silently invalidates stored values
 * (they fail `parseValue` and degrade away). Add a constant here only when a real
 * duplication appears; curated, identity-defining lists (eyes/hair/skin color) stay
 * local on purpose.
 */

/**
 * Body-hair density. `arms.hair` and `legs.hair` share this exactly. `chest.hair` keeps
 * its own `sparse` variant (body-appropriate) and stays local.
 */
export const HAIR_DENSITY = [
  "none",
  "fine",
  "light",
  "moderate",
  "thick",
] as const;

/**
 * The shared core of intimate scent. Per-anatomy fields augment it: `vulva.scent`
 * adds `sweet`, `penis.scent` uses the base as-is. Intimate *taste* builds on this
 * core via `INTIMATE_TASTE_BASE`.
 */
export const INTIMATE_SCENT_BASE = [
  "clean",
  "fresh",
  "light",
  "soft",
  "warm",
  "earthy",
  "musky",
  "ripe",
  "heady",
  "feral",
  "pungent",
  "briny",
  "metallic",
  "sour",
  "tangy",
  "yeasty",
  "fishy",
  "heavy",
  "thick",
  "animal",
] as const;

/**
 * Sweat-register scent notes appropriate to the penis / testicles / anus — the
 * warmer, saltier funk of skin folds that the (more cycle/arousal-driven) vulva
 * core doesn't foreground. Augments `INTIMATE_SCENT_BASE`: those fields spread
 * `[...INTIMATE_SCENT_BASE, ...INTIMATE_SCENT_SWEAT]`. Only ever *add* to this —
 * a member is persisted once authored (`AttributeValue.value`).
 */
export const INTIMATE_SCENT_SWEAT = ["salty", "sharp", "sweaty"] as const;

/**
 * The shared core of intimate taste — mirrors the scent core's clean/musky/earthy
 * register plus taste-only notes (`mild`, `bitter`, `salty`, `sharp`, `primal`,
 * `faintly_sweet`). Per-anatomy fields augment it: `vulva.taste` adds `sweet`.
 * Keep the two bases aligned when adding terms (only ever *add* a value — never
 * invalidate a stored one).
 */
export const INTIMATE_TASTE_BASE = [
  "clean",
  "fresh",
  "light",
  "mild",
  "soft",
  "warm",
  "earthy",
  "musky",
  "ripe",
  "heady",
  "briny",
  "metallic",
  "sour",
  "tangy",
  "bitter",
  "yeasty",
  "faintly_sweet",
  "salty",
  "sharp",
  "primal",
] as const;

/**
 * Narrator glosses for the shared intimate SCENT core
 * — each entry tells the narrator what the member means *in this game* so it elaborates
 * within the right register instead of paraphrasing a bare token into something milder.
 * Keys ⊆ `INTIMATE_SCENT_BASE`, so any definition spreading the base may spread this map
 * (per-field augments like vulva's `sweet` gloss their own additions inline). Sparse by
 * design: self-evident members (`clean`, `fresh`) stay bare.
 */
export const INTIMATE_SCENT_GUIDANCE: Record<string, string> = {
  light: "barely there — a whisper of skin",
  soft: "gentle and close, no edge to it",
  warm: "warmed skin, faintly humid",
  earthy: "warm damp-earth depth, not sour",
  musky: "classic intimate musk — warm, animal, personal",
  ripe: "a long day's fullness — strong and human",
  heady: "dizzying density — it goes straight to the head",
  feral: "raw animal wildness, past all grooming",
  pungent: "sharp and forceful — fills every breath",
  briny: "sea-salt tang, like warm shoreline",
  metallic: "a faint iron note underneath",
  sour: "an acidic edge over the skin",
  tangy: "bright acidic lift, almost citrus",
  yeasty: "warm bread-ferment note",
  fishy: "unmistakable marine funk",
  heavy: "dense and low — it lingers and settles",
  thick: "so dense the air feels close",
  animal: "plainly animal — fur-warm and primal",
};

/**
 * Narrator glosses for the sweat-register scent notes (keys ⊆ `INTIMATE_SCENT_SWEAT`).
 * Spread alongside `INTIMATE_SCENT_GUIDANCE` wherever a field spreads the sweat set.
 */
export const INTIMATE_SCENT_SWEAT_GUIDANCE: Record<string, string> = {
  salty: "clean sweat-salt carried on warm skin",
  sharp: "a biting, acrid edge that catches the throat",
  sweaty: "fresh sweat — warm, unwashed, close",
};

/**
 * Narrator glosses for the shared intimate TASTE core — same contract as
 * `INTIMATE_SCENT_GUIDANCE` (keys ⊆ `INTIMATE_TASTE_BASE`, sparse, taste-register wording).
 */
export const INTIMATE_TASTE_GUIDANCE: Record<string, string> = {
  light: "barely any taste — mostly warmth",
  mild: "soft and unassertive on the tongue",
  soft: "gentle, rounded, no edge",
  warm: "warmth itself, more feeling than flavor",
  earthy: "deep and grounded, like warm skin and soil",
  musky: "musk carried onto the tongue — warm and animal",
  ripe: "a long day's strength, full and human",
  heady: "rich enough to go to the head",
  briny: "sea-salt, like warm brine",
  metallic: "a faint iron trace",
  sour: "a distinct acidic bite",
  tangy: "bright, sharp acidity",
  bitter: "a low bitter note at the back",
  yeasty: "warm ferment, like rising dough",
  faintly_sweet: "a whisper of sweetness underneath",
  salty: "clean sweat-salt on the tongue",
  sharp: "a biting edge that stings the tongue",
  primal: "raw and bodily — taste as instinct",
};

/**
 * Sensory values unique to constructed humanoid bodies. The attribute registry's
 * vocabularies are global, while species rules decide which bodies may select these
 * members. Existing biological humanoid species spread
 * `organicHumanoidSensoryRules`, so these never leak into their forge/editor choices;
 * the synthetic Android subtype inherits the expanded sets.
 */
export const SYNTHETIC_SCENT_VALUES = [
  "odorless",
  "sterile",
  "faint_ozone",
  "warm_polymer",
  "machine_oil",
] as const;

export const SYNTHETIC_SCENT_GUIDANCE: Record<string, string> = {
  odorless: "no body scent at all, even at intimate range",
  sterile: "clinical cleanliness with no organic musk underneath",
  faint_ozone: "a dry electrical trace, like air after a spark",
  warm_polymer: "clean artificial skin warmed to body temperature",
  machine_oil: "a faint lubricating-oil note from hidden mechanisms",
};

export const SYNTHETIC_TASTE_VALUES = [
  "neutral",
  "sterile",
  "faintly_metallic",
  "synthetic_sweet",
  "coolant_bitter",
] as const;

export const SYNTHETIC_TASTE_GUIDANCE: Record<string, string> = {
  neutral: "almost flavorless — texture and temperature dominate",
  sterile: "clean and clinical, without an organic aftertaste",
  faintly_metallic: "a light conductive-metal trace",
  synthetic_sweet: "precise manufactured sweetness, sugar-like but not organic",
  coolant_bitter: "a controlled bitter-mineral note from synthetic fluid",
};

export const SYNTHETIC_SKIN_TEXTURES = [
  "seamless",
  "silicone_smooth",
  "supple_polymer",
  "porcelain_smooth",
] as const;

export const SYNTHETIC_SKIN_TEXTURE_GUIDANCE: Record<string, string> = {
  seamless: "continuous artificial skin with no visible joins",
  silicone_smooth: "silicone-soft and uniformly smooth under the fingers",
  supple_polymer: "pliant engineered skin with a subtle synthetic give",
  porcelain_smooth: "flawlessly even and almost ceramic-smooth",
};

export const SYNTHETIC_INTIMATE_TEXTURES = [
  "seamless",
  "silicone_smooth",
  "supple_polymer",
  "precision_ridged",
] as const;

export const SYNTHETIC_INTIMATE_TEXTURE_GUIDANCE: Record<string, string> = {
  seamless: "continuous engineered surface without organic irregularity",
  silicone_smooth: "soft silicone-like smoothness with controlled give",
  supple_polymer: "warm, pliant polymer that yields like soft tissue",
  precision_ridged: "deliberate fine ridges formed with machine precision",
};

export const SYNTHETIC_SENSITIVITY_VALUES = [
  "adaptive",
  "tunable",
  "feedback_amplified",
] as const;

export const SYNTHETIC_SENSITIVITY_GUIDANCE: Record<string, string> = {
  adaptive: "sensor gain adjusts itself to the contact",
  tunable: "responsiveness can be deliberately raised or lowered",
  feedback_amplified: "touch feedback is digitally intensified beyond human baseline",
};

export const SYNTHETIC_VOICE_TIMBRES = [
  "synthetic_clear",
  "harmonic",
  "modulated",
  "speaker_smooth",
] as const;

export const SYNTHETIC_VOICE_TIMBRE_GUIDANCE: Record<string, string> = {
  synthetic_clear: "unnaturally clean articulation with no breath noise",
  harmonic: "subtle layered overtones beneath the natural-sounding voice",
  modulated: "precisely shaped resonance with a faint electronic edge",
  speaker_smooth: "warm speaker-like polish, perfectly even across every word",
};

/**
 * Non-skin surface colors for visible fantasy morphology (horns, tail, wings) — a
 * material palette distinct from the curated skin/hair/eye color lists. `matches_skin`
 * covers creatures whose feature shares their skin tone. Used as an `enum_list` so a
 * two-tone feature ("jet-black with a crimson edge") stays expressible.
 */
export const MATERIAL_COLORS = [
  "matches_skin",
  "obsidian",
  "jet_black",
  "charcoal",
  "smoke_grey",
  "ash_grey",
  "bone_white",
  "ivory",
  "pearl",
  "white",
  "crimson",
  "blood_red",
  "russet",
  "tan",
  "umber",
  "green",
  "azure",
  "violet",
  "gold",
  "bronze",
  "copper",
  "silver",
  "iridescent",
  "pearlescent",
  "translucent",
  "glowing",
] as const;
