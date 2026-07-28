import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { DiagnosticCollector } from "@/contracts/diagnostics";
import { degradedChatArchivist, type ChatArchivist } from "@/contracts/turns/chat-archivist";
import type { GarmentOperationProposal } from "@/contracts/turns/chat-garment-ops";
import { switchScenePlace } from "@/contracts/turns/chat-scene-memory";
import { characterProfileSchema, type CharacterProfile } from "@/contracts/world/profile";
import { newId } from "@/lib/ids";
import { characterChatMessages, characterChats, characters, chatParticipants, db, items, users } from "@/server/db";

/**
 * Slice 6 end to end — the narrator digest, the bounded cue block, and OQ8's
 * look-refresh trigger (clothing-state-graph.plan.md §Slice 6).
 *
 * What only a database can prove:
 *
 * - with `CHAT_GARMENT_CUES` off, the narrator prompt is exactly today's — no
 *   digest, no cue block, not one extra character;
 * - with it on, a real store produces the digest AND at most two cues, and the
 *   SECOND exchange over unchanged clothing produces none (the repeat gate,
 *   surviving a round trip through jsonb);
 * - "another take" restores mention history with the wardrobe it describes,
 *   because the cue map rides the store's own rollback anchor (fixture F13);
 * - the look-refresh enqueue is a pre/post KEY comparison: a structural change
 *   fires it, a sub-`wet` wetness drift does not (fixture F19, audit OQ8).
 */

process.env.AI_FAKE = "1";

const mock = vi.hoisted(() => ({
  archivist: { value: null as ChatArchivist | null, degraded: false },
  lookEnqueues: [] as string[],
}));

vi.mock("./chat-memory", () => ({
  runChatExtraction: () =>
    Promise.resolve({ ...mock.archivist, legs: { memory: false, continuity: false, character: false } }),
  writeChatMemory: () => Promise.resolve(),
  // The prompt preview retrieves RAG recall; this test is about the wardrobe blocks,
  // so recall is stubbed empty rather than seeded.
  retrieveChatMemory: () => Promise.resolve({ facts: [], episodes: [], detail: [] }),
}));

// The enqueue is fire-and-forget (`void`), so observing the jobs table would race.
// Recording the CALL is the honest assertion anyway: OQ8 is about whether the
// trigger fires, not about how the job row lands.
vi.mock("./chat-reference-enqueue", () => ({
  enqueueChatLookImage: (args: { chatId: string }) => {
    mock.lookEnqueues.push(args.chatId);
    return Promise.resolve();
  },
  enqueueChatPlaceImage: () => Promise.resolve(),
}));

import {
  editChatState,
  finalizeChatState,
  loadChatScenario,
  loadPreExchangeScenario,
  rollbackScenario,
  saveChatScenario,
  savePreExchangeScenario,
  seedChatState,
  type ChatScenario,
} from "./chat-state";
import { buildChatGarmentNarration, chatGarmentNarrationActors } from "./chat-garments";
import { previewChatPrompt } from "./chat-pipeline";

const DIGEST_HEADING = "Wardrobe right now";
const CUE_HEADING = "Worth noticing about the clothes";

async function probe(): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      db().execute(sql`select 1 from character_chats limit 1`),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("connect timeout")), 4000);
      }),
    ]);
    return true;
  } catch (err) {
    process.stderr.write(
      `[chat-garment-cues.int.test] skipping: database unreachable: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return false;
  } finally {
    clearTimeout(timer);
  }
}

const ready = await probe();
const fixture = { userId: "", characterId: "", shirtId: "", jacketId: "" };
let profile: CharacterProfile = characterProfileSchema.parse({});

beforeAll(async () => {
  if (!ready) return;
  const stamp = Date.now();
  const [user] = await db()
    .insert(users)
    .values({ email: `chat-garment-cues-int-${stamp}@test.local`, name: "Garment Cues Int", role: "admin" })
    .returning();
  if (!user) throw new Error("failed to create test user");
  fixture.userId = user.id;

  const insertItem = async (name: string, definition: Record<string, unknown>) => {
    const [row] = await db()
      .insert(items)
      .values({ ownerId: user.id, kind: "clothing", name, description: name, definition })
      .returning({ id: items.id });
    if (!row) throw new Error("failed to create item");
    return row.id;
  };
  fixture.shirtId = await insertItem("cotton shirt", {
    category: "top",
    coverage: ["shoulders", "chest", "back", "waist", "upper_arms"],
    layer: 1,
  });
  fixture.jacketId = await insertItem("denim jacket", {
    category: "outerwear",
    coverage: ["shoulders", "chest", "back", "waist", "upper_arms", "forearms", "wrists"],
    layer: 3,
  });

  profile = characterProfileSchema.parse({
    outfits: [{ id: "everyday", name: "Everyday", items: [fixture.shirtId, fixture.jacketId] }],
  });
  const [character] = await db().insert(characters).values({ ownerId: user.id, name: "Wren", profile }).returning();
  if (!character) throw new Error("failed to create test character");
  fixture.characterId = character.id;
});

afterAll(async () => {
  if (!ready) return;
  delete process.env.CHAT_GARMENT_CUES;
  await db().delete(characterChats).where(eq(characterChats.ownerId, fixture.userId));
  await db().delete(characters).where(eq(characters.ownerId, fixture.userId));
  await db().delete(items).where(eq(items.ownerId, fixture.userId));
  await db().delete(users).where(eq(users.id, fixture.userId));
  await globalThis.__vesperPool?.end();
});

/** A conversation with a MODELLED wardrobe, standing in a named place. */
async function dressedChat(): Promise<{ chatId: string; memoryGroupId: string; messageId: string; scenario: ChatScenario }> {
  const [chat] = await db().insert(characterChats).values({ ownerId: fixture.userId }).returning({ id: characterChats.id });
  if (!chat) throw new Error("failed to create test chat");
  const memoryGroupId = newId();
  await db().insert(chatParticipants).values({ chatId: chat.id, characterId: fixture.characterId, memoryGroupId });
  const [message] = await db()
    .insert(characterChatMessages)
    .values({ chatId: chat.id, role: "user", content: "Hi" })
    .returning();
  if (!message) throw new Error("failed to create test message");
  await editChatState({
    chatId: chat.id,
    characterId: fixture.characterId,
    ownerId: fixture.userId,
    profile,
    patch: { mindNote: "start" },
  });
  const loaded = await loadChatScenario(chat.id);
  if (!loaded) throw new Error("scenario missing");
  const scenario: ChatScenario = { ...loaded, sceneMemory: switchScenePlace(loaded.sceneMemory, "the study") };
  await saveChatScenario(chat.id, scenario);
  return { chatId: chat.id, memoryGroupId, messageId: message.id, scenario };
}

/** "What reaches the narrator right now", as the dev inspector renders it. */
async function narratorPrompt(chatId: string, memoryGroupId: string): Promise<string> {
  const preview = await previewChatPrompt({
    chatId,
    memoryGroupId,
    character: { id: fixture.characterId, name: "Wren", profile },
  });
  return `${preview.prefix}\n${preview.tail}`;
}

/** Run one exchange whose continuity leg returned exactly these garment proposals. */
async function settle(args: {
  chat: { chatId: string; memoryGroupId: string; messageId: string };
  scenario: ChatScenario;
  proposals?: readonly GarmentOperationProposal[];
  /** Pass the slice-6 cue memory (what the prompt surfaced) — omit to leave it untouched. */
  withCues?: boolean;
}): Promise<ChatScenario> {
  mock.archivist = {
    value: { ...degradedChatArchivist(), garmentOperations: [...(args.proposals ?? [])] },
    degraded: false,
  };
  const driftedState = { ...seedChatState(profile), wornItemIds: [fixture.shirtId, fixture.jacketId] };
  const narration = args.withCues
    ? buildChatGarmentNarration({
        store: args.scenario.garments,
        atMinutes: args.scenario.clockMinutes,
        placeName: "the study",
        actors: chatGarmentNarrationActors({
          characterId: fixture.characterId,
          characterName: "Wren",
          playerName: "You",
        }),
      })
    : null;
  await finalizeChatState({
    assistantMessageId: newId(),
    preExchangeState: driftedState,
    chatId: args.chat.chatId,
    characterId: fixture.characterId,
    ownerId: fixture.userId,
    memoryGroupId: args.chat.memoryGroupId,
    promptMessageId: args.chat.messageId,
    profile,
    characterName: "Wren",
    playerName: "You",
    driftedState,
    now: new Date(),
    exchange: { player: "Hi", assistant: "Hello." },
    scenario: args.scenario,
    preExchangeScenario: args.scenario,
    ...(narration ? { garmentCueState: narration.nextCues } : {}),
    sink: new DiagnosticCollector(),
  });
  const scenario = await loadChatScenario(args.chat.chatId);
  if (!scenario) throw new Error("scenario missing after finalize");
  return scenario;
}

/**
 * The roll lands on the JACKET, deliberately: it is the outer layer, so its
 * sleeve is the one the eye can actually reach. The shirt underneath is where
 * the perception gate is proven (its own sleeve is buried and says nothing).
 */
const ROLL_LEFT: GarmentOperationProposal = {
  op: "roll",
  garment: "wren.jacket",
  part: "sleeve_left",
  degree: "substantial",
};

describe("the flag — off is today, to the character", () => {
  it("renders neither block when CHAT_GARMENT_CUES is unset", async (t) => {
    if (!ready) return t.skip();
    delete process.env.CHAT_GARMENT_CUES;
    const chat = await dressedChat();
    await settle({ chat, scenario: chat.scenario, proposals: [ROLL_LEFT] });
    const prompt = await narratorPrompt(chat.chatId, chat.memoryGroupId);
    expect(prompt).not.toContain(DIGEST_HEADING);
    expect(prompt).not.toContain(CUE_HEADING);
    // The rolled sleeve really is in the store — the flag is hiding it, not the state.
    const scenario = await loadChatScenario(chat.chatId);
    expect(scenario?.garments.instances.some((i) => Object.keys(i.presentation.roll).length > 0)).toBe(true);
    // …and the legacy garment phrase is untouched, so nothing about today moved.
    expect(prompt).toContain("You're wearing");
  });

  it("adds exactly the two blocks when it is on, and nothing else changes", async (t) => {
    if (!ready) return t.skip();
    const chat = await dressedChat();
    await settle({ chat, scenario: chat.scenario, proposals: [ROLL_LEFT] });

    delete process.env.CHAT_GARMENT_CUES;
    const off = await narratorPrompt(chat.chatId, chat.memoryGroupId);
    process.env.CHAT_GARMENT_CUES = "on";
    const on = await narratorPrompt(chat.chatId, chat.memoryGroupId);

    expect(on).toContain(DIGEST_HEADING);
    expect(on).toContain("denim jacket: left sleeve rolled");
    expect(on).toContain(CUE_HEADING);
    expect(on).toContain("Wren's denim jacket is rolled back at the left sleeve");
    // Everything the OFF prompt said, the ON prompt still says — this is an
    // addition, never a rewrite of the wardrobe phrase it complements.
    for (const line of off.split("\n")) expect(on).toContain(line);
  });
});

describe("the repeat gate, through jsonb", () => {
  it("cues the roll once, then guards it in the digest and says nothing more", async (t) => {
    if (!ready) return t.skip();
    process.env.CHAT_GARMENT_CUES = "on";
    const chat = await dressedChat();
    // Exchange 1 rolls the sleeve. The prompt is built BEFORE the fan-out (as it
    // is live), so this exchange's cue memory records the pre-roll cut — the
    // narrator hears about the roll on the NEXT prompt, exactly like `surfacedCues`.
    const afterRoll = await settle({ chat, scenario: chat.scenario, proposals: [ROLL_LEFT], withCues: true });
    const first = await narratorPrompt(chat.chatId, chat.memoryGroupId);
    expect(first).toContain(CUE_HEADING);
    expect(first).toContain("Wren's denim jacket is rolled back at the left sleeve");
    const cueLines = first.slice(first.indexOf(CUE_HEADING)).split("\n\n")[0]?.split("\n").slice(1) ?? [];
    expect(cueLines.length).toBeLessThanOrEqual(2);

    // Exchange 2 changes nothing about the clothes — and records that the roll
    // has now been said. The read is standing state from here on.
    await settle({ chat, scenario: afterRoll, withCues: true });
    const second = await narratorPrompt(chat.chatId, chat.memoryGroupId);
    expect(second).toContain(DIGEST_HEADING);
    expect(second).toContain("left sleeve rolled");
    expect(second).not.toContain(CUE_HEADING);

    // The memory is really on the row, not in a process-local cache.
    const stored = await loadChatScenario(chat.chatId);
    expect(Object.values(stored?.garments.cues.cues ?? {})).toContain("rolled");
  });

  it("F12 — a buried garment stays in the digest and out of the cue block", async (t) => {
    if (!ready) return t.skip();
    process.env.CHAT_GARMENT_CUES = "on";
    const chat = await dressedChat();
    // The shirt's sleeve is under the jacket's. The state is real and the guard
    // states it; the eye cannot reach it, so nothing is offered to notice.
    await settle({
      chat,
      scenario: chat.scenario,
      proposals: [{ op: "roll", garment: "wren.shirt", part: "sleeve_left", degree: "substantial" }],
    });
    const prompt = await narratorPrompt(chat.chatId, chat.memoryGroupId);
    expect(prompt).toContain("cotton shirt: left sleeve rolled");
    expect(prompt).not.toContain(CUE_HEADING);
  });
});

describe("F13 — a retake restores mention history WITH the wardrobe", () => {
  it("rolls the cue memory back on the store's own anchor", async (t) => {
    if (!ready) return t.skip();
    process.env.CHAT_GARMENT_CUES = "on";
    const chat = await dressedChat();
    // Two exchanges: one to roll the sleeve, one for the narrator to say it —
    // which is what puts a repeat key in the memory worth rolling back.
    const rolled = await settle({ chat, scenario: chat.scenario, proposals: [ROLL_LEFT], withCues: true });
    const anchorScenario = await settle({ chat, scenario: rolled, withCues: true });
    expect(Object.values(anchorScenario.garments.cues.cues)).toContain("rolled");
    await savePreExchangeScenario(chat.chatId, anchorScenario);
    const anchorJson = JSON.stringify(anchorScenario.garments);

    // A take that opens the placket AND surfaces its own cue.
    const diverged = await settle({
      chat,
      scenario: anchorScenario,
      withCues: true,
      proposals: [{ op: "closure", garment: "wren.jacket", part: "front_panel", state: "open" }],
    });
    expect(JSON.stringify(diverged.garments)).not.toBe(anchorJson);

    const anchor = await loadPreExchangeScenario(chat.chatId);
    expect(anchor).not.toBeNull();
    if (!anchor) return;
    const rolledBack = rollbackScenario(anchor, diverged);
    // Instances, blueprint map AND the observation repeat-key map, byte for byte.
    expect(JSON.stringify(rolledBack.garments)).toBe(anchorJson);
    expect(rolledBack.garments.cues).toEqual(anchorScenario.garments.cues);
  });
});

describe("OQ8 — the look refresh is a key comparison, not a proposal count", () => {
  it("enqueues on a structural change and stays quiet on a damp drift", async (t) => {
    if (!ready) return t.skip();
    const chat = await dressedChat();

    mock.lookEnqueues = [];
    const afterRoll = await settle({ chat, scenario: chat.scenario, proposals: [ROLL_LEFT] });
    expect(mock.lookEnqueues).toEqual([chat.chatId]);

    // A wetness change that stays under `wet` moves the store but NOT the look:
    // drying is continuous, and reminting a portrait per step is what OQ8 refused.
    mock.lookEnqueues = [];
    const afterDamp = await settle({
      chat,
      scenario: afterRoll,
      proposals: [
        { op: "condition", garment: "wren.jacket", parts: [], channel: "wetness", direction: "increase", degree: "slight" },
      ],
    });
    const jacket = afterDamp.garments.instances.find((i) => i.definitionId === fixture.jacketId);
    expect(jacket?.condition.base.wetness).toBeGreaterThan(0);
    expect(mock.lookEnqueues).toEqual([]);

    // Taking the jacket off is a worn-set change — the key moves and so does the anchor.
    mock.lookEnqueues = [];
    await settle({
      chat,
      scenario: afterDamp,
      proposals: [{ op: "move", garment: "wren.jacket", to: "left_here", anchor: "over the desk chair" }],
    });
    expect(mock.lookEnqueues).toEqual([chat.chatId]);
  });
});
