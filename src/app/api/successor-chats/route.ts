import { and, desc, eq, inArray, ne } from "drizzle-orm";
import { z } from "zod";
import { newId } from "@/lib/ids";
import { jsonError, jsonOk, readBody, withUser } from "@/server/api";
import { characterChats, characters, chatParticipants, db, simBranches } from "@/server/db";
import { provisionStarterWorld, setChatEngineAuthority } from "@/server/engine";

/**
 * The successor front door (engine.rollout.plan.md, owner ask 2026-07-22) —
 * the Worlds page's API. POST spins up a complete successor chat in one call:
 * an ordinary character chat, a FRESH starter world (isolated branch, cast
 * named after the player and the character), and the authority flip to
 * `successor_narrative_view` with both actors mapped — everything the backend
 * setup used to require. GET lists the caller's successor chats with each
 * world's clock. Open to every signed-in user (owner ruling: all users on
 * this deployment are devs; sign-up is closed).
 */

/** Per-user cap on successor chats — each one carries a whole provisioned world. */
const MAX_SUCCESSOR_CHATS = 25;

const createBodySchema = z
  .object({
    characterId: z.string().min(1).max(120),
    title: z.string().trim().max(120).optional(),
  })
  .strict();

export const POST = withUser(async (user, req) => {
  const body = await readBody(req, createBodySchema);
  if (!body.ok) return body.response;

  const [character] = await db()
    .select({ id: characters.id, name: characters.name })
    .from(characters)
    .where(and(eq(characters.id, body.value.characterId), eq(characters.ownerId, user.id)));
  if (!character) return jsonError("not_found", "that character is not in your library", 404);

  const existing = await db()
    .select({ id: characterChats.id })
    .from(characterChats)
    .where(and(eq(characterChats.ownerId, user.id), ne(characterChats.engineAuthority, "legacy_chat")));
  if (existing.length >= MAX_SUCCESSOR_CHATS) {
    return jsonError("too_many_worlds", `you already have ${MAX_SUCCESSOR_CHATS} successor chats; delete one first`, 409);
  }

  const world = await provisionStarterWorld({
    playerName: (user.name ?? "").split(/\s+/)[0] ?? "",
    primaryName: character.name,
  });

  const chatId = newId();
  await db().transaction(async (tx) => {
    await tx.insert(characterChats).values({
      id: chatId,
      ownerId: user.id,
      title: body.value.title?.trim() || `${character.name}'s world`,
    });
    // Fresh memory island: successor chats never join a shared legacy history.
    await tx.insert(chatParticipants).values({ chatId, characterId: character.id, memoryGroupId: newId(), sort: 0 });
  });
  const flipped = await setChatEngineAuthority({
    chatId,
    byUserId: user.id,
    authority: "successor_narrative_view",
    simBranchId: world.branchId,
    simPlayerActorId: world.playerActorId,
    simPrimaryActorId: world.primaryActorId,
  });
  if (!flipped) return jsonError("flip_failed", "the world was provisioned but the chat could not be routed", 500);

  return jsonOk({ id: chatId, worldId: world.worldId, branchId: world.branchId }, 201);
});

/** GET /api/successor-chats — the caller's successor chats, newest first, with each world's clock. */
export const GET = withUser(async (user) => {
  const rows = await db()
    .select({
      id: characterChats.id,
      title: characterChats.title,
      authority: characterChats.engineAuthority,
      simBranchId: characterChats.simBranchId,
      lastMessageAt: characterChats.lastMessageAt,
    })
    .from(characterChats)
    .where(and(eq(characterChats.ownerId, user.id), ne(characterChats.engineAuthority, "legacy_chat")))
    .orderBy(desc(characterChats.lastMessageAt))
    .limit(100);
  if (rows.length === 0) return jsonOk({ chats: [] });

  const branchIds = rows.flatMap((row) => (row.simBranchId ? [row.simBranchId] : []));
  const branches = branchIds.length
    ? await db()
        .select({ id: simBranches.id, storySecond: simBranches.storySecond })
        .from(simBranches)
        .where(inArray(simBranches.id, branchIds))
    : [];
  const clocks = new Map(branches.map((branch) => [branch.id, branch.storySecond]));
  const primaries = await db()
    .select({ chatId: chatParticipants.chatId, sort: chatParticipants.sort, name: characters.name })
    .from(chatParticipants)
    .innerJoin(characters, eq(characters.id, chatParticipants.characterId))
    .where(inArray(chatParticipants.chatId, rows.map((row) => row.id)));
  const primaryName = new Map<string, string>();
  for (const row of primaries.sort((a, b) => b.sort - a.sort)) primaryName.set(row.chatId, row.name);

  return jsonOk({
    chats: rows.map((row) => ({
      id: row.id,
      title: row.title,
      characterName: primaryName.get(row.id) ?? "",
      authority: row.authority,
      storySecond: row.simBranchId === null ? null : (clocks.get(row.simBranchId) ?? null),
      lastMessageAt: row.lastMessageAt instanceof Date ? row.lastMessageAt.toISOString() : String(row.lastMessageAt),
    })),
  });
});
