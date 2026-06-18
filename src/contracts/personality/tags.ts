import { z } from "zod";

/**
 * Disposition tags (docs/developer-notes/personality-and-state.spec.md §3/§6):
 * short reusable labels that social-reaction cards key their `reactionOverrides`
 * on (the foot-fetish flip). A **dev-defined canonical registry** → the editor and
 * forge offer these by autocomplete; free-form tags are tolerated but second-class
 * (no autocomplete, no guaranteed card-override match).
 *
 * Cards aren't built yet (social-reaction-cards.plan.md), so in v1 tags are
 * authored, stored, and surfaced for autocomplete only — functionally inert until
 * a card (or the Slice-2 puppet guardrail) reads them. The data model is in place
 * now so neither needs a schema change.
 */
export const dispositionTagSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  description: z.string().default(""),
  /** Loose grouping for editor organization. */
  group: z.enum(["temperament", "social", "intimate"]).catch("temperament"),
});

export type DispositionTag = z.infer<typeof dispositionTagSchema>;

export const dispositionTags: readonly DispositionTag[] = [
  // temperament
  { id: "bratty", label: "Bratty", description: "Petulant, contrary, quick to sulk.", group: "temperament" },
  { id: "hot-tempered", label: "Hot-tempered", description: "Flares fast, slow to cool.", group: "temperament" },
  { id: "stoic", label: "Stoic", description: "Reserved; rarely shows what she feels.", group: "temperament" },
  { id: "gentle", label: "Gentle", description: "Soft-spoken, patient, slow to anger.", group: "temperament" },
  { id: "gloomy", label: "Gloomy", description: "Melancholy default mood.", group: "temperament" },
  { id: "sunny", label: "Sunny", description: "Bright, optimistic default mood.", group: "temperament" },
  // social
  { id: "shy", label: "Shy", description: "Bashful; warms slowly.", group: "social" },
  { id: "flirtatious", label: "Flirtatious", description: "Forward and playful by nature.", group: "social" },
  { id: "aloof", label: "Aloof", description: "Keeps people at a distance.", group: "social" },
  { id: "dominant", label: "Dominant", description: "Likes to lead and set the terms.", group: "social" },
  { id: "submissive", label: "Submissive", description: "Inclined to defer and follow.", group: "social" },
  { id: "jealous", label: "Jealous", description: "Possessive; quick to feel slighted by rivals.", group: "social" },
  { id: "proud", label: "Proud", description: "Guards her dignity; bristles at condescension.", group: "social" },
  // intimate (fenced like intimate attributes where surfaced)
  { id: "praise-receptive", label: "Praise-receptive", description: "Warms readily to compliments.", group: "intimate" },
  { id: "exhibitionist", label: "Exhibitionist", description: "Enjoys public attention and display.", group: "intimate" },
  { id: "prudish", label: "Prudish", description: "Easily scandalized by forwardness.", group: "intimate" },
  { id: "foot-fetish-positive", label: "Foot-fetish positive", description: "Receptive where others would balk.", group: "intimate" },
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
