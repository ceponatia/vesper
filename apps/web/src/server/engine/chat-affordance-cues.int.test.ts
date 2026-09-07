import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { emptyAffordanceCueState, AFFORDANCE_CUES_PER_EXCHANGE, type AffordanceCueState } from "@/contracts/affordances/core";
import { hairAttributeFixture } from "@/contracts/affordances/domains/hair/fixtures";
import { garmentActorForCharacter } from "@/contracts/items/garment-store";
import { bodySurfaceWetnessAt } from "@/contracts/state/body-surface";
import { characterProfileSchema } from "@/contracts/world/profile";
import { DiagnosticCollector } from "@/contracts/diagnostics";
import { chatContinuitySchema, type ChatArchivist } from "@/contracts/turns/chat-archivist";
import { characterChats, db } from "@/server/db";

/**
 * The narrator trial, end to end.
 *
 * What only a database can prove:
 *
 * - with `CHAT_AFFORDANCE_CUES` off the narrator prompt is exactly today's — not
 *   one character more — and the stored cue memory rides through untouched
 *   rather than being cleared;
 * - with it on, a real committed cut (weather in `character_chats.environment`,
 *   wetness in `character_chat_state.body_surface`) produces at most the capped
 *   cue block, and the SECOND exchange over unchanged hair produces none — the
 *   repeat gate, surviving a round trip through jsonb;
 * - covered hair says nothing: the read still resolves, and perception is what
 *   drops it (slice 4's law, now visible at the prompt);
 * - "another take" restores the mention history with the weather it was read
 *   against, so the rebuilt prompt is byte-identical (the prompt-path analog of
 *   the slice-4 capture fixture);
 * - a corrupt `affordance_cues` blob degrades to "nothing said yet" with its
 *   boundary diagnostic, and the exchange still settles.
 */

const mock = vi.hoisted(() => ({ archivist: { value: null as ChatArchivist | null, degraded: false } }));

vi.mock("./chat-memory", async () => {
  const { chatMemoryMockModule } = await import("../test-support/chat-archivist-mock");
  return chatMemoryMockModule(mock);
});

import { loadChatScenario, loadChatState, saveChatScenario } from "./chat-state/store";
import { loadPreExchangeScenario, rollbackScenario, savePreExchangeScenario } from "./chat-state/snapshots";
import type { ChatScenario, ChatState } from "./chat-state";
import { buildChatAffordanceRead } from "./chat-affordances";
import { resolveChatWardrobe } from "./chat-wardrobe";
import { previewChatPrompt } from "./chat-prompt-preview";
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
  type ChatFixture,
  type ChatSeat,
} from "@/server/test-support";

const CUE_HEADING = "Physical detail worth noticing this turn";

/**
 * The two clumping SENTENCES, matched without their degree adjective.
 *
 * Since the round-R2 change the adjective states how wet the hair actually is
 * ("damp"/"wet"/"soaked"), which moves with the committed level and therefore
 * with the story clock these exchanges run on. What each assertion here is about
 * is which BAND's sentence reached the narrator, so the adjective is the one part
 * deliberately left open — the projection's unit tests pin the exact wording.
 */
const CLEAR_CLUMPING = /has separated into \w+, clinging strands/u;
const SUBTLE_CLUMPING = /has begun to gather into \w+ strands/u;

/** Headwear is the perception gate's instrument: the one library row that covers `hair`. */
const WOOL_HAT = { slug: "woolHat", name: "wool hat", category: "headwear", coverage: ["hair"], layer: 2 } as const;

/** Dense, thick, shoulder-length, loose — hair with something to say once it is wet. */
const HAIR_ATTRIBUTES = hairAttributeFixture({
  length: "shoulder_length",
  density: "dense",
  strandThickness: "thick",
  texture: "wavy",
  condition: "healthy",
  arrangement: "loose",
  // Projection-only: it must reach the cue line and never a band.
  color: "auburn",
});

const ready = await probeIntegrationDb("chat-affordance-cues.int.test", "character_chats");

let fixture: ChatFixture = emptyChatFixture();

const shirtId = () => itemId(fixture, "cottonShirt");
const hatId = () => itemId(fixture, "woolHat");

beforeAll(async () => {
  if (!ready) return;
  const seeded = await seedChatFixture({
    slug: "chat-affordance-cues-int",
    userName: "Affordance Cues Int",
    garments: [GARMENT_SEEDS.cottonShirt, WOOL_HAT],
  });
  // The character needs authored hair for the domain to compile a profile at all.
  // `previewChatPrompt` takes the profile from its caller, so overriding it here is
  // the same profile every seam in this file sees.
  fixture = {
    ...seeded,
    profile: characterProfileSchema.parse({ ...seeded.profile, attributes: HAIR_ATTRIBUTES }),
  };
});

afterAll(async () => {
  delete process.env.CHAT_AFFORDANCE_CUES;
  await dropChatFixture(fixture);
});

/** The continuity leg's output, parsed exactly as production parses it. */
function continuity(raw: unknown): ChatArchivist {
  return chatArchivist(chatContinuitySchema.parse(raw));
}

/** "What reaches the narrator right now", as the dev inspector renders it. */
async function narratorPrompt(chat: ChatSeat): Promise<string> {
  const preview = await previewChatPrompt({
    chatId: chat.chatId,
    memoryGroupId: chat.memoryGroupId,
    character: { id: fixture.characterId, name: fixture.characterName, profile: fixture.profile },
  });
  return `${preview.prefix}\n${preview.tail}`;
}

/** The cue lines inside the block, or [] when there is no block. */
function cueLines(prompt: string): string[] {
  const start = prompt.indexOf(`\n\n${CUE_HEADING}`);
  if (start < 0) return [];
  const end = prompt.indexOf("\n\n", start + 2 + CUE_HEADING.length);
  return prompt
    .slice(start + 2, end < 0 ? undefined : end)
    .split("\n")
    .slice(1);
}

/** The read as the pipeline takes it: committed scenario + committed state + the real wardrobe. */
async function readFor(scenario: ChatScenario, state: ChatState) {
  const wardrobe = await resolveChatWardrobe(
    { ...state, garments: scenario.garments, garmentActorId: garmentActorForCharacter(fixture.characterId) },
    fixture.userId,
    fixture.profile,
  );
  return buildChatAffordanceRead({
    subjectId: fixture.characterId,
    attributes: fixture.profile.attributes,
    attributeOverlays: state.attributeOverlays,
    conditions: state.conditions,
    ...(wardrobe.worn === undefined ? {} : { wardrobe: { worn: wardrobe.worn } }),
    bodySurface: state.bodySurface,
    environment: scenario.environment,
    clockMinutes: scenario.clockMinutes,
    previousCues: scenario.affordanceCues,
  });
}

/** The stored cut, as both the finalizer and the preview see it. */
async function storedCut(chat: ChatSeat): Promise<{ scenario: ChatScenario; state: ChatState }> {
  const scenario = await loadChatScenario(chat.chatId);
  const state = await loadChatState(chat.chatId, fixture.characterId);
  if (!scenario || !state) throw new Error("stored cut missing");
  return { scenario, state };
}

/**
 * One exchange over the stored cut. `withCues` threads the read's memory the way
 * the live pipeline threads it — from the PRE-fan-out cut, which is what the
 * narrator's prompt was built from.
 */
async function settle(chat: ChatSeat, raw: unknown, withCues = false): Promise<ChatScenario> {
  const { scenario, state } = await storedCut(chat);
  const read = withCues ? await readFor(scenario, state) : null;
  mock.archivist = { value: continuity(raw), degraded: false };
  const settled = await settleChatExchange(fixture, {
    chat,
    scenario,
    driftedState: state,
    ...(read ? { affordanceCueState: read.nextCues } : {}),
  });
  if (!settled.scenario) throw new Error("scenario missing after finalize");
  return settled.scenario;
}

/**
 * A dressed conversation that has just come in out of the rain: the shirt makes
 * the wardrobe READABLE (unknown coverage fails closed and would silence
 * everything), the weather and the soaking are typed committed state.
 */
async function rainedOnChat(worn: readonly string[] = [shirtId()]): Promise<ChatSeat> {
  const chat = await newChat(fixture);
  mock.archivist = {
    value: continuity({
      environment: { precipitation: "rain", indoors: false },
      surfaceWetness: [{ location: "hair", direction: "increase", degree: 3, cause: "rain" }],
    }),
    degraded: false,
  };
  await settleChatExchange(fixture, { chat, wornItemIds: worn });
  return chat;
}

describe.runIf(ready)("the flag — off is today, to the character", () => {
  it("renders no cue block when CHAT_AFFORDANCE_CUES is unset", async () => {
    delete process.env.CHAT_AFFORDANCE_CUES;
    const chat = await rainedOnChat();
    const prompt = await narratorPrompt(chat);
    expect(prompt).not.toContain(CUE_HEADING);
    // The soaking really is on the row — the flag is hiding the read, not the state.
    const { state } = await storedCut(chat);
    expect(bodySurfaceWetnessAt(state.bodySurface, "hair", 0)).toEqual({ status: "known", level: 10_000 });
    // …and the wardrobe phrase is untouched, so nothing about today moved.
    expect(prompt).toContain("You're wearing");
  });

  it("adds exactly one block when it is on, and nothing else changes", async () => {
    const chat = await rainedOnChat();

    delete process.env.CHAT_AFFORDANCE_CUES;
    const off = await narratorPrompt(chat);
    process.env.CHAT_AFFORDANCE_CUES = "on";
    const on = await narratorPrompt(chat);

    expect(on).toContain(CUE_HEADING);
    expect(on).toMatch(/Wren's auburn hair has separated into \w+, clinging strands, still wet from the rain/u);
    // Everything the OFF prompt said, the ON prompt still says.
    for (const line of off.split("\n")) expect(on).toContain(line);
    // And byte for byte: the ON prompt is the OFF prompt with ONE block spliced
    // in, which is what "OFF is identical to the pre-feature build" means.
    const start = on.indexOf(`\n\n${CUE_HEADING}`);
    const end = on.indexOf("\n\n", start + 2 + CUE_HEADING.length);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(`${on.slice(0, start)}${on.slice(end)}`).toBe(off);
    expect(cueLines(on).length).toBeLessThanOrEqual(AFFORDANCE_CUES_PER_EXCHANGE);
  });

  it("leaves the stored cue memory untouched with the flag off — never cleared", async () => {
    delete process.env.CHAT_AFFORDANCE_CUES;
    const chat = await rainedOnChat();
    const { scenario, state } = await storedCut(chat);
    const remembered: AffordanceCueState = {
      bands: { "hair:clumping": "strong" },
      cues: ["hair:clumping"],
      changedAt: { "hair:clumping": 3 },
    };
    await saveChatScenario(chat.chatId, { ...scenario, affordanceCues: remembered });

    mock.archivist = { value: continuity({}), degraded: false };
    const settled = await settleChatExchange(fixture, {
      chat,
      scenario: { ...scenario, affordanceCues: remembered },
      driftedState: state,
    });
    expect(settled.scenario?.affordanceCues).toEqual(remembered);
  });
});

describe.runIf(ready)("the repeat gate, through jsonb", () => {
  it("says it once, holds its tongue while nothing moves, and speaks again on a band change", async () => {
    process.env.CHAT_AFFORDANCE_CUES = "on";
    const chat = await rainedOnChat();
    // The prompt is built BEFORE the fan-out (as it is live), so exchange 1's cue
    // memory recorded the DRY cut — the narrator hears about the rain on THIS prompt.
    const first = await narratorPrompt(chat);
    expect(first).toMatch(CLEAR_CLUMPING);
    expect(cueLines(first)).toHaveLength(1);

    // Exchange 2 changes nothing about the hair — and records that the clumping
    // has now been said. The read is standing state from here on.
    const afterQuiet = await settle(chat, {}, true);
    expect(afterQuiet.affordanceCues.bands["hair:clumping"]).toBe("clear");
    const second = await narratorPrompt(chat);
    expect(second).not.toContain(CUE_HEADING);

    // She steps inside and towels off: same key, different band, so it earns the
    // slot again — and the rain provenance goes with the cause that is gone.
    await settle(
      chat,
      {
        environment: { precipitation: "none", indoors: true },
        surfaceWetness: [{ location: "hair", direction: "decrease", degree: 1 }],
      },
      true,
    );
    const third = await narratorPrompt(chat);
    expect(third).toContain(CUE_HEADING);
    expect(third).toMatch(/Wren's auburn hair has begun to gather into \w+ strands/u);
    expect(third).not.toContain("still wet from the rain");
  });
});

describe.runIf(ready)("the perception gate", () => {
  it("an opaque hat only HINTS — the wet hair under it still reaches the narrator", async () => {
    process.env.CHAT_AFFORDANCE_CUES = "on";
    const chat = await rainedOnChat([shirtId(), hatId()]);
    const prompt = await narratorPrompt(chat);
    // The hat is genuinely on her, and the hair is genuinely wet.
    expect(prompt).toContain("wool hat");
    const cut = await storedCut(chat);
    const wetness = bodySurfaceWetnessAt(cut.state.bodySurface, "hair", 0);
    expect(wetness).toEqual({ status: "known", level: expect.any(Number) });
    expect(wetness.status === "known" && wetness.level).toBeGreaterThan(0);

    // Review finding 5: an ordinary hat leaves ends and fringe visible, and the
    // mechanics already model that (`coveredFraction` 0.9, not 1.0). Perception no
    // longer contradicts them by hiding the whole location, so the clumping cue —
    // which coverage does NOT damp — is offered.
    const read = await readFor(cut.scenario, cut.state);
    expect(read.read.observations.map((entry) => entry.id)).toContain("hair.wet_clumping");
    expect(prompt).toContain(CUE_HEADING);
    expect(prompt).toMatch(CLEAR_CLUMPING);

    // What the hat DOES silence, it silences for a physical reason the mechanics
    // name — not because an observer was told nothing about the location.
    expect(read.read.suppressed.find((entry) => entry.phenomenonId === "hair.wind_or_motion_response")?.code).toBe(
      "no_current_force",
    );
  });
});

describe.runIf(ready)("a retake restores mention history WITH the weather it read", () => {
  it("rolls the cue memory back on the scenario anchor and rebuilds the identical prompt", async () => {
    process.env.CHAT_AFFORDANCE_CUES = "on";
    const chat = await rainedOnChat();
    const { scenario: anchorScenario } = await storedCut(chat);
    expect(anchorScenario.affordanceCues).toEqual(emptyAffordanceCueState());
    await savePreExchangeScenario(chat.chatId, anchorScenario);
    const expected = await narratorPrompt(chat);
    expect(expected).toMatch(CLEAR_CLUMPING);

    // A take that says the damp hair out loud. Nothing about the BODY moves, so
    // the only thing this exchange can change about the next prompt is the memory.
    const diverged = await settle(chat, {}, true);
    expect(diverged.affordanceCues.bands["hair:clumping"]).toBe("clear");
    const after = await narratorPrompt(chat);
    expect(after).not.toContain(CUE_HEADING);

    // "Another take": restore the anchor and rebuild from it alone.
    const anchor = await loadPreExchangeScenario(chat.chatId);
    expect(anchor).not.toBeNull();
    if (!anchor) return;
    const rolledBack = rollbackScenario(anchor, diverged);
    expect(rolledBack.affordanceCues).toEqual(anchorScenario.affordanceCues);
    await saveChatScenario(chat.chatId, rolledBack);
    // The narrator is offered exactly what it was offered before the discarded
    // take. (The block, not the whole prompt: the settled exchange also ticked
    // familiarity and the arc, which a scenario rollback is not supposed to undo.)
    expect(cueLines(await narratorPrompt(chat))).toEqual(cueLines(expected));
  });
});

describe.runIf(ready)("corrupt jsonb degrades without costing the turn", () => {
  it("a bad affordance_cues blob reads as nothing-said with parse.boundary_failed", async () => {
    process.env.CHAT_AFFORDANCE_CUES = "on";
    const chat = await rainedOnChat();
    await db().execute(
      sql`update ${characterChats} set affordance_cues = '"already mentioned"'::jsonb where id = ${chat.chatId}`,
    );

    const sink = new DiagnosticCollector();
    const corrupt = await loadChatScenario(chat.chatId, sink);
    expect(corrupt?.affordanceCues).toEqual(emptyAffordanceCueState());
    expect(sink.items.find((d) => d.code === "parse.boundary_failed")?.path).toBe(
      "character_chats.affordance_cues",
    );

    // A corrupt memory is "nothing said yet" — chatty for one exchange, never a
    // lost turn — and the next exchange re-materializes the column.
    expect(await narratorPrompt(chat)).toMatch(CLEAR_CLUMPING);
    const healed = await settle(chat, {}, true);
    expect(healed.affordanceCues.bands["hair:clumping"]).toBe("clear");
  });
});
