import { and, eq, inArray } from "drizzle-orm";
import {
  authoredRecordToLive,
  authoredRelationshipRecordSchema,
  relationshipRecordSchema,
  type RelationshipRecord,
} from "@/contracts";
import { parseOr } from "@/lib/parse";
import type { DiagnosticSink } from "@/contracts/diagnostics";
import { characterChatRelationships, characterRelationships, db } from "../db";

/**
 * The per-conversation relationship matrix (relationship-model.plan.md §The
 * matrix): directed NPC↔NPC records, seeded from the library defaults at
 * creation/join and authored per conversation on top. Static texture in v2 —
 * no pulse, no ratchet; lived shifts reach the narrator through archivist
 * relationship facts. The character→player edge stays on character_chat_state.
 */

export interface ChatRelationshipEdge {
  fromCharacterId: string;
  toCharacterId: string;
  record: RelationshipRecord;
}

/**
 * Seed matrix rows from the library defaults for every directed pair in the
 * given roster (both directions), keeping any row that already exists — a
 * per-conversation edit is never clobbered by re-seeding (the add-participant
 * route re-runs this with the grown roster).
 */
export async function seedChatRelationships(chatId: string, characterIds: readonly string[]): Promise<void> {
  const ids = [...new Set(characterIds)];
  if (ids.length < 2) return;
  const defaults = await db()
    .select({
      fromCharacterId: characterRelationships.fromCharacterId,
      toCharacterId: characterRelationships.toCharacterId,
      record: characterRelationships.record,
    })
    .from(characterRelationships)
    .where(and(inArray(characterRelationships.fromCharacterId, ids), inArray(characterRelationships.toCharacterId, ids)));
  if (!defaults.length) return;
  await db()
    .insert(characterChatRelationships)
    .values(
      defaults.map((row) => ({
        chatId,
        fromCharacterId: row.fromCharacterId,
        toCharacterId: row.toCharacterId,
        record: authoredRecordToLive(
          parseOr(authoredRelationshipRecordSchema, row.record, authoredRelationshipRecordSchema.parse({}), undefined, "character_relationships.record"),
        ),
      })),
    )
    .onConflictDoNothing();
}

/** Every directed edge stored for this conversation, records parsed at the boundary. */
export async function loadChatRelationships(chatId: string, sink?: DiagnosticSink): Promise<ChatRelationshipEdge[]> {
  const rows = await db()
    .select({
      fromCharacterId: characterChatRelationships.fromCharacterId,
      toCharacterId: characterChatRelationships.toCharacterId,
      record: characterChatRelationships.record,
    })
    .from(characterChatRelationships)
    .where(eq(characterChatRelationships.chatId, chatId));
  return rows.map((row) => ({
    fromCharacterId: row.fromCharacterId,
    toCharacterId: row.toCharacterId,
    record: parseOr(relationshipRecordSchema, row.record, relationshipRecordSchema.parse({}), sink, "character_chat_relationships.record"),
  }));
}

/** Upsert one directed edge (the matrix menu's write path). */
export async function upsertChatRelationship(
  chatId: string,
  fromCharacterId: string,
  toCharacterId: string,
  record: RelationshipRecord,
): Promise<void> {
  await db()
    .insert(characterChatRelationships)
    .values({ chatId, fromCharacterId, toCharacterId, record, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: [
        characterChatRelationships.chatId,
        characterChatRelationships.fromCharacterId,
        characterChatRelationships.toCharacterId,
      ],
      set: { record, updatedAt: new Date() },
    });
}
