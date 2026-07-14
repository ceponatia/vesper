import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { DiagnosticCollector } from "@/contracts/diagnostics";
import { degradedChatArchivist, type ChatArchivist } from "@/contracts/turns/chat-archivist";
import { characterProfileSchema, type CharacterProfile } from "@/contracts/world/profile";
import { newId } from "@/lib/ids";
import { characterChatMessages, characterChats, characters, chatParticipants, db, items, users } from "@/server/db";

/**
 * Chat wardrobe parity (chat-wardrobe-parity.plan.md rung 2): the continuity leg proposes a
 * garment-level change; `finalizeChatState` folds it into the structured `wornItemIds`
 * against the loaded worn items + wardrobe pool, and the pre-exchange snapshot preserves the
 * prior worn list so "another take" rolls it back. Drives `finalizeChatState` directly with
 * a mocked extraction (AI_FAKE would degrade it), following chat-memory-failure.int.test.ts.
 */

process.env.AI_FAKE = "1";

const mock = vi.hoisted(() => ({ archivist: { value: null as ChatArchivist | null, degraded: false } }));

vi.mock("./chat-memory", () => ({
  // The merged aggregate the folds consume (chat-agent-improvements slice 1b) — mocking at
  // the merge seam keeps this test about the WARDROBE fold, not the leg composition.
  runChatExtraction: () =>
    Promise.resolve({ ...mock.archivist, legs: { memory: false, continuity: false, character: false } }),
  writeChatMemory: () => Promise.resolve(),
}));

import { finalizeChatState, loadChatState, loadPreExchangeState, seedChatScenario, seedChatState } from "./chat-state";

async function probe(): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      db().execute(sql`select 1 from character_chat_state limit 1`),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("connect timeout")), 4000);
      }),
    ]);
    return true;
  } catch (err) {
    process.stderr.write(
      `[chat-wardrobe.int.test] skipping: database unreachable: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return false;
  } finally {
    clearTimeout(timer);
  }
}

const ready = await probe();
const fixture = { userId: "", characterId: "", chatId: "", memoryGroupId: "", messageId: "", jacketId: "", teeId: "", cardiganId: "" };
let profile: CharacterProfile = characterProfileSchema.parse({});

/** A full archivist result whose outfit field carries the given proposal. */
function archivistWithOutfit(outfit: Partial<ChatArchivist["outfit"]>): ChatArchivist {
  return { ...degradedChatArchivist(), outfit: { description: "", exposed: false, removed: [], added: [], ...outfit } };
}

beforeAll(async () => {
  if (!ready) return;
  const stamp = Date.now();
  const [user] = await db()
    .insert(users)
    .values({ email: `chat-wardrobe-int-${stamp}@test.local`, name: "Wardrobe Int", role: "admin" })
    .returning();
  if (!user) throw new Error("failed to create test user");
  fixture.userId = user.id;

  const insertItem = async (name: string) => {
    const [row] = await db().insert(items).values({ ownerId: user.id, kind: "clothing", name, description: name }).returning({ id: items.id });
    if (!row) throw new Error("failed to create item");
    return row.id;
  };
  fixture.jacketId = await insertItem("denim jacket");
  fixture.teeId = await insertItem("white cotton tee");
  fixture.cardiganId = await insertItem("grey wool cardigan");

  // The default preset holds jacket + tee (the seeded worn list); the cardigan is in the
  // wardrobe pool but not worn (an add-candidate).
  profile = characterProfileSchema.parse({
    outfits: [
      { id: "everyday", name: "Everyday", items: [fixture.jacketId, fixture.teeId] },
      { id: "cozy", name: "Cozy", items: [fixture.cardiganId] },
    ],
  });
  const [character] = await db().insert(characters).values({ ownerId: user.id, name: "Wren", profile }).returning();
  if (!character) throw new Error("failed to create test character");
  fixture.characterId = character.id;

  const [chat] = await db().insert(characterChats).values({ ownerId: user.id }).returning({ id: characterChats.id });
  if (!chat) throw new Error("failed to create test chat");
  fixture.chatId = chat.id;
  fixture.memoryGroupId = newId();
  await db().insert(chatParticipants).values({ chatId: chat.id, characterId: character.id, memoryGroupId: fixture.memoryGroupId });
  const [message] = await db().insert(characterChatMessages).values({ chatId: chat.id, role: "user", content: "Hi" }).returning();
  if (!message) throw new Error("failed to create test message");
  fixture.messageId = message.id;
});

afterAll(async () => {
  if (!ready) return;
  await db().delete(characterChats).where(eq(characterChats.id, fixture.chatId));
  await db().delete(characters).where(eq(characters.ownerId, fixture.userId));
  await db().delete(items).where(eq(items.ownerId, fixture.userId));
  await db().delete(users).where(eq(users.id, fixture.userId));
  await globalThis.__vesperPool?.end();
});

/** Run one finalize with the given pre-exchange worn list and archivist outfit proposal. */
async function runFinalize(preWorn: string[], outfit: Partial<ChatArchivist["outfit"]>) {
  mock.archivist = { value: archivistWithOutfit(outfit), degraded: false };
  const sink = new DiagnosticCollector();
  const preState = { ...seedChatState(profile), wornItemIds: preWorn };
  await finalizeChatState({
    assistantMessageId: newId(),
    preExchangeState: preState,
    chatId: fixture.chatId,
    characterId: fixture.characterId,
    ownerId: fixture.userId,
    memoryGroupId: fixture.memoryGroupId,
    promptMessageId: fixture.messageId,
    profile,
    characterName: "Wren",
    playerName: "You",
    driftedState: preState,
    now: new Date(),
    exchange: { player: "Hi", assistant: "Hello." },
    scenario: seedChatScenario(profile),
    preExchangeScenario: null,
    sink,
  });
  return sink;
}

describe("finalizeChatState — archivist-proposed garment changes (chat-wardrobe-parity rung 2)", () => {
  it("removes a matched worn garment from the structured worn list", async (t) => {
    if (!ready) return t.skip();
    await runFinalize([fixture.jacketId, fixture.teeId], { removed: ["her denim jacket"] });
    const state = await loadChatState(fixture.chatId, fixture.characterId);
    expect(state?.wornItemIds).toEqual([fixture.teeId]);
  });

  it("adds a matched pool garment's id to the worn list", async (t) => {
    if (!ready) return t.skip();
    await runFinalize([fixture.teeId], { added: ["a wool cardigan"] });
    const state = await loadChatState(fixture.chatId, fixture.characterId);
    expect(state?.wornItemIds).toEqual([fixture.teeId, fixture.cardiganId]);
  });

  it("keeps a narrated-but-unowned added garment as free-text overlay", async (t) => {
    if (!ready) return t.skip();
    await runFinalize([fixture.teeId], { added: ["a borrowed hoodie"] });
    const state = await loadChatState(fixture.chatId, fixture.characterId);
    expect(state?.wornItemIds).toEqual([fixture.teeId]);
    expect(state?.outfit).toBe("a borrowed hoodie");
  });

  it("a named-preset whole swap seeds the worn list from that preset (rung 1)", async (t) => {
    if (!ready) return t.skip();
    await runFinalize([fixture.jacketId, fixture.teeId], { description: "changes into her cozy clothes" });
    const state = await loadChatState(fixture.chatId, fixture.characterId);
    expect(state?.wornItemIds).toEqual([fixture.cardiganId]);
    expect(state?.outfitPresetId).toBe("cozy");
  });

  it("the pre-exchange snapshot preserves the prior worn list for rollback", async (t) => {
    if (!ready) return t.skip();
    await runFinalize([fixture.jacketId, fixture.teeId], { removed: ["her denim jacket"] });
    // The post-exchange state dropped the jacket…
    const post = await loadChatState(fixture.chatId, fixture.characterId);
    expect(post?.wornItemIds).toEqual([fixture.teeId]);
    // …but "another take" rolls back to the pre-exchange worn list.
    const rollback = await loadPreExchangeState(fixture.chatId, fixture.characterId);
    expect(rollback.found).toBe(true);
    expect(rollback.state?.wornItemIds).toEqual([fixture.jacketId, fixture.teeId]);
  });
});
