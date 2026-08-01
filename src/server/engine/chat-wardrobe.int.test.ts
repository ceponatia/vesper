import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { emptyChatPlayerState, type ChatPlayerState } from "@/contracts/players/chat-player-state";
import { personaProfileSchema, type PersonaProfile } from "@/contracts/players/persona-profile";
import type { ChatArchivist } from "@/contracts/turns/chat-archivist";

/**
 * Chat wardrobe parity (chat-wardrobe-parity.plan.md rung 2): the continuity leg proposes a
 * garment-level change; `finalizeChatState` folds it into the structured `wornItemIds`
 * against the loaded worn items + wardrobe pool, and the pre-exchange snapshot preserves the
 * prior worn list so "another take" rolls it back. Drives `finalizeChatState` directly with
 * a mocked extraction (AI_FAKE would degrade it), following chat-memory-failure.int.test.ts.
 */

// Mocking at the merge seam (chat-agent-improvements slice 1b) keeps this test about
// the WARDROBE fold, not the leg composition.
const mock = vi.hoisted(() => ({ archivist: { value: null as ChatArchivist | null, degraded: false } }));

vi.mock("./chat-memory", async () => {
  const { chatMemoryMockModule } = await import("../test-support/chat-archivist-mock");
  return chatMemoryMockModule(mock);
});

import { loadPreExchangeState } from "./chat-state";
import {
  bareGarment,
  dropChatFixture,
  emptyChatFixture,
  GARMENT_SEEDS,
  itemId,
  newChat,
  probeIntegrationDb,
  seedChatFixture,
  settleChatExchange,
  withOutfit,
  withPlayerOutfit,
  type ChatFixture,
  type ChatSeat,
} from "@/server/test-support";

const ready = await probeIntegrationDb("chat-wardrobe.int.test", "character_chat_state");

let fixture: ChatFixture = emptyChatFixture();
let chat: ChatSeat = { chatId: "", memoryGroupId: "", messageId: "" };

/** These rows deliberately carry NO garment definition — this suite is the free-text bridge. */
const jacket = () => itemId(fixture, "denimJacket");
const tee = () => itemId(fixture, "whiteCottonTee");
const cardigan = () => itemId(fixture, "greyWoolCardigan");
/** The PLAYER persona's wardrobe (same owner — items are owner-scoped, not character-scoped). */
const shirt = () => itemId(fixture, "cottonShirt");
const wool = () => itemId(fixture, "woolCardigan");

beforeAll(async () => {
  if (!ready) return;
  fixture = await seedChatFixture({
    slug: "chat-wardrobe-int",
    userName: "Wardrobe Int",
    garments: [
      bareGarment(GARMENT_SEEDS.denimJacket),
      bareGarment(GARMENT_SEEDS.whiteCottonTee),
      bareGarment(GARMENT_SEEDS.greyWoolCardigan),
      bareGarment(GARMENT_SEEDS.cottonShirt),
      bareGarment(GARMENT_SEEDS.woolCardigan),
    ],
    // The default preset holds jacket + tee (the seeded worn list); the cardigan is in the
    // wardrobe pool but not worn (an add-candidate).
    outfits: [
      { id: "everyday", name: "Everyday", items: ["denimJacket", "whiteCottonTee"] },
      { id: "cozy", name: "Cozy", items: ["greyWoolCardigan"] },
    ],
  });
  chat = await newChat(fixture);
});

afterAll(async () => {
  await dropChatFixture(fixture);
});

/** Run one finalize with the given pre-exchange worn list and archivist outfit proposal. */
async function runFinalize(preWorn: readonly string[], outfit: Partial<ChatArchivist["outfit"]>) {
  mock.archivist = { value: withOutfit(outfit), degraded: false };
  return settleChatExchange(fixture, { chat, wornItemIds: preWorn, preExchangeScenario: null });
}

describe.runIf(ready)("finalizeChatState — archivist-proposed garment changes (chat-wardrobe-parity rung 2)", () => {
  it("removes a matched worn garment from the structured worn list", async () => {
    const { state } = await runFinalize([jacket(), tee()], { removed: ["her denim jacket"] });
    expect(state?.wornItemIds).toEqual([tee()]);
  });

  it("adds a matched pool garment's id to the worn list", async () => {
    const { state } = await runFinalize([tee()], { added: ["a wool cardigan"] });
    expect(state?.wornItemIds).toEqual([tee(), cardigan()]);
  });

  it("keeps a narrated-but-unowned added garment as free-text overlay", async () => {
    const { state } = await runFinalize([tee()], { added: ["a borrowed hoodie"] });
    expect(state?.wornItemIds).toEqual([tee()]);
    expect(state?.outfit).toBe("a borrowed hoodie");
  });

  it("a named-preset whole swap seeds the worn list from that preset (rung 1)", async () => {
    const { state } = await runFinalize([jacket(), tee()], { description: "changes into her cozy clothes" });
    expect(state?.wornItemIds).toEqual([cardigan()]);
    expect(state?.outfitPresetId).toBe("cozy");
  });

  it("a description that merely RESTATES the worn look keeps the structured wardrobe", async () => {
    // The narrator paraphrased the standing outfit; the archivist extracted the
    // paraphrase as a whole-look description. A paraphrase is not a wardrobe
    // action — wiping the structured list here is how a modelled dressed body
    // silently became unmodellable one settle into a conversation.
    const { state, sink } = await runFinalize([tee()], {
      description: "a soft white cotton tee with the sleeves pushed up",
    });
    expect(state?.wornItemIds).toEqual([tee()]);
    expect(state?.outfit).toBe("");
    expect(sink.items.some((item) => item.code === "chat_wardrobe.outfit_restatement")).toBe(true);
  });

  it("a genuinely different whole look still replaces (the ruled free-text fallback)", async () => {
    const { state } = await runFinalize([tee()], { description: "a red evening dress" });
    expect(state?.wornItemIds).toEqual([]);
    expect(state?.outfit).toBe("a red evening dress");
  });

  it("a PARTIAL restatement of a multi-garment look still replaces — the guard is strict", async () => {
    const { state } = await runFinalize([jacket(), tee()], { description: "a white cotton tee" });
    expect(state?.wornItemIds).toEqual([]);
    expect(state?.outfit).toBe("a white cotton tee");
  });

  it("a restatement carrying an exposure claim still replaces — exposure is a real change", async () => {
    const { state } = await runFinalize([tee()], {
      description: "a soft white cotton tee with the sleeves pushed up",
      exposed: true,
    });
    expect(state?.wornItemIds).toEqual([]);
    expect(state?.outfitExposed).toBe(true);
  });

  it("the pre-exchange snapshot preserves the prior worn list for rollback", async () => {
    // The post-exchange state dropped the jacket…
    const { state } = await runFinalize([jacket(), tee()], { removed: ["her denim jacket"] });
    expect(state?.wornItemIds).toEqual([tee()]);
    // …but "another take" rolls back to the pre-exchange worn list.
    const rollback = await loadPreExchangeState(chat.chatId, fixture.characterId);
    expect(rollback.found).toBe(true);
    expect(rollback.state?.wornItemIds).toEqual([jacket(), tee()]);
  });
});

/** A persona whose one preset (the implicit default) holds exactly these worn items. */
function persona(items: readonly string[]): PersonaProfile {
  return personaProfileSchema.parse({ outfits: [{ id: "everyday", name: "Everyday", items }] });
}

/** Run one finalize with the player's pre-exchange state and an archivist PLAYER-outfit proposal. */
async function runPlayerFinalize(
  wardrobe: readonly string[],
  playerState: Partial<ChatPlayerState>,
  playerOutfit: Partial<ChatArchivist["playerOutfit"]>,
) {
  mock.archivist = { value: withPlayerOutfit(playerOutfit), degraded: false };
  return settleChatExchange(fixture, {
    chat,
    playerPersona: persona(wardrobe),
    playerState: { ...emptyChatPlayerState(), ...playerState },
    preExchangeScenario: null,
  });
}

describe.runIf(ready)("finalizeChatState — the PLAYER's outfit fold (persona-library slice 8)", () => {
  it("a description that merely RESTATES the player's worn look keeps the structured wardrobe", async () => {
    // Unseeded state — the persona is implicitly wearing the default preset. The
    // narrator paraphrased that look; wiping the structured list to overlay prose
    // here de-modelled the player's wardrobe (and, with overlay contributing no
    // coverage, stripped the modelled body) one settle into a fresh conversation.
    const { scenario, sink } = await runPlayerFinalize([shirt()], {}, {
      description: "a soft cotton shirt with the sleeves rolled to the elbow",
    });
    expect(scenario?.playerState.wornItemIds).toEqual([shirt()]);
    expect(scenario?.playerState.overlay).toBe("");
    expect(sink.items.some((item) => item.code === "chat_wardrobe.player_outfit_restatement")).toBe(true);
  });

  it("a restatement of the SEEDED stored list holds the same way", async () => {
    const { scenario, sink } = await runPlayerFinalize([shirt(), wool()], { seeded: true, wornItemIds: [wool()] }, {
      description: "the wool cardigan pulled close against the cold",
    });
    expect(scenario?.playerState.wornItemIds).toEqual([wool()]);
    expect(sink.items.some((item) => item.code === "chat_wardrobe.player_outfit_restatement")).toBe(true);
  });

  it("a genuinely different whole look still replaces (the ruled overlay fallback)", async () => {
    const { scenario } = await runPlayerFinalize([shirt()], {}, { description: "a red evening dress" });
    expect(scenario?.playerState.wornItemIds).toEqual([]);
    expect(scenario?.playerState.overlay).toBe("a red evening dress");
    expect(scenario?.playerState.seeded).toBe(true);
  });

  it("a PARTIAL restatement of a multi-garment look still replaces — the guard is strict", async () => {
    const { scenario } = await runPlayerFinalize([shirt(), wool()], {}, { description: "a cotton shirt" });
    expect(scenario?.playerState.wornItemIds).toEqual([]);
    expect(scenario?.playerState.overlay).toBe("a cotton shirt");
  });
});
