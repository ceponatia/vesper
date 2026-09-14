import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { ChatArchivist } from "@/contracts/turns/chat-archivist";
import { switchScenePlace } from "@/contracts/turns/chat-scene-memory";
import {
  garmentActorForCharacter,
  garmentsAtScenePlace,
  syncWornGarments,
  wornGarmentDefinitionIds,
  type GarmentSeed,
} from "@/contracts/items/garment-store";

/**
 * Grounded continuity extraction, end to end.
 *
 * What only a database can prove: that a faked continuity reply's typed
 * proposals reach the persisted store AND its worn-id projections in ONE write,
 * that an `introduce` mints a really-located instance, that a rejected proposal
 * lands in both the diagnostics and the admin inspector's trace, that a reply
 * carrying only the OLD free-text grammar still folds through the legacy bridge
 * with its own diagnostic — and that "another take" discards an exchange's
 * garment operations whole, because the store rides `pre_exchange_scenario`.
 */

const mock = vi.hoisted(() => ({ archivist: { value: null as ChatArchivist | null, degraded: false } }));

vi.mock("./chat-memory", async () => {
  const { chatMemoryMockModule } = await import("../test-support/chat-archivist-mock");
  return chatMemoryMockModule(mock);
});

import { editChatState } from "./chat-state/edit";
import { loadChatScenario, saveChatScenario } from "./chat-state/store";
import { loadPreExchangeScenario, rollbackScenario } from "./chat-state/snapshots";
import { seedChatScenario, type ChatScenario } from "./chat-state";
import type { FinalizeChatStateInput } from "./chat-state/finalize-types";
import {
  chatArchivist,
  dropChatFixture,
  emptyChatFixture,
  GARMENT_SEEDS,
  itemId,
  newChat,
  probeIntegrationDb,
  seedChatFixture,
  settleChatExchange,
  withOps,
  type ChatFixture,
  type ChatSeat,
} from "@/server/test-support";

const ready = await probeIntegrationDb("chat-garment-ops.int.test", "character_chats");

let fixture: ChatFixture = emptyChatFixture();

/** The library definition ids the store's instances point back at. */
const shirtDef = () => itemId(fixture, "cottonShirt");
const jacketDef = () => itemId(fixture, "denimJacket");
const cardiganDef = () => itemId(fixture, "woolCardigan");

beforeAll(async () => {
  if (!ready) return;
  fixture = await seedChatFixture({
    slug: "chat-garment-ops-int",
    userName: "Garment Ops Int",
    garments: [GARMENT_SEEDS.cottonShirt, GARMENT_SEEDS.denimJacket, GARMENT_SEEDS.woolCardigan],
    outfits: [
      { id: "everyday", name: "Everyday", items: ["cottonShirt", "denimJacket"] },
      // The cardigan is in the wardrobe POOL but not worn — what the legacy
      // name-matching bridge resolves an `added` phrase against.
      { id: "cozy", name: "Cozy", items: ["woolCardigan"] },
    ],
  });
});

afterAll(async () => {
  await dropChatFixture(fixture);
});

const ACTOR = () => garmentActorForCharacter(fixture.characterId);

/**
 * A conversation whose wardrobe is already MODELLED and standing in a named
 * place — the state in which the continuity prompt actually carries handles.
 * Handles are then `wren.shirt` / `wren.jacket` by construction.
 */
async function dressedChat(): Promise<ChatSeat & { scenario: ChatScenario }> {
  const chat = await newChat(fixture);
  await editChatState({
    chatId: chat.chatId,
    characterId: fixture.characterId,
    ownerId: fixture.userId,
    profile: fixture.profile,
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
  chat: ChatSeat;
  scenario: ChatScenario;
  archivist: Partial<ChatArchivist>;
  wornItemIds?: readonly string[];
  roster?: FinalizeChatStateInput["roster"];
}) {
  mock.archivist = { value: chatArchivist(args.archivist), degraded: false };
  const { scenario, state, sink, outcome } = await settleChatExchange(fixture, {
    chat: args.chat,
    scenario: args.scenario,
    wornItemIds: args.wornItemIds ?? [shirtDef(), jacketDef()],
    ...(args.roster === undefined ? {} : { roster: args.roster }),
  });
  if (!scenario || !state) throw new Error("chat rows missing after finalize");
  return { scenario, state, sink, outcome };
}

describe.runIf(ready)("the grounded lane mutates the store and its projections in one write", () => {
  it("applies typed proposals over the enumerated handles", async () => {
    const chat = await dressedChat();
    const { scenario, state, sink } = await settle({
      chat,
      scenario: chat.scenario,
      archivist: withOps([
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
    expect(left.map((i) => i.definitionId)).toEqual([jacketDef()]);
    expect(left[0]?.locus).toEqual({ kind: "scene", placeName: "the study", anchor: "over the desk chair" });
    expect(wornGarmentDefinitionIds(scenario.garments, ACTOR())).toEqual([shirtDef()]);
    // The projection column is re-derived from the store in the SAME write.
    expect(state.wornItemIds).toEqual([shirtDef()]);

    const shirt = scenario.garments.instances.find((i) => i.definitionId === shirtDef());
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

  it("R2 — `introduce` mints a real, located instance with no library provenance", async () => {
    const chat = await dressedChat();
    const { scenario, state } = await settle({
      chat,
      scenario: chat.scenario,
      archivist: withOps([
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
    expect(state.wornItemIds).toEqual([shirtDef(), jacketDef()]);
    expect(state.lastMemoryTrace.garmentOperations[0]).toMatchObject({
      op: "introduce",
      garment: "wren.hoodie",
      outcome: "applied",
    });
  });

  it("a rejected proposal lands in the diagnostics AND the inspector trace, leaving the store alone", async () => {
    const chat = await dressedChat();
    const before = JSON.stringify(chat.scenario.garments);
    const { scenario, state, sink } = await settle({
      chat,
      scenario: chat.scenario,
      archivist: withOps([
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

describe.runIf(ready)("the legacy free-text bridge", () => {
  it("still folds an outfit-only reply, with one diagnostic marking its use", async () => {
    const chat = await dressedChat();
    const { scenario, state, sink } = await settle({
      chat,
      scenario: chat.scenario,
      archivist: {
        outfit: { description: "", changeEvidence: "", exposed: false, removed: ["her jacket"], added: ["a wool cardigan"] },
      },
    });

    expect(sink.items.filter((d) => d.code === "chat_garments.legacy_outfit_bridge")).toHaveLength(1);
    expect(state.lastMemoryTrace.garmentLane).toBe("legacy");
    expect(state.lastMemoryTrace.garmentOperations).toEqual([]);
    // Unchanged behaviour: the name matcher still swapped the pieces.
    expect(wornGarmentDefinitionIds(scenario.garments, ACTOR())).toEqual([shirtDef(), cardiganDef()]);
    expect(state.wornItemIds).toEqual([shirtDef(), cardiganDef()]);
  });

  it("never runs alongside the grounded lane — operations win outright", async () => {
    const chat = await dressedChat();
    const { scenario, state, sink } = await settle({
      chat,
      scenario: chat.scenario,
      archivist: {
        ...withOps([{ op: "move", garment: "wren.jacket", to: "put_away" }]),
        // A model that answered in BOTH grammars: the free text is ignored whole.
        outfit: { description: "", changeEvidence: "", exposed: false, removed: [], added: ["a wool cardigan"] },
      },
    });

    expect(sink.items.map((d) => d.code)).not.toContain("chat_garments.legacy_outfit_bridge");
    expect(state.lastMemoryTrace.garmentLane).toBe("operations");
    // The cardigan was never added; only the operation landed.
    expect(wornGarmentDefinitionIds(scenario.garments, ACTOR())).toEqual([shirtDef()]);
    expect(scenario.garments.instances.some((i) => i.definitionId === cardiganDef())).toBe(false);
  });

  it("no proposals and no free text ⇒ neither path runs", async () => {
    const chat = await dressedChat();
    const before = JSON.stringify(chat.scenario.garments);
    const { scenario, state, sink } = await settle({ chat, scenario: chat.scenario, archivist: {} });
    expect(JSON.stringify(scenario.garments)).toBe(before);
    expect(state.lastMemoryTrace.garmentLane).toBe("none");
    expect(sink.items.map((d) => d.code)).not.toContain("chat_garments.legacy_outfit_bridge");
  });
});

describe.runIf(ready)("rollback — a retake discards the exchange's garment operations entirely", () => {
  it("restores the pre-exchange store byte-for-byte", async () => {
    const chat = await dressedChat();
    const anchorJson = JSON.stringify(chat.scenario.garments);

    const { scenario, state } = await settle({
      chat,
      scenario: chat.scenario,
      archivist: withOps([
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

describe.runIf(ready)("an unmodelled chat never arms the grounded lane", () => {
  it("seeds through the legacy bridge on the first exchange, then has handles", async () => {
    const chat = await newChat(fixture);
    // Nothing has written state yet, so the store is unseeded and has no handles.
    const seeded = seedChatScenario(fixture.profile);
    expect(seeded.garments.instances).toEqual([]);
    const { scenario, state } = await settle({
      chat,
      scenario: seeded,
      // A model answering with proposals it could not have been shown: every handle
      // is unresolvable, so every one drops — the store is materialized, not mangled.
      archivist: withOps([{ op: "roll", garment: "wren.shirt", part: "sleeve_left", degree: "slight" }]),
    });
    expect(state.lastMemoryTrace.garmentOperations[0]?.code).toBe("garment_op.garment_unresolved");
    // …and the lazy materialization still happened on this write, so the NEXT
    // exchange's prompt does carry handles.
    expect(scenario.garments.seeded).toBe(true);
    expect(wornGarmentDefinitionIds(scenario.garments, ACTOR())).toEqual([shirtDef(), jacketDef()]);
  });
});

describe.runIf(ready)("the ensemble roster shares the handle table (design #298)", () => {
  /**
   * A synthetic present member — no character row of her own, because
   * `finalizeChatState` never loads one for a roster entry: the wardrobe fold
   * reads only the id/name/wornItemIds the caller hands it.
   */
  const MARA_ID = "chat-garment-ops-int-mara";
  const MARA_ACTOR = () => garmentActorForCharacter(MARA_ID);
  const MARA_SCARF_DEF = "def-mara-scarf";
  // A SECOND worn garment: moving the scarf to a scene locus (nobody's) must
  // not leave Mara owning zero instances, or `actorHasGarmentInstances` reads
  // her as unmodelled again and `garmentProjectionOr` silently falls back to
  // the roster's PRE-exchange list instead of the store's real projection.
  const MARA_SHIRT_DEF = "def-mara-shirt";

  /**
   * `dressedChat()`, plus Mara already modelled and wearing `wornDefinitionIds`
   * (a scarf + a shirt by default; pass `[MARA_SCARF_DEF]` for the case where
   * her LAST instance can leave her actor slice).
   */
  async function ensembleChat(
    wornDefinitionIds: readonly string[] = [MARA_SCARF_DEF, MARA_SHIRT_DEF],
  ): Promise<ChatSeat & { scenario: ChatScenario }> {
    const chat = await dressedChat();
    let n = 0;
    const mintId = () => `mara-int-${(n += 1)}`;
    const seeds = new Map<string, GarmentSeed>([
      [MARA_SCARF_DEF, { definitionId: MARA_SCARF_DEF, name: "a green scarf", categoryId: "top", coverage: ["shoulders", "chest"] }],
      [MARA_SHIRT_DEF, { definitionId: MARA_SHIRT_DEF, name: "a linen shirt", categoryId: "top", coverage: ["shoulders", "chest", "back"] }],
    ]);
    const garments = syncWornGarments({
      store: chat.scenario.garments,
      actorId: MARA_ACTOR(),
      wornDefinitionIds: [...wornDefinitionIds],
      seeds,
      mintId,
      atMinutes: chat.scenario.clockMinutes,
    });
    const scenario: ChatScenario = { ...chat.scenario, garments };
    await saveChatScenario(chat.chatId, scenario);
    return { ...chat, scenario };
  }

  const rosterWithMara = (maraWornItemIds: readonly string[]): FinalizeChatStateInput["roster"] => [
    {
      characterId: fixture.characterId,
      name: fixture.characterName,
      presence: "present",
      wornItemIds: [shirtDef(), jacketDef()],
    },
    { characterId: MARA_ID, name: "Mara", presence: "present", wornItemIds: maraWornItemIds },
  ];

  it("an op on the member's enumerated handle moves HER garment, leaves the primary's untouched, and reports the projection", async () => {
    const chat = await ensembleChat();
    const { scenario, state, sink, outcome } = await settle({
      chat,
      scenario: chat.scenario,
      roster: rosterWithMara([MARA_SCARF_DEF, MARA_SHIRT_DEF]),
      archivist: withOps([{ op: "move", garment: "mara.scarf", to: "left_here", anchor: "on the desk" }]),
    });

    // The scarf is located at the SAME place the enumeration used, not destroyed.
    const left = garmentsAtScenePlace(scenario.garments, "the study");
    expect(left.map((i) => i.name)).toEqual(["a green scarf"]);
    // The shirt survives worn — Mara keeps a worn instance, so the projection
    // below reads the STORE, not a stale "unmodelled" fallback.
    expect(wornGarmentDefinitionIds(scenario.garments, MARA_ACTOR())).toEqual([MARA_SHIRT_DEF]);
    // The primary's own wardrobe never moved — one handle, one actor.
    expect(wornGarmentDefinitionIds(scenario.garments, ACTOR())).toEqual([shirtDef(), jacketDef()]);
    expect(state.wornItemIds).toEqual([shirtDef(), jacketDef()]);

    expect(sink.items.map((d) => d.code)).not.toContain("chat_garments.legacy_outfit_bridge");
    expect(outcome.ensembleWardrobe.lane).toBe("operations");
    expect(outcome.ensembleWardrobe.enumeratedCharacterIds).toContain(MARA_ID);
    // Her worn projection re-derives from the store — the shirt she still
    // wears, not the scarf the op moved away.
    expect(outcome.ensembleWardrobe.wornItemIds[MARA_ID]).toEqual([MARA_SHIRT_DEF]);
  });

  it("reports the PRE-EXCHANGE roster list, not an empty one, when the member's last instance leaves her actor slice", async () => {
    // Mara owns exactly ONE instance this time, and the op moves it to a scene
    // locus — which belongs to nobody, so `actorHasGarmentInstances` reads her
    // as unmodelled again and `garmentProjectionOr` takes its documented
    // fallback: the caller's list, which here is the roster's PRE-exchange
    // worn ids.
    const chat = await ensembleChat([MARA_SCARF_DEF]);
    const { scenario, outcome } = await settle({
      chat,
      scenario: chat.scenario,
      roster: rosterWithMara([MARA_SCARF_DEF]),
      archivist: withOps([{ op: "move", garment: "mara.scarf", to: "left_here", anchor: "on the desk" }]),
    });

    // The store is unambiguous: the scarf is on the desk and Mara wears nothing.
    expect(garmentsAtScenePlace(scenario.garments, "the study").map((i) => i.name)).toEqual(["a green scarf"]);
    expect(wornGarmentDefinitionIds(scenario.garments, MARA_ACTOR())).toEqual([]);

    // The REPORT nevertheless still names the scarf. That divergence is the
    // fallback's whole shape and it is pinned here deliberately: the id list is
    // a compatibility projection that can only be read once an actor is
    // modelled, so "modelled, wearing nothing" and "never materialized" are the
    // two states it cannot tell apart, and it fails toward the caller's last
    // known truth rather than toward an unexplained strip. A change that made
    // this `[]` would be stripping every member the store cannot currently see
    // — including one whose reconcile was withheld — so it must be a deliberate
    // change to `garmentProjectionOr`, not a silent one.
    expect(outcome.ensembleWardrobe.lane).toBe("operations");
    expect(outcome.ensembleWardrobe.enumeratedCharacterIds).toContain(MARA_ID);
    expect(outcome.ensembleWardrobe.wornItemIds[MARA_ID]).toEqual([MARA_SCARF_DEF]);
  });

  it("an unresolvable member handle drops with the EXISTING diagnostic — no new rejection code, nothing touched", async () => {
    const chat = await ensembleChat();
    const before = JSON.stringify(chat.scenario.garments);
    const { scenario, sink } = await settle({
      chat,
      scenario: chat.scenario,
      roster: rosterWithMara([MARA_SCARF_DEF, MARA_SHIRT_DEF]),
      archivist: withOps([{ op: "roll", garment: "mara.necklace", part: "root", degree: "slight" }]),
    });
    expect(JSON.stringify(scenario.garments)).toBe(before);
    expect(sink.items.map((d) => d.code)).toContain("garment_op.garment_unresolved");
  });
});
