import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DiagnosticCollector } from "@/contracts/diagnostics";
import { emptyCharacterProfile, type CharacterProfile } from "@/contracts/world/profile";
import { characterChats, characters, chatParticipants, db, users } from "@/server/db";
import { newId } from "@/lib/ids";
import {
  loadChatState,
  loadPreExchangeState,
  persistChatState,
  savePreExchangeSnapshot,
  seedChatState,
  type ChatState,
} from "./chat-state";

// Character-fidelity slices 8 + 10: the voice-exemplar ring and the persisted narrative
// trait overlays are new (chatId, characterId) state columns. This int test proves they
// round-trip the jsonb boundary AND roll back with the pre-exchange snapshot — the same
// "another take" guarantee the callback/selfie rings already carry.

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
      `[chat-state-fidelity.int.test] skipping: database unreachable: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return false;
  } finally {
    clearTimeout(timer);
  }
}

const ready = await probe();
const fixture = { userId: "", characterId: "", chatId: "" };

const richProfile = (): CharacterProfile => ({
  ...emptyCharacterProfile(),
  traits: [{ id: "temperament.warmth", value: 0, source: "creation" }],
});

const richState = (): ChatState => ({
  ...seedChatState(richProfile()),
  voiceExemplars: [
    { line: "Tell me you at least practiced the toast.", atClockMinutes: 30 },
    { line: "No promises.", atClockMinutes: 60 },
  ],
  traitOverlays: [{ id: "temperament.warmth", value: 20, source: "narrative", note: "narrative arc" }],
});

beforeAll(async () => {
  if (!ready) return;
  const stamp = Date.now();
  const [user] = await db()
    .insert(users)
    .values({ email: `chat-fidelity-int-${stamp}@test.local`, name: "Fidelity Int", role: "admin" })
    .returning();
  if (!user) throw new Error("failed to create test user");
  fixture.userId = user.id;
  const [character] = await db().insert(characters).values({ ownerId: user.id, name: "Mara", profile: {} }).returning();
  if (!character) throw new Error("failed to create test character");
  fixture.characterId = character.id;
  const [chat] = await db().insert(characterChats).values({ ownerId: user.id }).returning({ id: characterChats.id });
  if (!chat) throw new Error("failed to create test chat");
  fixture.chatId = chat.id;
  await db().insert(chatParticipants).values({ chatId: chat.id, characterId: character.id, memoryGroupId: newId() });
});

afterAll(async () => {
  if (!ready) return;
  await db().delete(characterChats).where(eq(characterChats.id, fixture.chatId));
  await db().delete(characters).where(eq(characters.ownerId, fixture.userId));
  await db().delete(users).where(eq(users.id, fixture.userId));
  await globalThis.__vesperPool?.end();
});

describe("voice-exemplar ring + trait overlays persistence (slices 8 + 10)", () => {
  it("round-trips both columns through the jsonb boundary", async (t) => {
    if (!ready) return t.skip();
    const sink = new DiagnosticCollector();
    await persistChatState(fixture.chatId, fixture.characterId, richState());
    const loaded = await loadChatState(fixture.chatId, fixture.characterId, sink);
    expect(loaded?.voiceExemplars).toHaveLength(2);
    expect(loaded?.voiceExemplars[0]?.line).toBe("Tell me you at least practiced the toast.");
    expect(loaded?.traitOverlays).toEqual([
      { id: "temperament.warmth", value: 20, source: "narrative", note: "narrative arc" },
    ]);
    expect(sink.items).toHaveLength(0);
  });

  it("rolls back the ring + overlays with the pre-exchange snapshot ('another take')", async (t) => {
    if (!ready) return t.skip();
    // The row exists; record the rich state as the rollback anchor, then diverge the live row.
    await persistChatState(fixture.chatId, fixture.characterId, richState());
    await savePreExchangeSnapshot(fixture.chatId, fixture.characterId, richState());
    await persistChatState(fixture.chatId, fixture.characterId, {
      ...seedChatState(richProfile()),
      voiceExemplars: [],
      traitOverlays: [],
    });

    const rolled = await loadPreExchangeState(fixture.chatId, fixture.characterId);
    expect(rolled.found).toBe(true);
    expect(rolled.state?.voiceExemplars).toHaveLength(2);
    expect(rolled.state?.traitOverlays).toEqual([
      { id: "temperament.warmth", value: 20, source: "narrative", note: "narrative arc" },
    ]);
  });
});
