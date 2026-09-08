import { and, asc, eq, inArray } from "drizzle-orm";
import { authoredRelationshipRecordSchema, type AuthoredRelationshipRecord } from "@/contracts";
import { parseOr } from "@/lib/parse";
import {
  characterRelationships,
  characterRelationshipVersions,
  characters,
  db,
} from "@/server/db";

export interface LibraryRelationshipEdge {
  toCharacterId: string;
  toName: string;
  record: AuthoredRelationshipRecord;
}

export interface LibraryRelationshipSet {
  revision: number;
  edges: LibraryRelationshipEdge[];
}

export type SaveLibraryRelationshipsResult =
  | { ok: true; value: LibraryRelationshipSet }
  | { ok: false; code: "not_found" | "target_not_found" | "invalid_edge" }
  | { ok: false; code: "relationship_conflict"; current: LibraryRelationshipSet };

type RelationshipTransaction = Parameters<Parameters<ReturnType<typeof db>["transaction"]>[0]>[0];
type RelationshipExecutor = ReturnType<typeof db> | RelationshipTransaction;

async function readRelationshipSet(
  executor: RelationshipExecutor,
  characterId: string,
): Promise<LibraryRelationshipSet> {
  const version = await executor
    .select({ revision: characterRelationshipVersions.revision })
    .from(characterRelationshipVersions)
    .where(eq(characterRelationshipVersions.characterId, characterId))
    .limit(1);
  const rows = await executor
    .select({
      toCharacterId: characterRelationships.toCharacterId,
      toName: characters.name,
      record: characterRelationships.record,
    })
    .from(characterRelationships)
    .innerJoin(characters, eq(characters.id, characterRelationships.toCharacterId))
    .where(eq(characterRelationships.fromCharacterId, characterId));
  return {
    revision: version[0]?.revision ?? 0,
    edges: rows.map((row) => ({
      toCharacterId: row.toCharacterId,
      toName: row.toName,
      record: parseOr(
        authoredRelationshipRecordSchema,
        row.record,
        authoredRelationshipRecordSchema.parse({}),
        undefined,
        "character_relationships.record",
      ),
    })),
  };
}

export async function getLibraryRelationships(
  ownerId: string,
  characterId: string,
): Promise<LibraryRelationshipSet | null> {
  return db().transaction(
    async (tx) => {
      const [owned] = await tx
        .select({ id: characters.id })
        .from(characters)
        .where(and(eq(characters.id, characterId), eq(characters.ownerId, ownerId)))
        .limit(1);
      if (!owned) return null;
      return readRelationshipSet(tx, characterId);
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}

/**
 * Claim `baseRevision + 1` and replace every outgoing edge in one transaction.
 * The version row exists independently from the edge rows so empty sets still
 * advance and two writers that read the same version cannot both succeed.
 */
export async function saveLibraryRelationships(
  ownerId: string,
  characterId: string,
  baseRevision: number,
  edges: { toCharacterId: string; record: AuthoredRelationshipRecord }[],
): Promise<SaveLibraryRelationshipsResult> {
  return db().transaction(async (tx): Promise<SaveLibraryRelationshipsResult> => {
    const targetIds = edges.map((edge) => edge.toCharacterId);
    if (targetIds.some((targetId) => targetId === characterId) || new Set(targetIds).size !== targetIds.length) {
      return { ok: false, code: "invalid_edge" };
    }
    // Lock every referenced character in stable order. KEY SHARE prevents a
    // target deletion between validation and insertion while inverse A→B / B→A
    // saves can still validate each other's source rows.
    const referenced = await tx
      .select({ id: characters.id })
      .from(characters)
      .where(and(inArray(characters.id, [characterId, ...targetIds]), eq(characters.ownerId, ownerId)))
      .orderBy(asc(characters.id))
      .for("key share");
    const referencedIds = new Set(referenced.map((row) => row.id));
    if (!referencedIds.has(characterId)) return { ok: false, code: "not_found" };
    if (targetIds.some((targetId) => !referencedIds.has(targetId))) return { ok: false, code: "target_not_found" };

    await tx
      .insert(characterRelationshipVersions)
      .values({ characterId, revision: 0 })
      .onConflictDoNothing({ target: characterRelationshipVersions.characterId });
    const [claim] = await tx
      .update(characterRelationshipVersions)
      .set({ revision: baseRevision + 1, updatedAt: new Date() })
      .where(and(
        eq(characterRelationshipVersions.characterId, characterId),
        eq(characterRelationshipVersions.revision, baseRevision),
      ))
      .returning({ revision: characterRelationshipVersions.revision });
    if (!claim) {
      // A shared lock on the winner's version keeps its revision and edge set
      // together while the conflict response is assembled.
      await tx
        .select({ revision: characterRelationshipVersions.revision })
        .from(characterRelationshipVersions)
        .where(eq(characterRelationshipVersions.characterId, characterId))
        .for("share");
      return { ok: false, code: "relationship_conflict", current: await readRelationshipSet(tx, characterId) };
    }

    await tx.delete(characterRelationships).where(eq(characterRelationships.fromCharacterId, characterId));
    if (edges.length) {
      await tx.insert(characterRelationships).values(edges.map((edge) => ({
        fromCharacterId: characterId,
        toCharacterId: edge.toCharacterId,
        record: edge.record,
        updatedAt: new Date(),
      })));
    }
    return { ok: true, value: await readRelationshipSet(tx, characterId) };
  });
}
