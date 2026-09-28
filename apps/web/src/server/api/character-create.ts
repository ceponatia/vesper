import {
  materializeBodyDefaults,
  seedBodyConfigFromAttributes,
  seedRegistryDefaultValues,
  withItemsInDefaultOutfit,
  DiagnosticCollector,
  type CharacterProfile,
  type Diagnostic,
} from "@/contracts";
import { characters, db } from "@/server/db";
import {
  materializeSuggestedItems,
  prepareSuggestedItemEmbeddings,
  queueEmbedRefresh,
  type MaterializedSuggestion,
} from "./library";
import { characterCreateSchema, type CharacterCreateBody } from "./schemas";

export interface CharacterCreationResponse {
  character: typeof characters.$inferSelect;
  diagnostics: Diagnostic[];
  materializedSuggestions: MaterializedSuggestion[];
}

export type CharacterCreationOutcome =
  | { status: "created"; response: CharacterCreationResponse; httpStatus: 201 }
  | { status: "create_failed" };

function profileForCreate(profile: CharacterProfile, suggestedIds: readonly string[]): CharacterProfile {
  // A truly blank profile (the library's New button) is born with the curated
  // registry defaults + the body-config those imply (gender=female seeds
  // vulva/breasts). Authored forge/API attributes pass through untouched.
  const blank = profile.attributes.length === 0;
  const seeded = blank ? seedRegistryDefaultValues(profile.attributes) : profile.attributes;
  const seededConfig = blank ? seedBodyConfigFromAttributes(seeded) : null;
  const attributes = materializeBodyDefaults(seeded, {
    speciesId: profile.speciesId,
    heritageId: profile.heritageId,
    bodyPlanId: profile.bodyPlanId,
    intimateRegions: seededConfig?.intimateRegions ?? profile.intimateRegions,
    bodyFeatures: seededConfig?.bodyFeatures ?? profile.bodyFeatures,
  });
  return withItemsInDefaultOutfit(
    {
      ...profile,
      attributes,
      ...(seededConfig
        ? { intimateRegions: seededConfig.intimateRegions, bodyFeatures: seededConfig.bodyFeatures }
        : {}),
    },
    suggestedIds,
  );
}

/**
 * The authored content `createOwnedCharacter` stores for a blank `{ name }`
 * body. A first Forge applies without review only while a character still
 * holds exactly this (docs/authoring/character-forge.md), so create and that
 * check share this one definition. The name is excluded: a never-edited
 * character keeps whatever placeholder it was created with.
 */
export function blankCreatedCharacterContent(): { profile: CharacterProfile; tags: string[] } {
  const body = characterCreateSchema.parse({ name: "blank" });
  return { profile: profileForCreate(body.profile, []), tags: body.tags };
}

/** Create one character and its suggested library items atomically. */
export async function createOwnedCharacter(ownerId: string, body: CharacterCreateBody): Promise<CharacterCreationOutcome> {
  // One batched provider call, completed before the character transaction.
  const preparedEmbeddings = await prepareSuggestedItemEmbeddings(body.suggestedItems);
  const newItemIds: string[] = [];

  const outcome = await db().transaction(async (tx): Promise<CharacterCreationOutcome> => {
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
        profile: profileForCreate(body.profile, materialized.ids),
        tags: body.tags,
      })
      .returning();
    if (!row) return { status: "create_failed" };
    return {
      status: "created",
      response: { character: row, diagnostics: sink.items, materializedSuggestions: materialized.materializedSuggestions },
      httpStatus: 201,
    };
  });

  if (outcome.status === "created") {
    for (const id of newItemIds) queueEmbedRefresh("item", id);
    queueEmbedRefresh("character", outcome.response.character.id);
  }
  return outcome;
}
