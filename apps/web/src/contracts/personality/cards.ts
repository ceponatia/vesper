import { z } from "zod";
import { interactionConceptById } from "./interactions";
import type { PreferenceValence } from "./preference";
import { normalizeTag } from "./tags";

/**
 * Social-reaction cards: importable taboo / social-rule content, reusable across worlds
 * and attachable to characters, that resolves a classified social act to a
 * {@link SocialReaction} the response curve then scales (reactions.ts). Pure: no IO,
 * no engine imports.
 *
 * A card does **not** carry a raw affinity/mood delta (the companion-app shape). It sets a
 * single `severity` (0–100) → a tier → a base `intensity` via a fixed ramp; the curve
 * (affinity + mood + trait scale, clamped at the merge) does the rest. One curve, one
 * source of truth, shared with bespoke preferences.
 */

export const TIERS = ["odd", "disapproval", "shunning", "ostracized"] as const;
export const tierSchema = z.enum(TIERS);
export type Tier = z.infer<typeof tierSchema>;

/**
 * The qualitative shape of a card reaction. Kept for authoring richness + the EmotionLabel
 * beat; the curve consumes only the derived `valence`. `indifferent` ⇒ no reaction (null).
 */
export const reactionKindSchema = z.enum([
  "revulsion",
  "disapproval",
  "shunning",
  "fear",
  "accepting",
  "enjoy",
  "kindred_spirit",
  "indifferent",
]);
export type ReactionKind = z.infer<typeof reactionKindSchema>;

/**
 * What a card yields for a tier (or a tag override). `intensity` is optional — absent ⇒ the
 * tier's ramped base intensity (`tierIntensity`). `hint` overrides the concept's default
 * narrator flavour.
 */
export const cardReactionSchema = z.object({
  kind: reactionKindSchema.catch("disapproval"),
  intensity: z.number().min(1).max(10).optional(),
  hint: z.string().default(""),
});
export type CardReaction = z.infer<typeof cardReactionSchema>;

/**
 * A per-tag override (the foot-fetish flip): a character carrying `tag` reacts with
 * `toReaction` instead of the card default — e.g. a `foot-fetish` taboo defaults to
 * revulsion, but `foot-fetish-positive` flips it to `enjoy`. `tag` may be canonical
 * or free-form; matching is `normalizeTag`-insensitive (case/spacing/underscores).
 */
export const reactionOverrideSchema = z.object({
  tag: z.string().min(1),
  toReaction: cardReactionSchema,
});
export type ReactionOverride = z.infer<typeof reactionOverrideSchema>;

/**
 * The self-contained card shape stored inline on a world (`style.socialCards`) and on a
 * character (`profile.socialCards`) as snapshot copies, and composed from a `social_cards`
 * library row. Immutable during play.
 */
export const socialReactionCardSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  description: z.string().default(""),
  /** Authoring/UX bucket; mechanics unified by severity. */
  kind: z.enum(["social_rule", "taboo"]).catch("social_rule"),
  /** Interaction concept ids that trigger this card (NOT free keywords). */
  triggers: z.array(z.string()).readonly().default([]),
  /** 0–100 → tier via {@link severityToTier}. */
  severity: z.number().min(0).max(100).catch(40),
  /** Tier-default reaction; absent ⇒ derived from the tier (`tierDefaultKind` + the ramp). */
  defaultReaction: cardReactionSchema.optional(),
  /** Per-tag flips (most specific; beat the default). */
  reactionOverrides: z.array(reactionOverrideSchema).readonly().default([]),
});
export type SocialReactionCard = z.infer<typeof socialReactionCardSchema>;

/**
 * The mechanical slice of a card — everything except the row-level `id`/`label`/`description`.
 * This is what a `social_cards` library row stores in its `definition` column and what the card
 * builder edits; the inline snapshot recomposes the full card from it + the row's
 * id/name/description (server/api re-exports this as `socialCardExtrasSchema`).
 */
export const socialReactionCardExtrasSchema = socialReactionCardSchema.pick({
  kind: true,
  triggers: true,
  severity: true,
  defaultReaction: true,
  reactionOverrides: true,
});
export type SocialReactionCardExtras = z.infer<typeof socialReactionCardExtrasSchema>;

/**
 * Recompose a full inline {@link SocialReactionCard} from a `social_cards` library row's parts:
 * the row's `id`→a fresh inline id (passed in — contracts mints none), `name`→`label`,
 * `description`, and the `definition` extras. The copy-at-every-layer snapshot the world editor /
 * character Personality tab append when importing a library card.
 */
export function cardFromLibraryParts(
  newCardId: string,
  name: string,
  description: string,
  extras: SocialReactionCardExtras,
): SocialReactionCard {
  return { id: newCardId, label: name, description, ...extras };
}

// ---------------------------------------------------------------------------
// Pure helpers — severity → tier → intensity, kind → valence.
// ---------------------------------------------------------------------------

/** Companion-app thresholds (26/51/76). Tunable in playtest (plan Open questions). */
export function severityToTier(severity: number): Tier {
  if (severity >= 76) return "ostracized";
  if (severity >= 51) return "shunning";
  if (severity >= 26) return "disapproval";
  return "odd";
}

/** Fixed tier → base intensity ramp (decided 2026-06-25): one severity number per card. */
const TIER_INTENSITY: Record<Tier, number> = { odd: 2, disapproval: 5, shunning: 8, ostracized: 10 };
export function tierIntensity(tier: Tier): number {
  return TIER_INTENSITY[tier];
}

/** The reaction kind a card defaults to at a tier when it authors none. */
const TIER_DEFAULT_KIND: Record<Tier, ReactionKind> = {
  odd: "disapproval",
  disapproval: "disapproval",
  shunning: "shunning",
  ostracized: "revulsion",
};
export function tierDefaultKind(tier: Tier): ReactionKind {
  return TIER_DEFAULT_KIND[tier];
}

/** Map a reaction kind to a curve valence; `indifferent` ⇒ null (no reaction). */
export function reactionKindToValence(kind: ReactionKind): PreferenceValence | null {
  switch (kind) {
    case "revulsion":
    case "disapproval":
    case "shunning":
    case "fear":
      return "dislike";
    case "accepting":
    case "enjoy":
    case "kindred_spirit":
      return "like";
    case "indifferent":
      return null;
  }
}

// ---------------------------------------------------------------------------
// Resolution — a card (or an ordered card set) → a pre-curve reaction.
// ---------------------------------------------------------------------------

/** A card resolved against a character's tags, before the response curve. */
export interface ResolvedCardReaction {
  conceptId: string;
  cardId: string;
  valence: PreferenceValence;
  intensity: number;
  hint: string;
  kind: ReactionKind;
}

/**
 * Resolve a single card for a tag set: a tag override (first match) beats the card default,
 * which beats the tier-derived default. `indifferent` ⇒ null (the character genuinely doesn't
 * mind — a real, winning verdict, not a fall-through). Override tags match through
 * `normalizeTag` on both sides, so a free-form character tag ("Foot Fetish Positive") still
 * hits an override keyed `foot-fetish-positive`.
 */
export function resolveCardForTags(card: SocialReactionCard, conceptId: string, tags: readonly string[]): ResolvedCardReaction | null {
  const tier = severityToTier(card.severity);
  const override = card.reactionOverrides.find((o) => {
    const target = normalizeTag(o.tag);
    return target !== "" && tags.some((t) => normalizeTag(t) === target);
  });
  const reaction: CardReaction = override?.toReaction ?? card.defaultReaction ?? { kind: tierDefaultKind(tier), hint: "" };
  const valence = reactionKindToValence(reaction.kind);
  if (!valence) return null;
  const intensity = reaction.intensity ?? tierIntensity(tier);
  const hint = reaction.hint || interactionConceptById(conceptId)?.defaultHint || "";
  return { conceptId, cardId: card.id, valence, intensity, hint, kind: reaction.kind };
}

/**
 * Resolve a classified concept against an ordered card set. The first card whose `triggers`
 * include the concept **governs outright** (pure override — character cards listed before
 * world cards win; an `indifferent` first match ⇒ no reaction). Returns null when no card
 * triggers on the concept.
 */
export function resolveCardReaction(conceptId: string, tags: readonly string[], cards: readonly SocialReactionCard[]): ResolvedCardReaction | null {
  for (const card of cards) {
    if (card.triggers.includes(conceptId)) return resolveCardForTags(card, conceptId, tags);
  }
  return null;
}

/** Find the card a given id refers to within a set (for the witnessed-breach path). */
export function findCardById(cardId: string, cards: readonly SocialReactionCard[]): SocialReactionCard | undefined {
  return cards.find((c) => c.id === cardId);
}
