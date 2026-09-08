import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import {
  diagnosticSchema,
  materializeBodyDefaults,
  seedBodyConfigFromAttributes,
  seedRegistryDefaultValues,
  withItemsInDefaultOutfit,
  DiagnosticCollector,
} from "@/contracts";
import { characterCreationRequests, characters, db } from "@/server/db";
import {
  materializeSuggestedItems,
  prepareSuggestedItemEmbeddings,
  queueEmbedRefresh,
} from "./library";
import type { CharacterCreateBody } from "./schemas";

const materializedSuggestionSchema = z.object({
  index: z.number().int().nonnegative(),
  itemId: z.string(),
});

/** Runtime guard for the JSONB replay seam. The character row is intentionally
 * opaque here: it was produced by this route and the client owns its detailed
 * projection, while this guard proves the receipt envelope itself is intact. */
const characterCreationResponseSchema = z.object({
  character: z.object({ id: z.string() }).passthrough(),
  diagnostics: z.array(diagnosticSchema),
  materializedSuggestions: z.array(materializedSuggestionSchema),
});
type CharacterCreationRecoveryCharacter = Pick<
  typeof characters.$inferSelect,
  "id" | "name" | "profile" | "tags" | "avatarImageId" | "updatedAt" | "visibility" | "chatModel"
>;
const creationRecoveryColumns = {
  id: characters.id,
  name: characters.name,
  profile: characters.profile,
  tags: characters.tags,
  avatarImageId: characters.avatarImageId,
  updatedAt: characters.updatedAt,
  visibility: characters.visibility,
  chatModel: characters.chatModel,
};

export type CharacterCreationOutcome =
  | { status: "created" | "replayed"; response: z.infer<typeof characterCreationResponseSchema>; httpStatus: number }
  | {
      status: "idempotency_mismatch";
      recovery?: {
        created: z.infer<typeof characterCreationResponseSchema>;
        character: CharacterCreationRecoveryCharacter;
      };
    }
  | { status: "replay_invalid" }
  | { status: "create_failed" };

function payloadHash(body: CharacterCreateBody): string {
  const payload = { ...body, creationRequestId: undefined };
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function profileForCreate(body: CharacterCreateBody, suggestedIds: readonly string[]) {
  // A truly blank profile (the library's New button) is born with the curated
  // registry defaults + the body-config those imply (gender=female seeds
  // vulva/breasts). Authored forge/API attributes pass through untouched.
  const blank = body.profile.attributes.length === 0;
  const seeded = blank ? seedRegistryDefaultValues(body.profile.attributes) : body.profile.attributes;
  const seededConfig = blank ? seedBodyConfigFromAttributes(seeded) : null;
  const attributes = materializeBodyDefaults(seeded, {
    speciesId: body.profile.speciesId,
    heritageId: body.profile.heritageId,
    bodyPlanId: body.profile.bodyPlanId,
    intimateRegions: seededConfig?.intimateRegions ?? body.profile.intimateRegions,
    bodyFeatures: seededConfig?.bodyFeatures ?? body.profile.bodyFeatures,
  });
  return withItemsInDefaultOutfit(
    {
      ...body.profile,
      attributes,
      ...(seededConfig
        ? { intimateRegions: seededConfig.intimateRegions, bodyFeatures: seededConfig.bodyFeatures }
        : {}),
    },
    suggestedIds,
  );
}

function parseReplay(response: unknown, characterId: string): z.infer<typeof characterCreationResponseSchema> | null {
  const parsed = characterCreationResponseSchema.safeParse(response);
  return parsed.success && parsed.data.character.id === characterId ? parsed.data : null;
}

/**
 * Create one character and its suggested library items atomically. When the
 * caller supplies the durable draft UUID, the owner-scoped receipt commits in
 * that same transaction and a lost-response retry replays it verbatim.
 */
export async function createOwnedCharacter(ownerId: string, body: CharacterCreateBody): Promise<CharacterCreationOutcome> {
  const requestId = body.creationRequestId;
  const hash = payloadHash(body);

  // The common lost-response retry avoids both provider spend and a write
  // transaction. The locked read below remains authoritative for first-call
  // races.
  if (requestId) {
    const [existing] = await db()
      .select({
        payloadHash: characterCreationRequests.payloadHash,
        response: characterCreationRequests.response,
        httpStatus: characterCreationRequests.httpStatus,
        characterId: characterCreationRequests.characterId,
      })
      .from(characterCreationRequests)
      .where(and(eq(characterCreationRequests.ownerId, ownerId), eq(characterCreationRequests.requestId, requestId)))
      .limit(1);
    if (existing) {
      if (existing.payloadHash === hash) {
        if (existing.httpStatus !== 201) return { status: "replay_invalid" };
        const response = parseReplay(existing.response, existing.characterId);
        return response
          ? { status: "replayed", response, httpStatus: existing.httpStatus }
          : { status: "replay_invalid" };
      }
      const created = existing.httpStatus === 201 ? parseReplay(existing.response, existing.characterId) : null;
      const [character] = await db().select(creationRecoveryColumns).from(characters)
        .where(and(eq(characters.id, existing.characterId), eq(characters.ownerId, ownerId)))
        .limit(1);
      return created && character
        ? { status: "idempotency_mismatch", recovery: { created, character } }
        : { status: "idempotency_mismatch" };
    }
  }

  // One batched provider call, completed before any character/request lock.
  const preparedEmbeddings = await prepareSuggestedItemEmbeddings(body.suggestedItems);
  const newItemIds: string[] = [];
  let createdCharacterId: string | null = null;

  const outcome = await db().transaction(async (tx): Promise<CharacterCreationOutcome> => {
    if (requestId) {
      // Serializes only the same owner's same creation intent. The table's
      // primary key is still the correctness constraint; this lock lets us
      // avoid nullable/in-progress receipt rows.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`character_create:${ownerId}:${requestId}`}))`);
      const [existing] = await tx
        .select({
          payloadHash: characterCreationRequests.payloadHash,
          response: characterCreationRequests.response,
          httpStatus: characterCreationRequests.httpStatus,
          characterId: characterCreationRequests.characterId,
        })
        .from(characterCreationRequests)
        .where(and(eq(characterCreationRequests.ownerId, ownerId), eq(characterCreationRequests.requestId, requestId)))
        .for("update");
      if (existing) {
        if (existing.payloadHash !== hash) {
          const created = existing.httpStatus === 201 ? parseReplay(existing.response, existing.characterId) : null;
          const [character] = await tx.select(creationRecoveryColumns).from(characters)
            .where(and(eq(characters.id, existing.characterId), eq(characters.ownerId, ownerId)))
            .limit(1);
          return created && character
            ? { status: "idempotency_mismatch", recovery: { created, character } }
            : { status: "idempotency_mismatch" };
        }
        if (existing.httpStatus !== 201) return { status: "replay_invalid" };
        const response = parseReplay(existing.response, existing.characterId);
        return response
          ? { status: "replayed", response, httpStatus: existing.httpStatus }
          : { status: "replay_invalid" };
      }
    }

    const sink = new DiagnosticCollector();
    const materialized = await materializeSuggestedItems(ownerId, body.suggestedItems, sink, {
      executor: tx,
      preparedEmbeddings,
      onCreated: (id) => newItemIds.push(id),
    });
    const [row] = await tx
      .insert(characters)
      .values({
        ownerId,
        name: body.name,
        profile: profileForCreate(body, materialized.ids),
        tags: body.tags,
      })
      .returning();
    if (!row) return { status: "create_failed" };
    createdCharacterId = row.id;

    const response = {
      character: row,
      diagnostics: sink.items,
      materializedSuggestions: materialized.materializedSuggestions,
    };
    if (requestId) {
      await tx.insert(characterCreationRequests).values({
        ownerId,
        requestId,
        payloadHash: hash,
        characterId: row.id,
        response,
        httpStatus: 201,
      });
    }
    return { status: "created", response, httpStatus: 201 };
  });

  if (outcome.status === "created") {
    for (const id of newItemIds) queueEmbedRefresh("item", id);
    if (createdCharacterId) queueEmbedRefresh("character", createdCharacterId);
  }
  return outcome;
}
