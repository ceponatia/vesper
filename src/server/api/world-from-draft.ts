import { diag, emptyCharacterProfile, withItemsInDefaultOutfit, type AuthoredRelationship, type DiagnosticSink } from "@/contracts";
import { DiagnosticCollector } from "@/contracts/diagnostics";
import { log } from "@/server/log";
import {
  findCharactersByName,
  findItemsByName,
  forgeCharacter,
  type CastRole,
  type CastTier,
  type WorldDraft,
} from "@/server/authoring";
import { characters, db } from "@/server/db";
import { materializeSuggestedItems, queueEmbedRefresh } from "./library";
import { errorText } from "./respond";
import {
  createWorld,
  updateWorld,
  type WorldCastInput,
  type WorldCreateBody,
  type WorldItemInput,
  type WorldLocationInput,
  type WorldLoreChunkInput,
  type WorldWriteResult,
} from "./worlds";

/** Hard cap on characters forged during a single world save (cost + latency). Honors the intake's 0–5 character dropdown (UX-audit §1b). */
export const MAX_GENERATED_CAST = 5;

/**
 * Save a world-forge draft (docs/authoring.md §World forge): the draft shape
 * (castSuggestions, itemPlacements) is converted to the world create input —
 * cast stubs become real character rows (forged when possible, skeletal stubs
 * when generation fails: the save itself never fails on a bad generation),
 * item placements reuse library items by name before defining new ones, and
 * cast/location names resolve to ids. The converted input then materializes
 * through the standard createWorld path.
 */
export async function createWorldFromDraft(ownerId: string, draft: WorldDraft): Promise<WorldWriteResult> {
  const sink = new DiagnosticCollector();
  const families = await resolveDraftFamilies(ownerId, draft, sink);

  const body: WorldCreateBody = {
    name: draft.name.trim() || "Untitled world",
    description: draft.description,
    style: draft.style,
    lore: draft.lore,
    narrativeModel: "",
    agentModel: "",
    playerStartLocationName: draft.playerStartLocationName,
    playerCharacterId: draft.playerCharacterId,
    ...families,
  };

  const result = await createWorld(ownerId, body);
  if (!result.ok) return result;
  return { ok: true, worldId: result.worldId, diagnostics: [...sink.items, ...result.diagnostics] };
}

/**
 * Save edits to an existing world through the same draft conversion. All four
 * nested families are sent together (PATCH full-replace semantics — sending
 * only some would cascade the rest away). Known limitation: container nesting
 * between world items is not representable in the draft, so a save flattens it.
 */
export async function updateWorldFromDraft(ownerId: string, worldId: string, draft: WorldDraft): Promise<WorldWriteResult> {
  const sink = new DiagnosticCollector();
  const families = await resolveDraftFamilies(ownerId, draft, sink);

  const result = await updateWorld(ownerId, worldId, {
    name: draft.name.trim() || "Untitled world",
    description: draft.description,
    style: draft.style,
    lore: draft.lore,
    playerStartLocationName: draft.playerStartLocationName,
    playerCharacterId: draft.playerCharacterId ?? null,
    ...families,
  });
  if (!result.ok) return result;
  return { ok: true, worldId: result.worldId, diagnostics: [...sink.items, ...result.diagnostics] };
}

async function resolveDraftFamilies(
  ownerId: string,
  draft: WorldDraft,
  sink: DiagnosticCollector,
): Promise<Pick<WorldCreateBody, "locations" | "loreChunks" | "cast" | "items">> {
  const { cast, characterIdByCastName } = await resolveCast(ownerId, draft, sink);
  const items = await resolveItemPlacements(ownerId, draft, characterIdByCastName, sink);

  const locations: WorldLocationInput[] = [];
  for (const loc of draft.locations) {
    const name = loc.name.trim();
    if (!name && !loc.locationId) {
      sink.push(diag("warn", "api.world.from_draft.location_nameless", "dropped a location with no name"));
      continue;
    }
    // The world bakes its own snapshot from these fields either way
    // (world-instances.plan.md); `locationId`, when present, is just the source
    // library template (never mutated from here).
    locations.push({
      locationId: loc.locationId,
      name,
      description: loc.description,
      ambient: loc.ambient,
      tags: loc.tags,
      scale: loc.scale,
      area: loc.area,
      links: loc.links,
    });
  }

  const loreChunks: WorldLoreChunkInput[] = [];
  for (const chunk of draft.loreChunks) {
    if (!chunk.title.trim()) {
      sink.push(diag("warn", "api.world.from_draft.lore_untitled", "dropped a lore chunk with no title"));
      continue;
    }
    loreChunks.push({ ...chunk, title: chunk.title.trim(), characterIds: [] });
  }

  return { locations, loreChunks, cast, items };
}

interface CastStub {
  name: string;
  conceptNote: string;
  role: CastRole;
  tier: CastTier;
  startLocationName?: string;
  relationships: AuthoredRelationship[];
}

async function resolveCast(
  ownerId: string,
  draft: WorldDraft,
  sink: DiagnosticSink,
): Promise<{ cast: WorldCastInput[]; characterIdByCastName: Map<string, string> }> {
  const cast: WorldCastInput[] = [];
  const characterIdByCastName = new Map<string, string>();
  const stubs: CastStub[] = [];

  // Re-match unlinked names against the library in one query — the draft's
  // matching may be stale, and existing characters are never regenerated.
  let idByName = new Map<string, string>();
  try {
    const unmatched = draft.castSuggestions.filter((s) => !s.existingCharacterId && s.name.trim()).map((s) => s.name);
    idByName = new Map((await findCharactersByName(ownerId, unmatched)).map((r) => [r.name.toLowerCase(), r.id]));
  } catch (err) {
    log.warn("api.worlds", "cast re-match lookup failed; treating all unlinked as new", { error: errorText(err) });
  }

  for (const suggestion of draft.castSuggestions) {
    const name = suggestion.name.trim();
    if (suggestion.existingCharacterId) {
      cast.push({
        characterId: suggestion.existingCharacterId,
        role: suggestion.role,
        tier: suggestion.tier,
        startLocationName: suggestion.startLocationName,
        relationships: suggestion.relationships,
      });
      if (name) characterIdByCastName.set(name.toLowerCase(), suggestion.existingCharacterId);
      continue;
    }
    if (!name) {
      sink.push(diag("warn", "api.world.from_draft.cast_nameless", "dropped a cast suggestion with no name"));
      continue;
    }
    if (characterIdByCastName.has(name.toLowerCase()) || stubs.some((s) => s.name.toLowerCase() === name.toLowerCase())) {
      sink.push(diag("warn", "api.world.from_draft.cast_duplicate", `cast suggestion "${name}" listed twice; kept first`));
      continue;
    }
    const matched = idByName.get(name.toLowerCase());
    if (matched) {
      sink.push(diag("info", "api.world.from_draft.cast_matched", `"${name}" matched an existing library character`));
      cast.push({
        characterId: matched,
        role: suggestion.role,
        tier: suggestion.tier,
        startLocationName: suggestion.startLocationName,
        relationships: suggestion.relationships,
      });
      characterIdByCastName.set(name.toLowerCase(), matched);
      continue;
    }
    stubs.push({
      name,
      conceptNote: suggestion.conceptNote,
      role: suggestion.role,
      tier: suggestion.tier,
      startLocationName: suggestion.startLocationName,
      relationships: suggestion.relationships,
    });
  }

  for (const [index, stub] of stubs.entries()) {
    if (index >= MAX_GENERATED_CAST) {
      sink.push(
        diag(
          "warn",
          "api.world.from_draft.cast_capped",
          `"${stub.name}" skipped: at most ${MAX_GENERATED_CAST} new cast members are generated per save`,
        ),
      );
      continue;
    }
    const characterId = await generateCastCharacter(ownerId, stub, draft, sink);
    if (characterId) {
      cast.push({
        characterId,
        role: stub.role,
        tier: stub.tier,
        startLocationName: stub.startLocationName,
        relationships: stub.relationships,
      });
      characterIdByCastName.set(stub.name.toLowerCase(), characterId);
    }
  }

  return { cast, characterIdByCastName };
}

/**
 * Forge a cast stub into a real character row. Generation runs without demo
 * fallbacks — persisted rows must never get sample content — so a failed forge
 * degrades to a skeletal stub (conceptNote as bio, tagged "stub") with a
 * diagnostic pointing at post-save recovery.
 */
async function generateCastCharacter(
  ownerId: string,
  stub: CastStub,
  draft: WorldDraft,
  sink: DiagnosticSink,
): Promise<string | null> {
  const promptLines = [stub.conceptNote ? `${stub.name}: ${stub.conceptNote}` : stub.name];
  if (draft.name.trim() || draft.description.trim()) {
    promptLines.push("", `They live in the world "${draft.name.trim() || "(untitled)"}": ${draft.description}`.trim());
  }

  let forged: Awaited<ReturnType<typeof forgeCharacter>> | null = null;
  try {
    forged = await forgeCharacter({ prompt: promptLines.join("\n"), userId: ownerId, sink, useFallbacks: false });
  } catch (err) {
    sink.push(diag("error", "api.world.from_draft.cast_forge_failed", `forge failed for "${stub.name}": ${errorText(err)}`));
  }

  const profile = { ...(forged?.profile ?? emptyCharacterProfile()) };
  const isStub = !profile.bio.trim();
  if (isStub) {
    profile.bio = stub.conceptNote;
    sink.push(
      diag(
        "warn",
        "api.world.from_draft.cast_saved_as_stub",
        `"${stub.name}" saved as a stub (generation unavailable) — edit or regenerate it from the character library`,
      ),
    );
  }
  if (forged && forged.suggestedItems.length > 0) {
    const itemIds = await materializeSuggestedItems(ownerId, forged.suggestedItems, sink);
    profile.outfits = withItemsInDefaultOutfit(profile, itemIds).outfits;
  }

  const tags = forged?.tags ?? [];
  const [row] = await db()
    .insert(characters)
    .values({
      ownerId,
      name: stub.name,
      profile,
      tags: isStub && !tags.includes("stub") ? [...tags, "stub"] : tags,
    })
    .returning({ id: characters.id });
  if (!row) {
    sink.push(diag("error", "api.world.from_draft.cast_create_failed", `could not create character "${stub.name}"`));
    return null;
  }
  queueEmbedRefresh("character", row.id);
  return row.id;
}

async function resolveItemPlacements(
  ownerId: string,
  draft: WorldDraft,
  characterIdByCastName: Map<string, string>,
  sink: DiagnosticSink,
): Promise<WorldItemInput[]> {
  // Reuse library items by name — a placement never duplicates an existing item.
  let itemIdByName = new Map<string, string>();
  try {
    const names = draft.itemPlacements.map((p) => (p.itemName.trim() || p.definition.name).trim()).filter(Boolean);
    itemIdByName = new Map((await findItemsByName(ownerId, names)).map((r) => [r.name.toLowerCase(), r.id]));
  } catch (err) {
    log.warn("api.worlds", "item re-match lookup failed; defining all placements as new", { error: errorText(err) });
  }

  const items: WorldItemInput[] = [];
  for (const placement of draft.itemPlacements) {
    const name = (placement.itemName.trim() || placement.definition.name).trim();
    if (!name) {
      sink.push(diag("warn", "api.world.from_draft.item_nameless", "dropped an item placement with no name"));
      continue;
    }
    let castCharacterId: string | undefined;
    if (placement.castName?.trim()) {
      castCharacterId = characterIdByCastName.get(placement.castName.trim().toLowerCase());
      if (!castCharacterId) {
        sink.push(
          diag(
            "warn",
            "api.world.from_draft.item_holder_unresolved",
            `holder "${placement.castName}" for "${name}" is not in the cast; placed loose`,
          ),
        );
      }
    }
    const existingId = itemIdByName.get(name.toLowerCase());
    items.push({
      itemId: existingId,
      definition: existingId ? undefined : { ...placement.definition, name },
      locationName: placement.locationName,
      castCharacterId,
      worn: placement.worn && castCharacterId !== undefined,
      quantity: placement.quantity,
    });
  }
  return items;
}
