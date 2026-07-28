import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { DiagnosticCollector } from "@/contracts/diagnostics";
import { degradedChatArchivist, type ChatArchivist } from "@/contracts/turns/chat-archivist";
import type { GarmentOperationProposal } from "@/contracts/turns/chat-garment-ops";
import { switchScenePlace } from "@/contracts/turns/chat-scene-memory";
import { characterProfileSchema, type CharacterProfile } from "@/contracts/world/profile";
import { garmentActorForCharacter, garmentsAtScenePlace, wornGarmentDefinitionIds } from "@/contracts/items/garment-store";
import { newId } from "@/lib/ids";
import { characterChatMessages, characterChats, characters, chatParticipants, db, items, users } from "@/server/db";

/**
 * Slice 5 — grounded continuity extraction, end to end
 * (clothing-state-graph.plan.md §Slice 5; audit OQ7 + R2).
 *
 * What only a database can prove: that a faked continuity reply's typed
 * proposals reach the persisted store AND its worn-id projections in ONE write,
 * that an `introduce` mints a really-located instance, that a rejected proposal
 * lands in both the diagnostics and the admin inspector's trace, that a reply
 * carrying only the OLD free-text grammar still folds through the legacy bridge
 * with its own diagnostic — and that "another take" discards an exchange's
 * garment operations whole, because the store rides `pre_exchange_scenario`.
 */

process.env.AI_FAKE = "1";

const mock = vi.hoisted(() => ({ archivist: { value: null as ChatArchivist | null, degraded: false } }));

vi.mock("./chat-memory", () => ({
  runChatExtraction: () =>
    Promise.resolve({ ...mock.archivist, legs: { memory: false, continuity: false, character: false } }),
  writeChatMemory: () => Promise.resolve(),
}));

import {
  editChatState,
  finalizeChatState,
  loadChatScenario,
  loadChatState,
  loadPreExchangeScenario,
  rollbackScenario,
  saveChatScenario,
  seedChatScenario,
  seedChatState,
  type ChatScenario,
} from "./chat-state";

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
      `[chat-garment-ops.int.test] skipping: database unreachable: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return false;
  } finally {
    clearTimeout(timer);
  }
}

const ready = await probe();
const fixture = { userId: "", characterId: "", shirtId: "", jacketId: "", cardiganId: "" };
let profile: CharacterProfile = characterProfileSchema.parse({});

beforeAll(async () => {
  if (!ready) return;
  const stamp = Date.now();
  const [user] = await db()
    .insert(users)
    .values({ email: `chat-garment-ops-int-${stamp}@test.local`, name: "Garment Ops Int", role: "admin" })
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
  fixture.cardiganId = await insertItem("wool cardigan", {
    category: "outerwear",
    coverage: ["shoulders", "chest", "back", "waist", "upper_arms"],
    layer: 2,
  });

  profile = characterProfileSchema.parse({
    outfits: [
      { id: "everyday", name: "Everyday", items: [fixture.shirtId, fixture.jacketId] },
      // The cardigan is in the wardrobe POOL but not worn — what the legacy
      // name-matching bridge resolves an `added` phrase against.
      { id: "cozy", name: "Cozy", items: [fixture.cardiganId] },
    ],
  });
  const [character] = await db().insert(characters).values({ ownerId: user.id, name: "Wren", profile }).returning();
  if (!character) throw new Error("failed to create test character");
  fixture.characterId = character.id;
});

afterAll(async () => {
  if (!ready) return;
  await db().delete(characterChats).where(eq(characterChats.ownerId, fixture.userId));
  await db().delete(characters).where(eq(characters.ownerId, fixture.userId));
  await db().delete(items).where(eq(items.ownerId, fixture.userId));
  await db().delete(users).where(eq(users.id, fixture.userId));
  await globalThis.__vesperPool?.end();
});

const ACTOR = () => garmentActorForCharacter(fixture.characterId);

async function newChat(): Promise<{ chatId: string; memoryGroupId: string; messageId: string }> {
  const [chat] = await db().insert(characterChats).values({ ownerId: fixture.userId }).returning({ id: characterChats.id });
  if (!chat) throw new Error("failed to create test chat");
  const memoryGroupId = newId();
  await db().insert(chatParticipants).values({ chatId: chat.id, characterId: fixture.characterId, memoryGroupId });
  const [message] = await db()
    .insert(characterChatMessages)
    .values({ chatId: chat.id, role: "user", content: "Hi" })
    .returning();
  if (!message) throw new Error("failed to create test message");
  return { chatId: chat.id, memoryGroupId, messageId: message.id };
}

/**
 * A conversation whose wardrobe is already MODELLED and standing in a named
 * place — the state in which the continuity prompt actually carries handles.
 * Handles are then `wren.shirt` / `wren.jacket` by construction.
 */
async function dressedChat(): Promise<{ chatId: string; memoryGroupId: string; messageId: string; scenario: ChatScenario }> {
  const chat = await newChat();
  await editChatState({
    chatId: chat.chatId,
    characterId: fixture.characterId,
    ownerId: fixture.userId,
    profile,
    patch: { mindNote: "start" },
  });
  const loaded = await loadChatScenario(chat.chatId);
  if (!loaded) throw new Error("scenario missing");
  const scenario: ChatScenario = { ...loaded, sceneMemory: switchScenePlace(loaded.sceneMemory, "the study") };
  await saveChatScenario(chat.chatId, scenario);
  return { ...chat, scenario };
}

/** Run one exchange whose continuity leg returned exactly these fields. */
async function settle(args: {
  chat: { chatId: string; memoryGroupId: string; messageId: string };
  scenario: ChatScenario;
  archivist: Partial<ChatArchivist>;
  preExchangeScenario?: ChatScenario | null;
  wornItemIds?: readonly string[];
}) {
  mock.archivist = { value: { ...degradedChatArchivist(), ...args.archivist }, degraded: false };
  const sink = new DiagnosticCollector();
  const driftedState = {
    ...seedChatState(profile),
    wornItemIds: [...(args.wornItemIds ?? [fixture.shirtId, fixture.jacketId])],
  };
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
    preExchangeScenario: args.preExchangeScenario ?? args.scenario,
    sink,
  });
  const scenario = await loadChatScenario(args.chat.chatId, sink);
  const state = await loadChatState(args.chat.chatId, fixture.characterId, sink);
  if (!scenario || !state) throw new Error("chat rows missing after finalize");
  return { scenario, state, sink };
}

const ops = (proposals: readonly GarmentOperationProposal[]): Partial<ChatArchivist> => ({
  garmentOperations: [...proposals],
});

describe("the grounded lane mutates the store and its projections in one write", () => {
  it("applies typed proposals over the enumerated handles", async (t) => {
    if (!ready) return t.skip();
    const chat = await dressedChat();
    const { scenario, state, sink } = await settle({
      chat,
      scenario: chat.scenario,
      archivist: ops([
        { op: "move", garment: "wren.jacket", to: "left_here", anchor: "over the desk chair" },
        { op: "roll", garment: "wren.shirt", part: "sleeve_left", degree: "substantial" },
        {
          op: "condition",
          garment: "wren.shirt",
          parts: [],
          channel: "wetness",
          direction: "increase",
          degree: "moderate",
        },
      ]),
    });

    // The jacket is located, not destroyed — and it left the derived worn list.
    const left = garmentsAtScenePlace(scenario.garments, "the study");
    expect(left.map((i) => i.definitionId)).toEqual([fixture.jacketId]);
    expect(left[0]?.locus).toEqual({ kind: "scene", placeName: "the study", anchor: "over the desk chair" });
    expect(wornGarmentDefinitionIds(scenario.garments, ACTOR())).toEqual([fixture.shirtId]);
    // The projection column is re-derived from the store in the SAME write.
    expect(state.wornItemIds).toEqual([fixture.shirtId]);

    const shirt = scenario.garments.instances.find((i) => i.definitionId === fixture.shirtId);
    expect(shirt?.presentation.roll.sleeve_left).toBeGreaterThan(0);
    expect(shirt?.condition.base.wetness).toBeGreaterThan(0);

    // The legacy bridge did NOT run.
    expect(sink.items.map((d) => d.code)).not.toContain("chat_garments.legacy_outfit_bridge");
    expect(state.lastMemoryTrace.garmentLane).toBe("operations");
    expect(state.lastMemoryTrace.garmentOperations.map((row) => `${row.op}:${row.outcome}`)).toEqual([
      "move:applied",
      "roll:applied",
      "condition:applied",
    ]);
  });

  it("R2 — `introduce` mints a real, located instance with no library provenance", async (t) => {
    if (!ready) return t.skip();
    const chat = await dressedChat();
    const { scenario, state } = await settle({
      chat,
      scenario: chat.scenario,
      archivist: ops([
        {
          op: "introduce",
          handle: "wren.hoodie",
          name: "a borrowed grey hoodie",
          category: "outerwear",
          material: "knit",
          wearer: "wren",
          at: "worn",
        },
      ]),
    });

    const minted = scenario.garments.instances.find((i) => i.name === "a borrowed grey hoodie");
    expect(minted).toBeDefined();
    expect(minted?.locus).toEqual({ kind: "worn", actorId: ACTOR() });
    expect(minted?.definitionId).toBeUndefined();
    expect(scenario.garments.blueprints[minted?.blueprintHash ?? ""]?.nodes.map((n) => n.id)).toEqual(
      expect.arrayContaining(["root", "sleeve_left", "front_panel"]),
    );
    // A minted garment has no definition id, so the compatibility projection is
    // unchanged by it — it can never smuggle itself into the id-keyed look key.
    expect(state.wornItemIds).toEqual([fixture.shirtId, fixture.jacketId]);
    expect(state.lastMemoryTrace.garmentOperations[0]).toMatchObject({
      op: "introduce",
      garment: "wren.hoodie",
      outcome: "applied",
    });
  });

  it("a rejected proposal lands in the diagnostics AND the inspector trace, leaving the store alone", async (t) => {
    if (!ready) return t.skip();
    const chat = await dressedChat();
    const before = JSON.stringify(chat.scenario.garments);
    const { scenario, state, sink } = await settle({
      chat,
      scenario: chat.scenario,
      archivist: ops([
        { op: "roll", garment: "wren.shirt", part: "sleeve_middle", degree: "substantial" },
        { op: "tuck", garment: "wren.trenchcoat", part: "hem", state: "in" },
      ]),
    });

    expect(JSON.stringify(scenario.garments)).toBe(before);
    const codes = sink.items.map((d) => d.code);
    expect(codes).toContain("garment_op.part_unresolved");
    expect(codes).toContain("garment_op.garment_unresolved");
    expect(state.lastMemoryTrace.garmentOperations).toEqual([
      expect.objectContaining({ op: "roll", garment: "wren.shirt", code: "garment_op.part_unresolved", outcome: "rejected" }),
      expect.objectContaining({
        op: "tuck",
        garment: "wren.trenchcoat",
        garmentId: "",
        code: "garment_op.garment_unresolved",
        outcome: "rejected",
      }),
    ]);
  });
});

describe("the legacy free-text bridge", () => {
  it("still folds an outfit-only reply, with one diagnostic marking its use", async (t) => {
    if (!ready) return t.skip();
    const chat = await dressedChat();
    const { scenario, state, sink } = await settle({
      chat,
      scenario: chat.scenario,
      archivist: { outfit: { description: "", exposed: false, removed: ["her jacket"], added: ["a wool cardigan"] } },
    });

    expect(sink.items.filter((d) => d.code === "chat_garments.legacy_outfit_bridge")).toHaveLength(1);
    expect(state.lastMemoryTrace.garmentLane).toBe("legacy");
    expect(state.lastMemoryTrace.garmentOperations).toEqual([]);
    // Unchanged behaviour: the name matcher still swapped the pieces.
    expect(wornGarmentDefinitionIds(scenario.garments, ACTOR())).toEqual([fixture.shirtId, fixture.cardiganId]);
    expect(state.wornItemIds).toEqual([fixture.shirtId, fixture.cardiganId]);
  });

  it("never runs alongside the grounded lane — operations win outright", async (t) => {
    if (!ready) return t.skip();
    const chat = await dressedChat();
    const { scenario, state, sink } = await settle({
      chat,
      scenario: chat.scenario,
      archivist: {
        ...ops([{ op: "move", garment: "wren.jacket", to: "put_away" }]),
        // A model that answered in BOTH grammars: the free text is ignored whole.
        outfit: { description: "", exposed: false, removed: [], added: ["a wool cardigan"] },
      },
    });

    expect(sink.items.map((d) => d.code)).not.toContain("chat_garments.legacy_outfit_bridge");
    expect(state.lastMemoryTrace.garmentLane).toBe("operations");
    // The cardigan was never added; only the operation landed.
    expect(wornGarmentDefinitionIds(scenario.garments, ACTOR())).toEqual([fixture.shirtId]);
    expect(scenario.garments.instances.some((i) => i.definitionId === fixture.cardiganId)).toBe(false);
  });

  it("no proposals and no free text ⇒ neither path runs", async (t) => {
    if (!ready) return t.skip();
    const chat = await dressedChat();
    const before = JSON.stringify(chat.scenario.garments);
    const { scenario, state, sink } = await settle({ chat, scenario: chat.scenario, archivist: {} });
    expect(JSON.stringify(scenario.garments)).toBe(before);
    expect(state.lastMemoryTrace.garmentLane).toBe("none");
    expect(sink.items.map((d) => d.code)).not.toContain("chat_garments.legacy_outfit_bridge");
  });
});

describe("rollback — a retake discards the exchange's garment operations entirely", () => {
  it("restores the pre-exchange store byte-for-byte", async (t) => {
    if (!ready) return t.skip();
    const chat = await dressedChat();
    const anchor = chat.scenario;
    const anchorJson = JSON.stringify(anchor.garments);

    const { scenario, state } = await settle({
      chat,
      scenario: anchor,
      preExchangeScenario: anchor,
      archivist: ops([
        { op: "move", garment: "wren.jacket", to: "left_here", anchor: "over the desk chair" },
        { op: "roll", garment: "wren.shirt", part: "sleeve_right", degree: "extreme" },
        { op: "deposit", garment: "wren.shirt", parts: ["hem"], substance: "mud", degree: "substantial" },
        {
          op: "introduce",
          handle: "wren.scarf",
          name: "a silk scarf",
          category: "top",
          wearer: "wren",
          at: "held",
        },
      ]),
    });
    // Everything moved: a transfer, a roll, a deposit and a mint.
    expect(JSON.stringify(scenario.garments)).not.toBe(anchorJson);
    expect(state.lastMemoryTrace.garmentOperations.filter((r) => r.outcome === "applied")).toHaveLength(4);

    // "Another take": the store rides `pre_exchange_scenario`, so the rollback needs
    // no machinery of its own — the mint, the mud and the roll all vanish together.
    const stored = await loadPreExchangeScenario(chat.chatId);
    expect(stored).not.toBeNull();
    if (!stored) return;
    const rolledBack = rollbackScenario(stored, scenario);
    expect(JSON.stringify(rolledBack.garments)).toBe(anchorJson);
    expect(rolledBack.garments.instances.some((i) => i.name === "a silk scarf")).toBe(false);
    expect(garmentsAtScenePlace(rolledBack.garments, "the study")).toEqual([]);
  });
});

describe("an unmodelled chat never arms the grounded lane", () => {
  it("seeds through the legacy bridge on the first exchange, then has handles", async (t) => {
    if (!ready) return t.skip();
    const chat = await newChat();
    // Nothing has written state yet, so the store is unseeded and has no handles.
    const seeded = seedChatScenario(profile);
    expect(seeded.garments.instances).toEqual([]);
    const { scenario, state } = await settle({
      chat,
      scenario: seeded,
      // A model answering with proposals it could not have been shown: every handle
      // is unresolvable, so every one drops — the store is materialized, not mangled.
      archivist: ops([{ op: "roll", garment: "wren.shirt", part: "sleeve_left", degree: "slight" }]),
    });
    expect(state.lastMemoryTrace.garmentOperations[0]?.code).toBe("garment_op.garment_unresolved");
    // …and the lazy materialization still happened on this write, so the NEXT
    // exchange's prompt does carry handles.
    expect(scenario.garments.seeded).toBe(true);
    expect(wornGarmentDefinitionIds(scenario.garments, ACTOR())).toEqual([fixture.shirtId, fixture.jacketId]);
  });
});
