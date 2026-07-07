import { z } from "zod";
import {
  clampFamiliarity,
  clampRegard,
  familiarityBandIdSchema,
  familiarityBandMidpoint,
  regardBandIdSchema,
  regardBandMidpoint,
} from "./bands";

/**
 * The directed relationship record (relationship-model.plan.md): ONE shape for
 * every edge — character→player (on `character_chat_state`), character→character
 * (the per-conversation matrix), library defaults (the character editor's
 * Relationships tab), and later the sessions lane. Directed from day one:
 * "A loves B, B secretly resents A" is a data state, never a schema change.
 *
 * Two forms:
 * - **live** (`relationshipRecordSchema`): both axes as scalars — what state
 *   rows store and dynamics move.
 * - **authored** (`authoredRelationshipRecordSchema`): both axes as band picks —
 *   what authoring surfaces write; `authoredRecordToLive` seeds the scalars at
 *   band midpoints (the `stageMidpoint` pattern).
 *
 * Every field self-heals (`.catch`) — a malformed stored record degrades to the
 * neutral default, never a failed parse (docs/resilience.md).
 */

/** The label both parties would use for the relationship. */
export const RELATIONSHIP_KIND_MAX = 80;
/** One line of shared past. */
export const RELATIONSHIP_HISTORY_TEXT_MAX = 280;
/** Optional flavor on the mask ("icily civil", "syrupy-sweet in public"). */
export const PRESENTED_NOTE_MAX = 160;

/**
 * The mask, when how they PERFORM the relationship differs from what they feel
 * (owner ruling 2026-07-07: enum first). `masks_warmth` performs colder than
 * felt (tsundere); `masks_dislike` performs warmer than felt (the professional
 * mask). No mask = honest, the overwhelming default.
 */
export const presentedLeans = ["masks_warmth", "masks_dislike"] as const;
export type PresentedLean = (typeof presentedLeans)[number];

export const presentedMaskSchema = z.object({
  lean: z.enum(presentedLeans),
  note: z.string().max(PRESENTED_NOTE_MAX).catch("").default(""),
});
export type PresentedMask = z.infer<typeof presentedMaskSchema>;

const textureFields = {
  kind: z.string().max(RELATIONSHIP_KIND_MAX).catch("").default(""),
  history: z.string().max(RELATIONSHIP_HISTORY_TEXT_MAX).catch("").default(""),
  /** Absent ⇒ honest. `.catch(undefined)` heals a malformed mask to honest, not a failed record. */
  presented: presentedMaskSchema.optional().catch(undefined),
  /**
   * Looming (owner ruling 2026-07-07): this absent person weighs on the
   * character's thoughts unprompted — the edge rides in the prompt even
   * unmentioned, still under the don't-teleport guard.
   */
  looming: z.boolean().catch(false).default(false),
  // attraction — reserved third axis; a field addition here, never a migration.
};

/**
 * The texture half of the record on its own — what state rows store in their
 * `relationship_record` jsonb beside the two scalar columns (the scalars are
 * columns because dynamics move and queries read them).
 */
export const relationshipTextureSchema = z.object(textureFields);
export type RelationshipTexture = z.infer<typeof relationshipTextureSchema>;

export function emptyRelationshipTexture(): RelationshipTexture {
  return relationshipTextureSchema.parse({});
}

/** Live form: axis scalars. Stored on state rows / matrix rows; dynamics move these. */
export const relationshipRecordSchema = z.object({
  familiarity: z.number().catch(0).default(0),
  regard: z.number().catch(0).default(0),
  ...textureFields,
});
export type RelationshipRecord = z.infer<typeof relationshipRecordSchema>;

/** Authored form: band picks. What the Relationships tab / matrix menu / scenario seeds write. */
export const authoredRelationshipRecordSchema = z.object({
  familiarity: familiarityBandIdSchema.default("strangers"),
  regard: regardBandIdSchema.default("neutral"),
  ...textureFields,
});
export type AuthoredRelationshipRecord = z.infer<typeof authoredRelationshipRecordSchema>;

export function emptyRelationshipRecord(): RelationshipRecord {
  return relationshipRecordSchema.parse({});
}

/** Seed the live scalars from an authored band pick (band midpoints, texture carried through). */
export function authoredRecordToLive(authored: AuthoredRelationshipRecord): RelationshipRecord {
  return {
    familiarity: clampFamiliarity(familiarityBandMidpoint(authored.familiarity)),
    regard: clampRegard(regardBandMidpoint(authored.regard)),
    kind: authored.kind,
    history: authored.history,
    presented: authored.presented,
    looming: authored.looming,
  };
}
