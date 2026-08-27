import { type AttributeDefinition, promptValueWithNoneElided } from "@/contracts/attributes";
import { INTIMATE_ATTRIBUTE_CATEGORIES } from "@/contracts/body/locations";
import { realizeBody } from "@/contracts/species";
import type { CharacterProfile } from "@/contracts/world/profile";

/**
 * The prompt format kit: the attribute predicates, the appearance clause order
 * and the small text formatters every prompt family shares.
 *
 * The leaf of `./prompts-*.ts` — it imports no other prompt module, and the
 * families import it rather than each other.
 */

/**
 * Intimate-anatomy attributes are withheld from image prompts unless the caller
 * sets `allowIntimate` (body-model spec Decision 3). Image generation is now
 * uncensored end-to-end, so avatar generation always sets it; the
 * gate remains off for the moderation-prone scene composer's appearance summary.
 */
/**
 * Non-visual attributes never belong in an image prompt — an image can't depict
 * how someone sounds, smells, or how sensitive they are. `kind: "sensory"` is the
 * auditory/olfactory/tactile-response set (voice pitch/timbre/cadence, baseline
 * scent, intimate scent/taste, and per-region sensitivity), so it is dropped from
 * both the avatar prompt and the scene appearance summary. (Intimate sensory
 * anatomy is already gated separately by the exposure predicates.)
 */
export function isNonVisualAttribute(def: AttributeDefinition): boolean {
  return def.kind === "sensory";
}

export function isIntimateAttribute(def: AttributeDefinition): boolean {
  return (INTIMATE_ATTRIBUTE_CATEGORIES as readonly string[]).includes(def.category);
}

export function realizedBodyForProfile(profile: CharacterProfile) {
  return realizeBody({
    speciesId: profile.speciesId,
    heritageId: profile.heritageId,
    bodyPlanId: profile.bodyPlanId,
    intimateRegions: profile.intimateRegions,
    bodyFeatures: profile.bodyFeatures,
  });
}

// Appearance bucket order: non-human morphology + skin first (an SDXL-family model
// commits to the creature before the human-ish traits), then body, hair, eyes,
// face, presentation. Categories not listed sort last so a new one degrades
// gracefully (still rendered) instead of vanishing.
const APPEARANCE_CATEGORY_ORDER: readonly string[] = [
  "horns", "wings", "tail",
  "skin",
  "build", "shoulders", "neck", "chest", "breasts", "waist", "arms", "hands",
  "hair",
  "eyes", "brows",
  "face", "nose", "lips", "ears", "teeth",
  "movement",
  "presentation",
];
/** Display noun per bucket; defaults to the capitalized category. */
const APPEARANCE_BUCKET_NOUNS: Readonly<Record<string, string>> = {
  presentation: "Style",
  movement: "Bearing",
  breasts: "Bust",
};

function appearanceOrder(category: string): number {
  const index = APPEARANCE_CATEGORY_ORDER.indexOf(category);
  return index === -1 ? APPEARANCE_CATEGORY_ORDER.length : index;
}

function bucketNoun(category: string): string {
  return APPEARANCE_BUCKET_NOUNS[category] ?? capitalizeFirst(category);
}

/**
 * Caption/tag-style appearance clauses, grouped by category and ordered so
 * non-human morphology leads (scene-images A+B+C). Each clause is
 * "<Noun>: value, value" — the per-attribute label noun is dropped (the bucket
 * header carries it), so the model reads coherent grouped tags instead of a flat
 * "Label: value" metadata wall it largely ignores.
 */
export function orderedAppearanceClauses(byCategory: ReadonlyMap<string, string[]>): string[] {
  return [...byCategory.keys()]
    .sort((a, b) => appearanceOrder(a) - appearanceOrder(b))
    .flatMap((category) => {
      const values = byCategory.get(category) ?? [];
      return values.length > 0 ? [`${bucketNoun(category)}: ${clause(values.join(", "))}`] : [];
    });
}

/**
 * The subject's lead phrase — "a <apparent age> <gender> <species>, <ethnicity>"
 * — so the creature identity lands before any feature (scene-images A). Gender or
 * species supplies the noun; with neither (but some base word), "person" does, so
 * the phrase never dangles. Ethnicity (`identity.heritage`, free text, original
 * casing) is appended after a comma — distinct from the species noun so a "Latina
 * succubus" reads right. Empty when nothing is set.
 */
export function subjectDescriptor(apparentAge?: string, gender?: string, species?: string, heritage?: string): string {
  const words = [apparentAge, gender, species]
    .map((w) => w?.trim().toLowerCase())
    .filter((w): w is string => Boolean(w));
  if (words.length > 0 && !gender?.trim() && !species?.trim()) words.push("person");
  let phrase = words.join(" ");
  const ethnicity = heritage?.trim();
  if (ethnicity) phrase = phrase ? `${phrase}, ${ethnicity}` : ethnicity;
  if (!phrase) return "";
  return `${/^[aeiou]/i.test(phrase) ? "an" : "a"} ${phrase}`;
}

// Trim a trailing period/whitespace off interpolated content so a clause's own
// "." is never doubled when the content already ends in one — free-text colors,
// bios, or species phrases produced "…sharp fangs.." (UX-audit P4).
export function clause(body: string): string {
  return body.replace(/[.\s]+$/, "");
}

/** `Label: value` form (the scene appearance summary still uses this). */
export function formatAttribute(def: AttributeDefinition, value: string | string[] | number | boolean): string {
  if (typeof value === "boolean") return value ? def.label : "";
  const text = formatAttributeValue(def, value);
  return text ? `${def.label}: ${text}` : "";
}

/** Value-only token (no label noun) for the grouped avatar prompt (scene-images C). */
export function formatAttributeValue(def: AttributeDefinition, value: string | string[] | number | boolean): string {
  // "none" is elided unless the definition opts in (contracts/attributes/value.ts) —
  // "piercings: none" plants the very noun the image model then paints anyway.
  const rendered = promptValueWithNoneElided(def, value);
  if (rendered === null) return "";
  if (typeof rendered === "boolean") return rendered ? humanize(def.label).toLowerCase() : "";
  if (typeof rendered === "number") return `${rendered}${def.unit ? ` ${def.unit}` : ""}`;
  return Array.isArray(rendered) ? rendered.map(humanize).join(", ") : humanize(rendered);
}

function humanize(value: string): string {
  return value.replaceAll("_", " ").trim();
}

export function capitalizeFirst(value: string): string {
  return value ? value.charAt(0).toUpperCase() + value.slice(1) : value;
}

export function excerpt(text: string, max: number): string {
  const collapsed = text.trim().replace(/\s+/g, " ");
  return collapsed.length <= max ? collapsed : `${collapsed.slice(0, max).trimEnd()}…`;
}

/**
 * Garment phrasing for image prompts: the item's
 * description is the primary text — it usually restates the name and carries
 * more visual detail — with the bare name as the fallback when there is no
 * description, and the sensory appearance appended in parentheses. Untruncated:
 * clothing detail is authoritative for what the model should paint.
 *
 * Accessory subtypes LEAD the phrase ("nose ring: thin gold hoop") — a bare
 * jewelry name gives the model nothing to place the piece with (face-jewelry
 * plan). Skipped when the text already names the type ("Gold nose ring").
 */
export function formatGarment(item: { name: string; description?: string; appearance?: string; subtypeLabel?: string }): string {
  const base = (item.description?.trim() || item.name).trim();
  const type = item.subtypeLabel?.trim();
  const lead = type && !base.toLowerCase().includes(type) ? `${type}: ${base}` : base;
  const detail = item.appearance?.trim();
  return detail ? `${lead} (${detail})` : lead;
}
