import { and, eq } from "drizzle-orm";
import { characterProfileSchema, DiagnosticCollector, emptyCharacterProfile, materializeBodyDefaults, withItemsInDefaultOutfit } from "@/contracts";
import { parseOr } from "@/lib/parse";
import { characters, db } from "@/server/db";
import { materializeSuggestedItems, prepareSuggestedItemEmbeddings, queueEmbedRefresh } from "./library";
import type { CharacterPatchBody } from "./schemas";

/** Lock, compare, materialize, and update on one transaction. A stale writer
 * creates no items; response versions advance even for writes within one millisecond. */
export async function patchOwnedCharacter(characterId: string, ownerId: string, body: CharacterPatchBody) {
  const newItems: string[] = [];
  // Refuse an already-stale/non-owned request before paying for embeddings.
  // This read is only a fast path: the locked read below repeats both checks
  // because the row may change while provider work is in flight.
  if (body.expectedUpdatedAt !== undefined) {
    const [snapshot] = await db().select().from(characters)
      .where(and(eq(characters.id, characterId), eq(characters.ownerId, ownerId)));
    if (!snapshot) return { status: "not_found" as const };
    if (body.expectedUpdatedAt !== snapshot.updatedAt.toISOString()) {
      return { status: "conflict" as const, character: snapshot };
    }
  }
  // Provider latency must never extend the character row lock. The transaction
  // below still rechecks exact and fuzzy candidates against its current rows.
  const sink = new DiagnosticCollector();
  const preparedEmbeddings = await prepareSuggestedItemEmbeddings(body.suggestedItems);
  const outcome = await db().transaction(async (tx) => {
    const [existing] = await tx.select().from(characters)
      .where(and(eq(characters.id, characterId), eq(characters.ownerId, ownerId))).for("update");
    if (!existing) return { status: "not_found" as const };
    if (body.expectedUpdatedAt !== undefined && body.expectedUpdatedAt !== existing.updatedAt.toISOString()) return { status: "conflict" as const, character: existing };
    const materialized = await materializeSuggestedItems(ownerId, body.suggestedItems, sink, {
      executor: tx,
      preparedEmbeddings,
      onCreated: (id) => newItems.push(id),
    });
    const suggestedIds = materialized.ids;
    const update: Partial<typeof characters.$inferInsert> = {};
    if (body.name !== undefined) update.name = body.name;
    if (body.tags !== undefined) update.tags = body.tags;
    if (body.visibility !== undefined) update.visibility = body.visibility;
    if (body.chatModel !== undefined) update.chatModel = body.chatModel;
    if (body.profile !== undefined || suggestedIds.length > 0) {
      const current = parseOr(characterProfileSchema, existing.profile, emptyCharacterProfile(), undefined, "characters.profile");
      const merged = withItemsInDefaultOutfit({ ...current, ...body.profile }, suggestedIds);
      update.profile = { ...merged, attributes: materializeBodyDefaults(merged.attributes, merged) };
    }
    if (!Object.keys(update).length) return { status: "saved" as const, character: existing, diagnostics: sink.items, materializedSuggestions: materialized.materializedSuggestions, changed: false };
    update.updatedAt = new Date(Math.max(Date.now(), existing.updatedAt.getTime() + 1));
    const [row] = await tx.update(characters).set(update)
      .where(and(eq(characters.id, characterId), eq(characters.ownerId, ownerId))).returning();
    // The row is held by this transaction; deletion cannot pass the lock.
    return { status: "saved" as const, character: row ?? existing, diagnostics: sink.items, materializedSuggestions: materialized.materializedSuggestions, changed: true };
  });
  if (outcome.status === "saved") {
    for (const id of newItems) queueEmbedRefresh("item", id);
    if (outcome.changed) queueEmbedRefresh("character", characterId);
  }
  return outcome;
}
