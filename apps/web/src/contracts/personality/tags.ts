import { z } from "zod";

/**
 * Disposition tags: short reusable labels that social-reaction cards key their
 * `reactionOverrides` on (the foot-fetish flip). A **dev-defined canonical
 * registry** → the editor and forge offer these by autocomplete; free-form tags
 * are tolerated but second-class (no autocomplete, no guaranteed card-override
 * match).
 *
 * Cards aren't built yet, so in v1 tags are
 * authored, stored, and surfaced for autocomplete only — functionally inert until
 * a card (or the puppet guardrail) reads them. The data model is in place
 * now so neither needs a schema change.
 */
export const dispositionTagSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  description: z.string().default(""),
  /** Loose grouping for editor organization. */
  group: z.enum(["temperament", "social", "intimate"]).catch("temperament"),
  /**
   * Coarse affective lean — the first slice of machine-readable "what this tag
   * means", read by the puppet guardrail: a `warm` puppeted act onto a `cold`
   * character (or a `hostile` act
   * onto a `warm` one) is out of character. `neutral` ⇒ no warmth-based clash.
   */
  warmth: z.enum(["cold", "neutral", "warm"]).catch("neutral").default("neutral"),
  /**
   * Interaction-concept *family* ids this character would not spontaneously
   * initiate (e.g. an aloof character won't initiate `affection_display`). A
   * puppeted behaviour in one of these families is a contradiction regardless of
   * warmth. Each entry must be a valid concept family (interactions.ts).
   */
  wontInitiate: z.array(z.string()).readonly().default([]),
});

export type DispositionTag = z.infer<typeof dispositionTagSchema>;

export const dispositionTags: readonly DispositionTag[] = [
  // temperament
  { id: "bratty", label: "Bratty", description: "Petulant, contrary, quick to sulk.", group: "temperament", warmth: "cold", wontInitiate: ["affection_display", "support"] },
  { id: "hot-tempered", label: "Hot-tempered", description: "Flares fast, slow to cool.", group: "temperament", warmth: "neutral", wontInitiate: ["support"] },
  { id: "stoic", label: "Stoic", description: "Reserved; rarely shows what she feels.", group: "temperament", warmth: "cold", wontInitiate: ["affection_display"] },
  { id: "gentle", label: "Gentle", description: "Soft-spoken, patient, slow to anger.", group: "temperament", warmth: "warm", wontInitiate: ["aggression"] },
  { id: "gloomy", label: "Gloomy", description: "Melancholy default mood.", group: "temperament", warmth: "cold", wontInitiate: [] },
  { id: "sunny", label: "Sunny", description: "Bright, optimistic default mood.", group: "temperament", warmth: "warm", wontInitiate: ["aggression"] },
  // social
  { id: "shy", label: "Shy", description: "Bashful; warms slowly.", group: "social", warmth: "neutral", wontInitiate: ["courtship"] },
  { id: "flirtatious", label: "Flirtatious", description: "Forward and playful by nature.", group: "social", warmth: "warm", wontInitiate: [] },
  { id: "aloof", label: "Aloof", description: "Keeps people at a distance.", group: "social", warmth: "cold", wontInitiate: ["affection_display", "courtship"] },
  { id: "dominant", label: "Dominant", description: "Likes to lead and set the terms.", group: "social", warmth: "neutral", wontInitiate: [] },
  { id: "submissive", label: "Submissive", description: "Inclined to defer and follow.", group: "social", warmth: "neutral", wontInitiate: ["aggression"] },
  { id: "jealous", label: "Jealous", description: "Possessive; quick to feel slighted by rivals.", group: "social", warmth: "neutral", wontInitiate: [] },
  { id: "proud", label: "Proud", description: "Guards her dignity; bristles at condescension.", group: "social", warmth: "neutral", wontInitiate: [] },
  // intimate (fenced like intimate attributes where surfaced)
  { id: "praise-receptive", label: "Praise-receptive", description: "Warms readily to compliments.", group: "intimate", warmth: "warm", wontInitiate: [] },
  { id: "exhibitionist", label: "Exhibitionist", description: "Enjoys public attention and display.", group: "intimate", warmth: "warm", wontInitiate: [] },
  { id: "prudish", label: "Prudish", description: "Easily scandalized by forwardness.", group: "intimate", warmth: "cold", wontInitiate: ["courtship", "intimate"] },
  { id: "foot-fetish-positive", label: "Foot-fetish positive", description: "Receptive where others would balk.", group: "intimate", warmth: "neutral", wontInitiate: [] },
];

const tagById = new Map(dispositionTags.map((t) => [t.id, t]));

export function dispositionTagById(id: string): DispositionTag | undefined {
  return tagById.get(id);
}

export function dispositionTagIds(): string[] {
  return dispositionTags.map((t) => t.id);
}

/** Lowercase, trim, collapse spaces/underscores to hyphens, strip the rest. */
export function normalizeTag(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

/** The canonical tag id a free-form string resolves to, or undefined if none. */
export function canonicalTagId(raw: string): string | undefined {
  const normalized = normalizeTag(raw);
  return tagById.has(normalized) ? normalized : undefined;
}
