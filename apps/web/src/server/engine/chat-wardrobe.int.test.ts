import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { DiagnosticCollector } from "@/contracts/diagnostics";
import { emptyChatPlayerState, type ChatPlayerState } from "@/contracts/players/chat-player-state";
import { personaProfileSchema, type PersonaProfile } from "@/contracts/players/persona-profile";
import type { ChatArchivist } from "@/contracts/turns/chat-archivist";

/**
 * Chat wardrobe parity: the continuity leg proposes a
 * garment-level change; `finalizeChatState` folds it into the structured `wornItemIds`
 * against the loaded worn items + wardrobe pool, and the pre-exchange snapshot preserves the
 * prior worn list so "another take" rolls it back. Drives `finalizeChatState` directly with
 * a mocked extraction (AI_FAKE would degrade it), following chat-memory-failure.int.test.ts.
 *
 * It also pins the OWNER'S REGRESSION MATRIX (2026-08-01) for the whole-look
 * `description` path on BOTH folds: a description replaces the modelled wardrobe
 * only when the proposal's verbatim `changeEvidence` validates against THIS
 * exchange's text. Nouns decide nothing — they only name, in the kept-restatement
 * diagnostic, the garments a kept description mentioned that nobody is wearing.
 */

// Mocking at the merge seam keeps this test about
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
/** SINGULAR on purpose: the matrix's plural-canonicalization row describes it as "boots". */
const boot = () => itemId(fixture, "leatherBoot");
/** The PLAYER persona's wardrobe (same owner — items are owner-scoped, not character-scoped). */
const shirt = () => itemId(fixture, "cottonShirt");
const wool = () => itemId(fixture, "woolCardigan");

const RESTATED = "chat_wardrobe.outfit_restatement";
const PLAYER_RESTATED = "chat_wardrobe.player_outfit_restatement";
/**
 * The kept-restatement messages VERBATIM — asserted whole, so a row about
 * canonicalization ("boots" is the worn "boot") proves both that the fold kept
 * AND that it appended no `unworn garment(s)` clause naming what it just matched.
 */
const KEPT = "outfit description restates the structured worn list; keeping the modelled wardrobe";
const KEPT_PLAYER = "player outfit description restates the structured worn list; keeping the modelled wardrobe";

/** The kept-restatement diagnostic's message, or "" when the fold did not keep. */
function restatement(sink: DiagnosticCollector, code: string): string {
  return sink.items.find((item) => item.code === code)?.message ?? "";
}

/** One exchange's text — what a proposal's `changeEvidence` is validated against. */
interface Exchange {
  player: string;
  assistant: string;
}

/** An assistant line that states the change, with the fixture's default player line. */
function narrated(assistant: string): Exchange {
  return { player: "Hi", assistant };
}

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
      { slug: "leatherBoot", name: "leather boot" },
    ],
    // The default preset holds jacket + tee (the seeded worn list); the cardigan is in the
    // wardrobe pool but not worn (an add-candidate). The boot stays OUT of every preset so
    // it never enters the add-pool the addition case asserts against.
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

/**
 * Run one finalize with the given pre-exchange worn list and archivist outfit proposal.
 * `exchange` is what a proposal's `changeEvidence` must quote; omitted ⇒ the fixture's
 * default "Hi" / "Hello.", which no evidence string in this suite appears in.
 */
async function runFinalize(
  preWorn: readonly string[],
  outfit: Partial<ChatArchivist["outfit"]>,
  exchange?: Exchange,
) {
  mock.archivist = { value: withOutfit(outfit), degraded: false };
  return settleChatExchange(fixture, {
    chat,
    wornItemIds: preWorn,
    preExchangeScenario: null,
    ...(exchange === undefined ? {} : { exchange }),
  });
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

  it("a bare-feet removal applies with NO evidence — deltas keep their authoritative path", async () => {
    // Matrix row (g): the evidence gate guards the whole-look description only.
    const { state } = await runFinalize([tee(), boot()], { removed: ["her leather boots"] });
    expect(state?.wornItemIds).toEqual([tee()]);
  });

  it("a named-preset whole swap seeds the worn list from that preset, no evidence needed (rung 1)", async () => {
    // Matrix row (i): an authored preset match never reaches the gate.
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
    expect(restatement(sink, RESTATED)).toBe(KEPT);
  });

  it("a PARTIAL restatement of a multi-garment look keeps the structured wardrobe too", async () => {
    // Matrix row (c): a subset of the worn look is still the worn look.
    const { state, sink } = await runFinalize([jacket(), tee()], { description: "a white cotton tee" });
    expect(state?.wornItemIds).toEqual([jacket(), tee()]);
    expect(state?.outfit).toBe("");
    expect(restatement(sink, RESTATED)).toBe(KEPT);
  });

  it("a styling paraphrase naming no garment keeps the wardrobe (the trial's residual case)", async () => {
    // Matrix row (d).
    const { state, sink } = await runFinalize([tee()], { description: "sleeves shoved past her elbows" });
    expect(state?.wornItemIds).toEqual([tee()]);
    expect(state?.outfit).toBe("");
    expect(restatement(sink, RESTATED)).toBe(KEPT);
  });

  it('"scuffed leather boots" over a worn "leather boot" is the SAME garment, not an unworn one', async () => {
    // Matrix row (a): plural canonicalization (garment-nouns) — the old P1 defect replaced here.
    const { state, sink } = await runFinalize([boot()], { description: "scuffed leather boots" });
    expect(state?.wornItemIds).toEqual([boot()]);
    expect(restatement(sink, RESTATED)).toBe(KEPT);
  });

  it('"her white cotton t-shirt" over a worn tee is the same garment under a different word', async () => {
    // Matrix row (b): alias canonicalization (tee / t-shirt / tshirt).
    const { state, sink } = await runFinalize([tee()], {
      description: "her white cotton t-shirt, sleeves pushed up",
    });
    expect(state?.wornItemIds).toEqual([tee()]);
    expect(restatement(sink, RESTATED)).toBe(KEPT);
  });

  it("a genuinely different whole look replaces once the exchange SAYS it changed", async () => {
    const line = "She slips out of the work clothes and zips herself into a red evening dress.";
    const { state } = await runFinalize(
      [tee()],
      { description: "a red evening dress", changeEvidence: line },
      narrated(line),
    );
    expect(state?.wornItemIds).toEqual([]);
    expect(state?.outfit).toBe("a red evening dress");
  });

  it("an apron nobody is wearing still KEEPS without evidence — and rides the diagnostic", async () => {
    // Matrix row (h): a foreign garment is telemetry, never the decision.
    const { state, sink } = await runFinalize([tee()], { description: "a flour-dusted apron over her clothes" });
    expect(state?.wornItemIds).toEqual([tee()]);
    expect(state?.outfit).toBe("");
    expect(restatement(sink, RESTATED)).toContain("unworn garment(s): apron");
  });

  it("the same apron replaces the moment the exchange states she put it on", async () => {
    const line = "She ties a flour-dusted apron over her clothes.";
    const { state } = await runFinalize(
      [tee()],
      { description: "a flour-dusted apron over her clothes", changeEvidence: line },
      narrated(line),
    );
    expect(state?.wornItemIds).toEqual([]);
    expect(state?.outfit).toBe("a flour-dusted apron over her clothes");
  });

  it("a tank top over a worn shirt KEEPS without evidence, reporting the compound as unworn", async () => {
    // Matrix row (e): "tank top" is a multiword head no unigram registry holds.
    const { state, sink } = await runFinalize([shirt()], { description: "a paint-streaked tank top" });
    expect(state?.wornItemIds).toEqual([shirt()]);
    expect(restatement(sink, RESTATED)).toContain("unworn garment(s): tank_top");
  });

  it("…and replaces on the exchange's own clause — a CLAUSE validates, not just a sentence", async () => {
    const { state } = await runFinalize(
      [shirt()],
      { description: "a paint-streaked tank top", changeEvidence: "yanks on a paint-streaked tank top" },
      narrated("She pulls the shirt off over her head and yanks on a paint-streaked tank top."),
    );
    expect(state?.wornItemIds).toEqual([]);
    expect(state?.outfit).toBe("a paint-streaked tank top");
  });

  it("a black silk shirt over a worn cotton shirt replaces on evidence — the same-head case", async () => {
    // Matrix row (f): the change nouns could never see, because both are "shirt".
    const { state } = await runFinalize(
      [shirt()],
      { description: "a black silk shirt", changeEvidence: "shrugs into a black silk shirt" },
      narrated("She unbuttons the cotton shirt and shrugs into a black silk shirt."),
    );
    expect(state?.wornItemIds).toEqual([]);
    expect(state?.outfit).toBe("a black silk shirt");
  });

  it("…and KEEPS without it, with no unworn garment to report — which is why evidence decides", async () => {
    const { state, sink } = await runFinalize([shirt()], { description: "a black silk shirt" });
    expect(state?.wornItemIds).toEqual([shirt()]);
    expect(state?.outfit).toBe("");
    expect(restatement(sink, RESTATED)).toBe(KEPT);
  });

  it("evidence the exchange never contained is no evidence — the wardrobe holds", async () => {
    // Matrix row (k): validation is against the text, not trust in the extractor.
    const { state, sink } = await runFinalize([shirt()], {
      description: "a black silk shirt",
      changeEvidence: "she changed into a black silk shirt",
    });
    expect(state?.wornItemIds).toEqual([shirt()]);
    expect(state?.outfit).toBe("");
    expect(restatement(sink, RESTATED)).toBe(KEPT);
  });

  it("the PLAYER's own change clause never licenses the CHARACTER's replacement", async () => {
    // The 2026-08-01 audit's cross-target case: the quote is genuinely in the exchange and
    // genuinely asserts a change — only owner scoping rejects it, because the shirt coming
    // off is the player's. The reply, meanwhile, restates her standing look.
    const line = "I peel off my shirt and drop it over the chair back.";
    const { state, sink } = await runFinalize(
      [shirt()],
      { description: "a black silk shirt", changeEvidence: line },
      { player: line, assistant: "She keeps her cotton shirt buttoned to the collar." },
    );
    expect(state?.wornItemIds).toEqual([shirt()]);
    expect(state?.outfit).toBe("");
    expect(restatement(sink, RESTATED)).toBe(KEPT);
  });

  /**
   * The gate's SECOND condition, end to end: a quote may be genuinely in the exchange
   * and still assert no change (`contracts/items/outfit-change-evidence.ts`) — a
   * negation, an order in dialogue, an idiom whose object is no garment. Same
   * shape as the same-head rows above (a black silk shirt over a worn cotton
   * shirt, so there is nothing unworn to report): only the quote varies, so only
   * the quote can be what kept the wardrobe.
   */
  const NON_EVENT_EVIDENCE = [
    "She doesn't take off the cotton shirt.",
    '"Take off the cotton shirt," you say.',
    "He takes off for work.",
  ];

  it.each(NON_EVENT_EVIDENCE)("a grounded quote asserting no change keeps the wardrobe: %s", async (line) => {
    const { state, sink } = await runFinalize(
      [shirt()],
      { description: "a black silk shirt", changeEvidence: line },
      narrated(line),
    );
    expect(state?.wornItemIds).toEqual([shirt()]);
    expect(state?.outfit).toBe("");
    expect(restatement(sink, RESTATED)).toBe(KEPT);
  });

  it("an UNMODELLED character takes the description with no evidence — nothing to protect", async () => {
    const { state, sink } = await runFinalize([], { description: "a black silk shirt" });
    expect(state?.wornItemIds).toEqual([]);
    expect(state?.outfit).toBe("a black silk shirt");
    expect(restatement(sink, RESTATED)).toBe("");
  });

  it("a restatement carrying an exposure claim still replaces — exposure is a real change", async () => {
    // Matrix row (j): the exposure claim skips the gate, with no evidence passed.
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
  exchange?: Exchange,
) {
  mock.archivist = { value: withPlayerOutfit(playerOutfit), degraded: false };
  return settleChatExchange(fixture, {
    chat,
    playerPersona: persona(wardrobe),
    playerState: { ...emptyChatPlayerState(), ...playerState },
    preExchangeScenario: null,
    ...(exchange === undefined ? {} : { exchange }),
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
    expect(restatement(sink, PLAYER_RESTATED)).toBe(KEPT_PLAYER);
  });

  it("a restatement of the SEEDED stored list holds the same way", async () => {
    const { scenario, sink } = await runPlayerFinalize([shirt(), wool()], { seeded: true, wornItemIds: [wool()] }, {
      description: "the wool cardigan pulled close against the cold",
    });
    expect(scenario?.playerState.wornItemIds).toEqual([wool()]);
    expect(restatement(sink, PLAYER_RESTATED)).toBe(KEPT_PLAYER);
  });

  it("a PARTIAL restatement of a multi-garment look keeps the structured wardrobe too", async () => {
    // Matrix row (c), player side.
    const { scenario, sink } = await runPlayerFinalize([shirt(), wool()], {}, { description: "a cotton shirt" });
    expect(scenario?.playerState.wornItemIds).toEqual([shirt(), wool()]);
    expect(scenario?.playerState.overlay).toBe("");
    expect(restatement(sink, PLAYER_RESTATED)).toBe(KEPT_PLAYER);
  });

  it("a styling paraphrase naming no garment keeps the player's wardrobe too", async () => {
    // Matrix row (d), player side.
    const { scenario, sink } = await runPlayerFinalize([shirt()], {}, { description: "collar open, sleeves rolled" });
    expect(scenario?.playerState.wornItemIds).toEqual([shirt()]);
    expect(scenario?.playerState.overlay).toBe("");
    expect(restatement(sink, PLAYER_RESTATED)).toBe(KEPT_PLAYER);
  });

  it('"scuffed leather boots" over your worn "leather boot" is the same garment, pluralized', async () => {
    // Matrix row (a), player side.
    const { scenario, sink } = await runPlayerFinalize([boot()], {}, { description: "scuffed leather boots" });
    expect(scenario?.playerState.wornItemIds).toEqual([boot()]);
    expect(restatement(sink, PLAYER_RESTATED)).toBe(KEPT_PLAYER);
  });

  it('"your white cotton t-shirt" over a worn tee is the same garment, aliased', async () => {
    // Matrix row (b), player side.
    const { scenario, sink } = await runPlayerFinalize([tee()], {}, {
      description: "your white cotton t-shirt, sleeves shoved up",
    });
    expect(scenario?.playerState.wornItemIds).toEqual([tee()]);
    expect(restatement(sink, PLAYER_RESTATED)).toBe(KEPT_PLAYER);
  });

  it("a genuinely different whole look replaces when the PLAYER's own line states it", async () => {
    // Either half of the exchange may carry the evidence — here the player's.
    const line = "I peel off the cotton shirt and pull on a red evening dress.";
    const { scenario } = await runPlayerFinalize(
      [shirt()],
      {},
      { description: "a red evening dress", changeEvidence: line },
      { player: line, assistant: "Hello." },
    );
    expect(scenario?.playerState.wornItemIds).toEqual([]);
    expect(scenario?.playerState.overlay).toBe("a red evening dress");
    expect(scenario?.playerState.seeded).toBe(true);
  });

  it("an apron the persona doesn't own still KEEPS without evidence, named in the diagnostic", async () => {
    // Matrix row (h), player side.
    const { scenario, sink } = await runPlayerFinalize([tee()], {}, {
      description: "a flour-dusted apron over your clothes",
    });
    expect(scenario?.playerState.wornItemIds).toEqual([tee()]);
    expect(scenario?.playerState.overlay).toBe("");
    expect(restatement(sink, PLAYER_RESTATED)).toContain("unworn garment(s): apron");
  });

  it("that apron replaces once the exchange says you tied it on", async () => {
    const line = "You tie a flour-dusted apron over your clothes.";
    const { scenario } = await runPlayerFinalize(
      [tee()],
      {},
      { description: "a flour-dusted apron over your clothes", changeEvidence: line },
      narrated(line),
    );
    expect(scenario?.playerState.wornItemIds).toEqual([]);
    expect(scenario?.playerState.overlay).toBe("a flour-dusted apron over your clothes");
  });

  it("a tank top over your worn shirt KEEPS without evidence, reporting the compound", async () => {
    // Matrix row (e), player side.
    const { scenario, sink } = await runPlayerFinalize([shirt()], {}, { description: "a paint-streaked tank top" });
    expect(scenario?.playerState.wornItemIds).toEqual([shirt()]);
    expect(restatement(sink, PLAYER_RESTATED)).toContain("unworn garment(s): tank_top");
  });

  it("…and replaces on the clause the reply actually contains", async () => {
    const { scenario } = await runPlayerFinalize(
      [shirt()],
      {},
      { description: "a paint-streaked tank top", changeEvidence: "tugs you into a paint-streaked tank top" },
      narrated("She strips the cotton shirt off you and tugs you into a paint-streaked tank top."),
    );
    expect(scenario?.playerState.wornItemIds).toEqual([]);
    expect(scenario?.playerState.overlay).toBe("a paint-streaked tank top");
  });

  it("a black silk shirt over your cotton shirt replaces on evidence — same head noun", async () => {
    // Matrix row (f), player side.
    const { scenario } = await runPlayerFinalize(
      [shirt()],
      {},
      { description: "a black silk shirt", changeEvidence: "you swap it for a black silk shirt" },
      narrated("She watches you swap it for a black silk shirt."),
    );
    expect(scenario?.playerState.wornItemIds).toEqual([]);
    expect(scenario?.playerState.overlay).toBe("a black silk shirt");
  });

  it("…and KEEPS without it, with nothing unworn to report", async () => {
    const { scenario, sink } = await runPlayerFinalize([shirt()], {}, { description: "a black silk shirt" });
    expect(scenario?.playerState.wornItemIds).toEqual([shirt()]);
    expect(scenario?.playerState.overlay).toBe("");
    expect(restatement(sink, PLAYER_RESTATED)).toBe(KEPT_PLAYER);
  });

  it("a quote absent from the exchange never replaces the player's wardrobe either", async () => {
    // Matrix row (k), player side.
    const { scenario, sink } = await runPlayerFinalize([shirt()], {}, {
      description: "a black silk shirt",
      changeEvidence: "you changed into a black silk shirt",
    });
    expect(scenario?.playerState.wornItemIds).toEqual([shirt()]);
    expect(scenario?.playerState.overlay).toBe("");
    expect(restatement(sink, PLAYER_RESTATED)).toBe(KEPT_PLAYER);
  });

  it("the CHARACTER's change clause never licenses the PLAYER's replacement", async () => {
    // The audit's cross-target case, mirrored: the quote is in the exchange and asserts a
    // change — it is simply her dress coming off, not the player's shirt.
    const line = "She slips out of her dress and leaves it over the chair.";
    const { scenario, sink } = await runPlayerFinalize(
      [shirt()],
      {},
      { description: "a black silk shirt", changeEvidence: line },
      narrated(line),
    );
    expect(scenario?.playerState.wornItemIds).toEqual([shirt()]);
    expect(scenario?.playerState.overlay).toBe("");
    expect(restatement(sink, PLAYER_RESTATED)).toBe(KEPT_PLAYER);
  });

  it("a MODAL quote — what you might do — never replaces the player's wardrobe", async () => {
    // Grounded in the player's own line and still not a change: the classifier's
    // veto is the only thing standing between "might change" and a wiped wardrobe.
    const line = "You might change into a black silk shirt.";
    const { scenario, sink } = await runPlayerFinalize(
      [shirt()],
      {},
      { description: "a black silk shirt", changeEvidence: line },
      { player: line, assistant: "Hello." },
    );
    expect(scenario?.playerState.wornItemIds).toEqual([shirt()]);
    expect(scenario?.playerState.overlay).toBe("");
    // The fold wrote NOTHING (the persona's own default is what the ids still
    // are); `seeded` flips because the garment reconcile modelled the player's
    // wardrobe this write — `syncGarmentsForExchange`, not the outfit fold.
    expect(scenario?.playerState.seeded).toBe(true);
    expect(restatement(sink, PLAYER_RESTATED)).toBe(KEPT_PLAYER);
  });

  it("an UNMODELLED persona — an empty default preset — takes the description as before", async () => {
    // `playerWornIds` resolves to [] with nothing authored, so the guard's
    // precondition is absent and the description lands on the overlay, seeded.
    const { scenario, sink } = await runPlayerFinalize([], {}, { description: "a black silk shirt" });
    expect(scenario?.playerState.wornItemIds).toEqual([]);
    expect(scenario?.playerState.overlay).toBe("a black silk shirt");
    expect(scenario?.playerState.seeded).toBe(true);
    expect(restatement(sink, PLAYER_RESTATED)).toBe("");
  });

  it("a removal delta applies with no evidence — the player's deltas are authoritative too", async () => {
    // Matrix row (g), player side.
    const { scenario } = await runPlayerFinalize([shirt(), boot()], {}, { removed: ["your leather boots"] });
    expect(scenario?.playerState.wornItemIds).toEqual([shirt()]);
  });

  it("an addition delta still pulls its match out of the persona's own wardrobe", async () => {
    // Matrix row (h), player side: the delta path, unchanged by the gate.
    const { scenario } = await runPlayerFinalize([shirt(), wool()], { seeded: true, wornItemIds: [shirt()] }, {
      added: ["a wool cardigan"],
    });
    expect(scenario?.playerState.wornItemIds).toEqual([shirt(), wool()]);
  });

  it("a named-preset swap seeds the persona's preset with no evidence needed", async () => {
    // Matrix row (i), player side.
    const { scenario } = await runPlayerFinalize([shirt()], { seeded: true, wornItemIds: [wool()] }, {
      description: "changes into her everyday clothes",
    });
    expect(scenario?.playerState.wornItemIds).toEqual([shirt()]);
    expect(scenario?.playerState.outfitPresetId).toBe("everyday");
  });
});
