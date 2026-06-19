/**
 * Shared attribute value vocabularies — reusable `allowedValues` lists so a value set
 * lives in one place instead of being copy-pasted across category files. The pattern is
 * **base + per-field augment**: a field spreads a shared constant and may add its own
 * terms — `allowedValues: [...HAIR_DENSITY]` or `allowedValues: [...INTIMATE_SCENT_BASE, "sweet"]`.
 *
 * Pure (`const` arrays only — no IO/env). A shared list MUST reproduce the exact value
 * strings of any list it replaces: `allowedValues` members are persisted on character
 * profiles (`AttributeValue.value`), so renaming one silently invalidates stored values
 * (they fail `parseValue` and degrade away). Add a constant here only when a real
 * duplication appears; curated, identity-defining lists (eyes/hair/skin color) stay
 * local on purpose — see docs/developer-notes/attribute-mutability.spec.md §6.
 */

/**
 * Body-hair density. `arms.hair` and `legs.hair` share this exactly. `chest.hair` keeps
 * its own `sparse` variant (body-appropriate) and stays local.
 */
export const HAIR_DENSITY = ["none", "fine", "light", "moderate", "thick"] as const;

/**
 * The shared core of intimate scent/taste. Per-anatomy fields augment it: `vulva.scent`
 * adds `sweet`, `vulva.taste` adds `tangy`+`sweet`, `penis.scent` uses the base as-is.
 */
export const INTIMATE_SCENT_BASE = ["clean", "musky", "salty"] as const;

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
