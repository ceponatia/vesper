import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { DiagnosticCollector } from "@/contracts/diagnostics";
import { degradedChatArchivist, type ChatArchivist } from "@/contracts/turns/chat-archivist";
import { switchScenePlace } from "@/contracts/turns/chat-scene-memory";
import { characterProfileSchema, type CharacterProfile } from "@/contracts/world/profile";
import {
  applyGarmentTransfers,
  garmentActorForCharacter,
  garmentsAtScenePlace,
  wornGarmentDefinitionIds,
} from "@/contracts/items/garment-store";
import { applyGarmentOperations } from "@/contracts/items/garment-presentation";
import {
  garmentConditionBand,
  garmentWorstConditionVector,
  integrateGarmentCondition,
} from "@/contracts/items/garment-condition";
import { garmentEffectiveCoverage } from "@/contracts/items/garment-effective-coverage";
import {
  emptyChatGarmentStore,
  pristineGarmentConditionState,
  type GarmentOperation,
} from "@/contracts/items/garment-instance";
import { exposedRegions } from "@/contracts/items/visibility";
import { newId } from "@/lib/ids";
import { toWornInputs } from "@/server/images";
import { characterChatMessages, characterChats, characters, chatParticipants, db, items, users } from "@/server/db";

/**
 * The chat garment store's persistence (clothing-state-graph.plan.md slice 2;
 * slice-0 audit ruling P + fixtures F13, F17).
 *
 * What only a database can prove: that the store rides `pre_exchange_scenario`
 * and a retake restores it EXACTLY (the whole reason it is a scenario field and
 * not a table), that lazy materialization happens on the write path, that a
 * scene locus outlives a scene move, and that a corrupt jsonb blob degrades to
 * the empty store without costing the turn.
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
import { garmentReadoutsFor } from "./chat-garments";
import { loadGarmentWardrobeItems, resolveChatWardrobe } from "./chat-wardrobe";

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
      `[chat-garments.int.test] skipping: database unreachable: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return false;
  } finally {
    clearTimeout(timer);
  }
}

const ready = await probe();
const fixture = { userId: "", characterId: "", jacketId: "", teeId: "", cardiganId: "" };
let profile: CharacterProfile = characterProfileSchema.parse({});

beforeAll(async () => {
  if (!ready) return;
  const stamp = Date.now();
  const [user] = await db()
    .insert(users)
    .values({ email: `chat-garments-int-${stamp}@test.local`, name: "Garments Int", role: "admin" })
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
  fixture.jacketId = await insertItem("denim jacket", {
    category: "outerwear",
    coverage: ["shoulders", "chest", "back", "waist", "upper_arms", "forearms", "wrists"],
    layer: 3,
  });
  fixture.teeId = await insertItem("white cotton tee", {
    category: "top",
    coverage: ["shoulders", "chest", "back", "waist", "upper_arms"],
    layer: 1,
  });
  fixture.cardiganId = await insertItem("grey wool cardigan", {
    category: "outerwear",
    coverage: ["shoulders", "chest", "back", "waist", "upper_arms"],
    layer: 2,
  });

  profile = characterProfileSchema.parse({
    outfits: [
      { id: "everyday", name: "Everyday", items: [fixture.jacketId, fixture.teeId] },
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

/** A fresh conversation with one participant and one prompting message. */
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

const ACTOR = () => garmentActorForCharacter(fixture.characterId);

async function edit(chatId: string, patch: Parameters<typeof editChatState>[0]["patch"]) {
  return editChatState({ chatId, characterId: fixture.characterId, ownerId: fixture.userId, profile, patch });
}

describe("materialization on the write path (audit ruling P.2)", () => {
  it("grows instances from the existing worn ids and projects the same ids back", async (t) => {
    if (!ready) return t.skip();
    const { chatId } = await newChat();
    // Before any write the store is untouched — a READ never materializes.
    const seeded = await loadChatScenario(chatId);
    expect(seeded?.garments.seeded).toBe(false);
    expect(seeded?.garments.instances).toEqual([]);

    // Any state write materializes (here: an unrelated edit).
    const { state } = await edit(chatId, { mindNote: "thinking" });
    const scenario = await loadChatScenario(chatId);
    expect(scenario?.garments.seeded).toBe(true);
    expect(scenario?.garments.instances).toHaveLength(2);
    // Behaviour is identical before and after: the projection IS the old list.
    expect(state.wornItemIds).toEqual([fixture.jacketId, fixture.teeId]);
    expect(scenario && wornGarmentDefinitionIds(scenario.garments, ACTOR())).toEqual([
      fixture.jacketId,
      fixture.teeId,
    ]);
    // Two different constructions ⇒ two snapshots; both real, neither a pointer.
    expect(Object.keys(scenario?.garments.blueprints ?? {})).toHaveLength(2);
    for (const instance of scenario?.garments.instances ?? []) {
      expect(scenario?.garments.blueprints[instance.blueprintHash]).toBeDefined();
    }
  });

  it("an equip removal is a locus change, not destruction — and re-equipping reuses the instance", async (t) => {
    if (!ready) return t.skip();
    const { chatId } = await newChat();
    await edit(chatId, { mindNote: "start" });
    const before = await loadChatScenario(chatId);
    const jacketInstanceId = before?.garments.instances.find((i) => i.definitionId === fixture.jacketId)?.id;
    expect(jacketInstanceId).toBeDefined();

    // The equip editor takes the jacket off.
    const { state: doffed } = await edit(chatId, { wornItemIds: [fixture.teeId] });
    expect(doffed.wornItemIds).toEqual([fixture.teeId]);
    const after = await loadChatScenario(chatId);
    const jacket = after?.garments.instances.find((i) => i.id === jacketInstanceId);
    expect(jacket?.locus).toEqual({ kind: "wardrobe", ownerId: ACTOR() });

    // Putting it back on is a transfer of the SAME instance, not a fresh mint.
    const { state: redressed } = await edit(chatId, { wornItemIds: [fixture.teeId, fixture.jacketId] });
    expect(redressed.wornItemIds).toEqual([fixture.teeId, fixture.jacketId]);
    const back = await loadChatScenario(chatId);
    expect(back?.garments.instances).toHaveLength(2);
    expect(back?.garments.instances.find((i) => i.definitionId === fixture.jacketId)?.id).toBe(jacketInstanceId);
  });

  it("an outfit preset compiles to transfers: kept, minted, wardrobed", async (t) => {
    if (!ready) return t.skip();
    const { chatId } = await newChat();
    await edit(chatId, { mindNote: "start" });
    const before = await loadChatScenario(chatId);
    const teeInstanceId = before?.garments.instances.find((i) => i.definitionId === fixture.teeId)?.id;

    // Switch to a preset that keeps the tee, drops the jacket, adds the cardigan.
    await edit(chatId, { wornItemIds: [fixture.teeId, fixture.cardiganId], outfitPresetId: "cozy" });
    const after = await loadChatScenario(chatId);
    expect(after && wornGarmentDefinitionIds(after.garments, ACTOR())).toEqual([fixture.teeId, fixture.cardiganId]);
    // The tee is the same instance — a preset change is not a free-text replacement.
    expect(after?.garments.instances.find((i) => i.definitionId === fixture.teeId)?.id).toBe(teeInstanceId);
    expect(after?.garments.instances.find((i) => i.definitionId === fixture.jacketId)?.locus).toEqual({
      kind: "wardrobe",
      ownerId: ACTOR(),
    });
    expect(after?.garments.instances).toHaveLength(3);
  });
});

describe("F13 — a retake restores the store exactly", () => {
  it("rolls the whole store back: instances, loci, blueprint map", async (t) => {
    if (!ready) return t.skip();
    const chat = await newChat();
    // Materialize, then move a garment somewhere only the store can express.
    await edit(chat.chatId, { mindNote: "start" });
    const materialized = await loadChatScenario(chat.chatId);
    expect(materialized).not.toBeNull();
    if (!materialized) return;
    const jacketId = materialized.garments.instances.find((i) => i.definitionId === fixture.jacketId)?.id ?? "";
    const anchorScenario: ChatScenario = {
      ...materialized,
      garments: applyGarmentTransfers(
        materialized.garments,
        [{ kind: "transfer", garmentId: jacketId, to: { kind: "scene", placeName: "the study", anchor: "over the desk chair" } }],
        { atMinutes: 40 },
      ).store,
    };
    await saveChatScenario(chat.chatId, anchorScenario);
    const anchorJson = JSON.stringify(anchorScenario.garments);

    // One exchange whose continuity leg re-dresses her.
    mock.archivist = {
      value: { ...degradedChatArchivist(), outfit: { description: "", exposed: false, removed: [], added: ["a wool cardigan"] } },
      degraded: false,
    };
    const preState = { ...seedChatState(profile), wornItemIds: [fixture.teeId] };
    await finalizeChatState({
      assistantMessageId: newId(),
      preExchangeState: preState,
      chatId: chat.chatId,
      characterId: fixture.characterId,
      ownerId: fixture.userId,
      memoryGroupId: chat.memoryGroupId,
      promptMessageId: chat.messageId,
      profile,
      characterName: "Wren",
      playerName: "You",
      driftedState: preState,
      now: new Date(),
      exchange: { player: "Hi", assistant: "Hello." },
      scenario: anchorScenario,
      preExchangeScenario: anchorScenario,
      sink: new DiagnosticCollector(),
    });

    // The live store moved…
    const live = await loadChatScenario(chat.chatId);
    expect(JSON.stringify(live?.garments)).not.toBe(anchorJson);
    expect(live && wornGarmentDefinitionIds(live.garments, ACTOR())).toEqual([fixture.teeId, fixture.cardiganId]);

    // …and "another take" restores it byte-for-byte, with no new machinery: the
    // store rides `pre_exchange_scenario` like every other scenario field.
    const anchor = await loadPreExchangeScenario(chat.chatId);
    expect(anchor).not.toBeNull();
    if (!anchor) return;
    const rolledBack = rollbackScenario(anchor, live);
    expect(JSON.stringify(rolledBack.garments)).toBe(anchorJson);
    // Including the jacket still lying over the desk chair.
    expect(garmentsAtScenePlace(rolledBack.garments, "the study").map((i) => i.id)).toEqual([jacketId]);
  });
});

describe("R3 — a garment left at a place stays there across scene moves", () => {
  it("is still on the chair when the party comes back", async (t) => {
    if (!ready) return t.skip();
    const { chatId } = await newChat();
    await edit(chatId, { mindNote: "start" });
    const start = await loadChatScenario(chatId);
    expect(start).not.toBeNull();
    if (!start) return;
    const jacketId = start.garments.instances.find((i) => i.definitionId === fixture.jacketId)?.id ?? "";

    // In the study, she takes the jacket off and drops it over the chair.
    const inStudy: ChatScenario = {
      ...start,
      sceneMemory: switchScenePlace(start.sceneMemory, "the study"),
      garments: applyGarmentTransfers(
        start.garments,
        [{ kind: "transfer", garmentId: jacketId, to: { kind: "scene", placeName: "the study", anchor: "over the desk chair" } }],
        { atMinutes: 30 },
      ).store,
    };
    await saveChatScenario(chatId, inStudy);
    // It leaves the worn projection immediately — no coverage, still located.
    const afterDrop = await loadChatScenario(chatId);
    expect(afterDrop && wornGarmentDefinitionIds(afterDrop.garments, ACTOR())).toEqual([fixture.teeId]);

    // The scene moves on — twice — and the garment does not follow.
    let moved = afterDrop;
    for (const place of ["the kitchen", "the garden"]) {
      expect(moved).not.toBeNull();
      if (!moved) return;
      await saveChatScenario(chatId, { ...moved, sceneMemory: switchScenePlace(moved.sceneMemory, place) });
      moved = await loadChatScenario(chatId);
      expect(moved && garmentsAtScenePlace(moved.garments, "the study").map((i) => i.id)).toEqual([jacketId]);
      expect(moved && garmentsAtScenePlace(moved.garments, place)).toEqual([]);
    }

    // Back in the study: the jacket is where she left it, anchor and all.
    expect(moved).not.toBeNull();
    if (!moved) return;
    await saveChatScenario(chatId, { ...moved, sceneMemory: switchScenePlace(moved.sceneMemory, "the study") });
    const returned = await loadChatScenario(chatId);
    const found = returned ? garmentsAtScenePlace(returned.garments, "the study") : [];
    expect(found.map((i) => i.id)).toEqual([jacketId]);
    expect(found[0]?.locus).toEqual({ kind: "scene", placeName: "the study", anchor: "over the desk chair" });
    // …and it is still absent from the worn projection, so it contributes nothing.
    expect(returned && wornGarmentDefinitionIds(returned.garments, ACTOR())).toEqual([fixture.teeId]);
  });
});

describe("F17 — a corrupt store jsonb degrades without costing the turn", () => {
  it("parses to the empty store with a diagnostic, and the next write re-materializes", async (t) => {
    if (!ready) return t.skip();
    const { chatId } = await newChat();
    await edit(chatId, { mindNote: "start" });
    await db().execute(sql`update ${characterChats} set garments = '"not a store"'::jsonb where id = ${chatId}`);

    const sink = new DiagnosticCollector();
    const corrupt = await loadChatScenario(chatId, sink);
    expect(corrupt?.garments.seeded).toBe(false);
    expect(corrupt?.garments.instances).toEqual([]);
    const parseFailure = sink.items.find((d) => d.code === "parse.boundary_failed");
    expect(parseFailure?.path).toBe("character_chats.garments");

    // The read seam still has the projection column to fall back on, so the
    // wardrobe is unchanged and the next write rebuilds the store.
    const stored = await loadChatState(chatId, fixture.characterId);
    expect(stored?.wornItemIds).toEqual([fixture.jacketId, fixture.teeId]);
    const { state } = await edit(chatId, { mindNote: "recovered" });
    expect(state.wornItemIds).toEqual([fixture.jacketId, fixture.teeId]);
    const healed = await loadChatScenario(chatId);
    expect(healed?.garments.seeded).toBe(true);
    expect(healed && wornGarmentDefinitionIds(healed.garments, ACTOR())).toEqual([
      fixture.jacketId,
      fixture.teeId,
    ]);
  });
});

describe("the scenario seed", () => {
  it("starts a brand-new conversation with an empty, unseeded store", (t) => {
    if (!ready) return t.skip();
    const scenario = seedChatScenario(profile);
    expect(scenario.garments).toEqual({ seeded: false, blueprints: {}, instances: [] });
  });
});

/**
 * The presentation graph end-to-end (clothing-state-graph.plan.md slice 3).
 *
 * What only a database can prove: that the state route's write path applies typed
 * presentation operations and PERSISTS them, that the worn-id projection is
 * unmoved by an arrangement change, that a retake restores the arrangement
 * exactly, and that the narrator phrase and the exposure gate come out of one
 * shared read of that same state.
 */
describe("slice 3 — presentation operations through the state route's write path", () => {
  /** Materialize the default outfit and hand back the jacket instance id. */
  async function dressed(): Promise<{ chatId: string; jacket: string }> {
    const { chatId } = await newChat();
    await edit(chatId, { mindNote: "start" });
    const scenario = await loadChatScenario(chatId);
    if (!scenario) throw new Error("no scenario");
    const jacket = scenario.garments.instances.find((i) => i.definitionId === fixture.jacketId)?.id ?? "";
    return { chatId, jacket };
  }

  /** Four of the outerwear template's five fasteners — 0.8, past both closure thresholds. */
  const openPlacket = (jacket: string): GarmentOperation => ({
    kind: "set_closure",
    garmentId: jacket,
    partId: "front_panel",
    state: { kind: "fastener_series", openFastenerIndexes: [0, 1, 2, 3] },
  });

  async function wardrobeOf(chatId: string, scenario: ChatScenario) {
    const state = await loadChatState(chatId, fixture.characterId);
    if (!state) throw new Error("no chat state");
    return resolveChatWardrobe(
      { ...state, garments: scenario.garments, garmentActorId: ACTOR() },
      fixture.userId,
      profile,
    );
  }

  it("applies + persists a closure, leaves the worn projection alone, and reads back as controls", async (t) => {
    if (!ready) return t.skip();
    const { chatId, jacket } = await dressed();
    const { state } = await edit(chatId, { garmentOperations: [openPlacket(jacket)] });
    // An arrangement change is not a wardrobe change — the projection is unmoved.
    expect(state.wornItemIds).toEqual([fixture.jacketId, fixture.teeId]);

    const stored = await loadChatScenario(chatId);
    const instance = stored?.garments.instances.find((i) => i.id === jacket);
    expect(instance?.presentation.closure.front_panel).toEqual({
      kind: "fastener_series",
      openFastenerIndexes: [0, 1, 2, 3],
    });
    expect(instance?.lastChange.kind).toBe("presentation");

    // …and the sheet's readout reflects it, in bands and location ids only.
    const readouts = garmentReadoutsFor(stored?.garments ?? emptyChatGarmentStore(), ACTOR());
    const placket = readouts.find((r) => r.garmentId === jacket)?.controls.find((c) => c.partId === "front_panel");
    expect(placket?.fastenerCount).toBe(5);
    expect(placket?.openFasteners).toEqual([0, 1, 2, 3]);
    expect(placket?.dropped).toEqual(expect.arrayContaining(["chest", "waist"]));
  });

  it("drops an illegal operation with its stable code and persists nothing", async (t) => {
    if (!ready) return t.skip();
    const { chatId, jacket } = await dressed();
    const sink = new DiagnosticCollector();
    await editChatState({
      chatId,
      characterId: fixture.characterId,
      ownerId: fixture.userId,
      profile,
      // A front panel is a closure, not a sleeve — a hallucinated handle, dropped.
      patch: { garmentOperations: [{ kind: "set_roll", garmentId: jacket, partId: "front_panel", degree: "substantial" }] },
      sink,
    });
    expect(sink.items.map((d) => d.code)).toContain("garment_op.channel_unbound");
    const stored = await loadChatScenario(chatId);
    expect(stored?.garments.instances.find((i) => i.id === jacket)?.presentation).toEqual({
      closure: {},
      roll: {},
      tuck: {},
      displacement: [],
    });
  });

  it("the narrator phrase and the exposure gate agree — one shared read", async (t) => {
    if (!ready) return t.skip();
    const { chatId, jacket } = await dressed();
    const closed = await loadChatScenario(chatId);
    if (!closed) throw new Error("no scenario");
    const closedWardrobe = await wardrobeOf(chatId, closed);
    // Closed: the jacket buries the tee and the torso is covered.
    expect(closedWardrobe.garments).toContain("denim jacket");
    expect(closedWardrobe.garments).not.toContain("white cotton tee");
    expect(closedWardrobe.exposure.torso).toBe("covered");

    await edit(chatId, { garmentOperations: [openPlacket(jacket)] });
    const opened = await loadChatScenario(chatId);
    if (!opened) throw new Error("no scenario");
    const openedWardrobe = await wardrobeOf(chatId, opened);
    // Open: the tee is the outermost cover at the chest, so the narrator may say
    // it — and the exposure gate still reads covered, because it is.
    expect(openedWardrobe.garments).toContain("white cotton tee");
    expect(openedWardrobe.exposure.torso).toBe("covered");
    // Unchanged by the placket either way — this fixture wears nothing below the
    // waist, so the pelvis was already bare and the closure law never touches it.
    expect(openedWardrobe.exposure.pelvis).toBe(closedWardrobe.exposure.pelvis);

    // The image path consumes the SAME rows: identical coverage, identical exposure.
    const items = await loadGarmentWardrobeItems(opened.garments, ACTOR(), fixture.userId);
    expect(exposedRegions(toWornInputs(items))).toEqual(openedWardrobe.exposure);
    expect(items.find((item) => item.garmentId === jacket)?.coverage).not.toContain("chest");
  });

  it("a retake restores the arrangement exactly", async (t) => {
    if (!ready) return t.skip();
    const chat = await newChat();
    await edit(chat.chatId, { mindNote: "start" });
    const materialized = await loadChatScenario(chat.chatId);
    if (!materialized) throw new Error("no scenario");
    const jacket = materialized.garments.instances.find((i) => i.definitionId === fixture.jacketId)?.id ?? "";
    const anchorScenario: ChatScenario = {
      ...materialized,
      garments: applyGarmentOperations(
        materialized.garments,
        [
          {
            kind: "set_closure",
            garmentId: jacket,
            partId: "front_panel",
            state: { kind: "fastener_series", openFastenerIndexes: [0, 1] },
          },
          { kind: "set_roll", garmentId: jacket, partId: "sleeve_left", degree: "substantial" },
        ],
        { atMinutes: 20 },
      ).store,
    };
    await saveChatScenario(chat.chatId, anchorScenario);
    const anchorPresentation = anchorScenario.garments.instances.find((i) => i.id === jacket)?.presentation;
    expect(anchorPresentation?.roll.sleeve_left).toBeGreaterThan(0);

    // One exchange whose continuity leg re-dresses her.
    mock.archivist = {
      value: { ...degradedChatArchivist(), outfit: { description: "", exposed: false, removed: [], added: ["a wool cardigan"] } },
      degraded: false,
    };
    const preState = { ...seedChatState(profile), wornItemIds: [fixture.teeId] };
    await finalizeChatState({
      assistantMessageId: newId(),
      preExchangeState: preState,
      chatId: chat.chatId,
      characterId: fixture.characterId,
      ownerId: fixture.userId,
      memoryGroupId: chat.memoryGroupId,
      promptMessageId: chat.messageId,
      profile,
      characterName: "Wren",
      playerName: "You",
      driftedState: preState,
      now: new Date(),
      exchange: { player: "Hi", assistant: "Hello." },
      scenario: anchorScenario,
      preExchangeScenario: anchorScenario,
      sink: new DiagnosticCollector(),
    });

    const live = await loadChatScenario(chat.chatId);
    const anchor = await loadPreExchangeScenario(chat.chatId);
    expect(live).not.toBeNull();
    expect(anchor).not.toBeNull();
    if (!live || !anchor) return;
    const rolledBack = rollbackScenario(anchor, live);
    const restored = rolledBack.garments.instances.find((i) => i.id === jacket);
    expect(restored?.presentation).toEqual(anchorPresentation);
    // …and the derived coverage that arrangement produces comes back with it.
    const blueprint = rolledBack.garments.blueprints[restored?.blueprintHash ?? ""];
    if (!restored || !blueprint) throw new Error("restored garment lost its blueprint");
    const effective = garmentEffectiveCoverage(restored, blueprint);
    expect(effective.parts.find((p) => p.partId === "sleeve_left")?.covers).toEqual(["upper_arms"]);
    expect(effective.parts.find((p) => p.partId === "sleeve_right")?.covers).toEqual(
      expect.arrayContaining(["forearms", "wrists"]),
    );
  });
});

/**
 * The condition gradients end-to-end (clothing-state-graph.plan.md slice 4).
 *
 * What only a database can prove: that the state route's write path applies typed
 * CONDITION operations and persists the whole gradient state — base vector,
 * regional overrides, deposits, damage marks and the integration stamp — that the
 * readout the sheet consumes carries it back as bands, and that a retake restores
 * it byte-identically out of the same `pre_exchange_scenario` blob the rest of
 * the store already rides (fixture F13, extended).
 */
describe("slice 4 — condition operations through the state route's write path", () => {
  async function dressed(): Promise<{ chatId: string; jacket: string }> {
    const { chatId } = await newChat();
    await edit(chatId, { mindNote: "start" });
    const scenario = await loadChatScenario(chatId);
    if (!scenario) throw new Error("no scenario");
    const jacket = scenario.garments.instances.find((i) => i.definitionId === fixture.jacketId)?.id ?? "";
    return { chatId, jacket };
  }

  /** Caught in the rain, then mud at the hem — the acceptance pair's setup. */
  const soaking = (jacket: string): GarmentOperation[] => [
    {
      kind: "apply_condition",
      garmentId: jacket,
      partIds: [],
      channel: "wetness",
      change: { direction: "increase", degree: "substantial" },
    },
    { kind: "deposit", garmentId: jacket, partIds: ["hem"], depositKind: "mud", degree: "substantial" },
  ];

  it("persists the whole gradient state and reads it back as bands", async (t) => {
    if (!ready) return t.skip();
    const { chatId, jacket } = await dressed();
    const { state } = await edit(chatId, { garmentOperations: soaking(jacket) });
    // Getting wet is not a wardrobe change — the projection is unmoved.
    expect(state.wornItemIds).toEqual([fixture.jacketId, fixture.teeId]);

    const stored = await loadChatScenario(chatId);
    const instance = stored?.garments.instances.find((i) => i.id === jacket);
    expect(instance?.condition.base.wetness).toBeGreaterThan(0);
    expect(instance?.condition.regionOverrides.hem?.cleanliness).toBe(2_500);
    expect(instance?.condition.deposits).toHaveLength(1);
    expect(instance?.condition.deposits[0]).toMatchObject({ kind: "mud", partIds: ["hem"] });
    expect(instance?.lastChange.kind).toBe("condition");

    // The sheet's readout carries it — bands and part labels only, no fixed point.
    const readouts = garmentReadoutsFor(stored?.garments ?? emptyChatGarmentStore(), ACTOR(), 0);
    const readout = readouts.find((r) => r.garmentId === jacket);
    expect(readout?.condition.wetness).toBe("wet");
    expect(readout?.condition.cleanliness).toBe("soiled");
    expect(readout?.notableChannels).toEqual(expect.arrayContaining(["wetness", "cleanliness"]));
    expect(readout?.deposits[0]).toMatchObject({ kind: "mud", intensity: "substantial", freshness: "fresh" });
    expect(JSON.stringify(readout)).not.toContain("2500");
  });

  it("a muddy hem survives whole-garment drying and is removed by regional cleaning", async (t) => {
    if (!ready) return t.skip();
    const { chatId, jacket } = await dressed();
    await edit(chatId, { garmentOperations: soaking(jacket) });
    const wet = await loadChatScenario(chatId);
    const stored = wet?.garments.instances.find((i) => i.id === jacket);
    if (!wet || !stored) throw new Error("no garment");
    const blueprint = wet.garments.blueprints[stored.blueprintHash];
    if (!blueprint) throw new Error("no blueprint");

    // A story day later, with no wetting source, the jacket has dried out — denim
    // is the slowest-drying material in the registry, and the mud has not moved.
    const dried = integrateGarmentCondition(stored.condition, blueprint, 1_440);
    expect(dried.base.wetness).toBeLessThan(stored.condition.base.wetness);
    expect(garmentConditionBand("wetness", dried.base.wetness)).toBe("dry");
    expect(dried.deposits).toHaveLength(1);
    expect(dried.deposits[0]?.intensity).toBe(stored.condition.deposits[0]?.intensity);
    expect(garmentConditionBand("cleanliness", garmentWorstConditionVector(dried).cleanliness)).toBe("soiled");

    // Cleaning that one part takes it out, and touches nothing else.
    await edit(chatId, {
      garmentOperations: [{ kind: "clean", garmentId: jacket, partIds: ["hem"], target: "clean" }],
    });
    const cleaned = await loadChatScenario(chatId);
    const after = cleaned?.garments.instances.find((i) => i.id === jacket);
    expect(after?.condition.deposits).toEqual([]);
    expect(after?.condition.base.cleanliness).toBe(stored.condition.base.cleanliness);
    const readout = garmentReadoutsFor(cleaned?.garments ?? emptyChatGarmentStore(), ACTOR(), 0).find(
      (r) => r.garmentId === jacket,
    );
    expect(readout?.condition.cleanliness).toBe("clean");
    expect(readout?.deposits).toEqual([]);
  });

  it("drops an illegal condition operation with its stable code and persists nothing", async (t) => {
    if (!ready) return t.skip();
    const { chatId, jacket } = await dressed();
    const sink = new DiagnosticCollector();
    await editChatState({
      chatId,
      characterId: fixture.characterId,
      ownerId: fixture.userId,
      profile,
      patch: {
        garmentOperations: [
          // A jacket has no "knee", and no mark with that id exists.
          { kind: "deposit", garmentId: jacket, partIds: ["knee"], depositKind: "mud", degree: "moderate" },
          { kind: "repair", garmentId: jacket, markIds: ["mark:ghost"] },
        ],
      },
      sink,
    });
    expect(sink.items.map((d) => d.code)).toEqual(
      expect.arrayContaining(["garment_op.part_unresolved", "garment_op.mark_unresolved"]),
    );
    const stored = await loadChatScenario(chatId);
    expect(stored?.garments.instances.find((i) => i.id === jacket)?.condition).toEqual(
      pristineGarmentConditionState(),
    );
  });

  it("a retake restores the gradients byte-identically", async (t) => {
    if (!ready) return t.skip();
    const chat = await newChat();
    await edit(chat.chatId, { mindNote: "start" });
    const materialized = await loadChatScenario(chat.chatId);
    if (!materialized) throw new Error("no scenario");
    const jacket = materialized.garments.instances.find((i) => i.definitionId === fixture.jacketId)?.id ?? "";
    const anchorScenario: ChatScenario = {
      ...materialized,
      garments: applyGarmentOperations(
        materialized.garments,
        [
          ...soaking(jacket),
          { kind: "damage", garmentId: jacket, partId: "cuff_left", damageKind: "tear", degree: "moderate" },
        ],
        { atMinutes: 25 },
      ).store,
    };
    await saveChatScenario(chat.chatId, anchorScenario);
    const anchorJson = JSON.stringify(anchorScenario.garments.instances.find((i) => i.id === jacket)?.condition);
    expect(anchorJson).toContain("mud");
    expect(anchorJson).toContain("tear");

    mock.archivist = {
      value: { ...degradedChatArchivist(), outfit: { description: "", exposed: false, removed: [], added: ["a wool cardigan"] } },
      degraded: false,
    };
    const preState = { ...seedChatState(profile), wornItemIds: [fixture.teeId] };
    await finalizeChatState({
      assistantMessageId: newId(),
      preExchangeState: preState,
      chatId: chat.chatId,
      characterId: fixture.characterId,
      ownerId: fixture.userId,
      memoryGroupId: chat.memoryGroupId,
      promptMessageId: chat.messageId,
      profile,
      characterName: "Wren",
      playerName: "You",
      driftedState: preState,
      now: new Date(),
      exchange: { player: "Hi", assistant: "Hello." },
      scenario: anchorScenario,
      preExchangeScenario: anchorScenario,
      sink: new DiagnosticCollector(),
    });

    const live = await loadChatScenario(chat.chatId);
    const anchor = await loadPreExchangeScenario(chat.chatId);
    if (!live || !anchor) throw new Error("no rollback anchor");
    const rolledBack = rollbackScenario(anchor, live);
    const restored = rolledBack.garments.instances.find((i) => i.id === jacket);
    expect(JSON.stringify(restored?.condition)).toBe(anchorJson);
    // …and the restored state integrates forward to exactly what it would have.
    const blueprint = rolledBack.garments.blueprints[restored?.blueprintHash ?? ""];
    const original = anchorScenario.garments.instances.find((i) => i.id === jacket);
    if (!restored || !blueprint || !original) throw new Error("restored garment lost its blueprint");
    expect(integrateGarmentCondition(restored.condition, blueprint, 600)).toEqual(
      integrateGarmentCondition(original.condition, blueprint, 600),
    );
  });
});
