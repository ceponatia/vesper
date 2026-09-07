import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { hairAttributeFixture } from "@/contracts/affordances/domains/hair/fixtures";
import { characterProfileSchema } from "@/contracts/world/profile";
import { chatContinuitySchema, type ChatArchivist } from "@/contracts/turns/chat-archivist";
import { bodySurfaceWetnessAt } from "@/contracts/state/body-surface";
import { characterChatMessages, db } from "@/server/db";

/**
 * The constraint-first narrator guidance, end to end.
 *
 * What only a database can prove:
 *
 * - with `CHAT_PHYSICAL_CONSTRAINTS` off the narrator prompt is exactly today's — not
 *   one character more — even though the committed cut has a fence to offer;
 * - with it on, a real committed cut (a soaking in `character_chat_state.body_surface`,
 *   a braid in the resolved attributes) plus a contradicting player line in
 *   `character_chat_messages` produces the binding block, with both a fence and a
 *   premise check, and NO affordance cue block (that experiment stays off);
 * - the same committed cut says NOTHING on an exchange it is not relevant to, and says
 *   it again the moment the weather makes it relevant — the risk-first selection law
 *   through real stored state rather than a hand-built fixture;
 * - the same cut and the same message rebuild a byte-identical block — the retake
 *   guarantee, without a row to roll back, because nothing about this is persisted.
 */

const mock = vi.hoisted(() => ({ archivist: { value: null as ChatArchivist | null, degraded: false } }));

vi.mock("./chat-memory", async () => {
  const { chatMemoryMockModule } = await import("../test-support/chat-archivist-mock");
  return chatMemoryMockModule(mock);
});

import { loadChatScenario, loadChatState } from "./chat-state/store";
import type { ChatScenario, ChatState } from "./chat-state";
import { previewChatPhysicalGuidance, previewChatPrompt } from "./chat-prompt-preview";
import { PHYSICAL_GUIDANCE_BLOCK_HEADING } from "./chat-physical-guidance-render";
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

/** The cue block's heading — asserted ABSENT: this feature must not revive that one. */
const CUE_HEADING = "Physical detail worth noticing this turn";

/** Dense, thick, shoulder-length — and BRAIDED, which is the fence this suite is about. */
const HAIR_ATTRIBUTES = hairAttributeFixture({
  length: "shoulder_length",
  density: "dense",
  strandThickness: "thick",
  texture: "wavy",
  condition: "healthy",
  arrangement: "braid",
});

/** The player line that gets both the cause and the style wrong (the plan's example). */
const CONTRADICTING_LINE = "The storm drenched your loose hair.";

const ready = await probeIntegrationDb("chat-physical-guidance.int.test", "character_chats");

let fixture: ChatFixture = emptyChatFixture();

const shirtId = () => itemId(fixture, "cottonShirt");

beforeAll(async () => {
  if (!ready) return;
  const seeded = await seedChatFixture({
    slug: "chat-physical-guidance-int",
    userName: "Physical Guidance Int",
    garments: [GARMENT_SEEDS.cottonShirt],
  });
  fixture = {
    ...seeded,
    profile: characterProfileSchema.parse({ ...seeded.profile, attributes: HAIR_ATTRIBUTES }),
  };
});

afterAll(async () => {
  delete process.env.CHAT_PHYSICAL_CONSTRAINTS;
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

/** The guidance block inside the prompt, or [] when there is none. */
function guidanceLines(prompt: string): string[] {
  const start = prompt.indexOf(`\n\n${PHYSICAL_GUIDANCE_BLOCK_HEADING}`);
  if (start < 0) return [];
  const end = prompt.indexOf("\n\n", start + 2 + PHYSICAL_GUIDANCE_BLOCK_HEADING.length);
  return prompt
    .slice(start + 2, end < 0 ? undefined : end)
    .split("\n")
    .slice(1);
}

/** The stored cut, as both the finalizer and the preview see it. */
async function storedCut(chat: ChatSeat): Promise<{ scenario: ChatScenario; state: ChatState }> {
  const scenario = await loadChatScenario(chat.chatId);
  const state = await loadChatState(chat.chatId, fixture.characterId);
  if (!scenario || !state) throw new Error("stored cut missing");
  return { scenario, state };
}

/**
 * A dressed conversation whose hair got soaked in a BATH, with the player's latest
 * line blaming a storm. The shirt makes the wardrobe readable (unknown coverage fails
 * closed and would silence everything); the soaking and its cause are typed committed
 * state, and the wrong premise is the newest row in the transcript.
 *
 * `environment` is the second knob: a still indoor room is the default, and passing an
 * outdoor gale is how the relevance gate's live-force signal gets a real cut.
 */
async function bathedChat(
  playerLine = CONTRADICTING_LINE,
  environment: Record<string, unknown> = { precipitation: "none", indoors: true },
): Promise<ChatSeat> {
  const chat = await newChat(fixture);
  mock.archivist = {
    value: continuity({
      environment,
      surfaceWetness: [{ location: "hair", direction: "increase", degree: 3, cause: "immersion" }],
    }),
    degraded: false,
  };
  await settleChatExchange(fixture, { chat, wornItemIds: [shirtId()] });
  // The newest player line is what the guidance premise-checks.
  await db().insert(characterChatMessages).values({ chatId: chat.chatId, role: "user", content: playerLine });
  return chat;
}

describe.runIf(ready)("the flag — off is today, to the character", () => {
  it("renders no guidance block when CHAT_PHYSICAL_CONSTRAINTS is unset", async () => {
    delete process.env.CHAT_PHYSICAL_CONSTRAINTS;
    delete process.env.CHAT_AFFORDANCE_CUES;
    const chat = await bathedChat();
    const prompt = await narratorPrompt(chat);
    expect(prompt).not.toContain(PHYSICAL_GUIDANCE_BLOCK_HEADING);
    // The soaking really is on the row — the flag is hiding the projection, not the state.
    const { state } = await storedCut(chat);
    expect(bodySurfaceWetnessAt(state.bodySurface, "hair", 0)).toEqual({ status: "known", level: 10_000 });
    expect(prompt).toContain("You're wearing");
  });

  it("adds exactly one block when it is on, and nothing else changes", async () => {
    const chat = await bathedChat();

    delete process.env.CHAT_PHYSICAL_CONSTRAINTS;
    const off = await narratorPrompt(chat);
    process.env.CHAT_PHYSICAL_CONSTRAINTS = "on";
    const on = await narratorPrompt(chat);

    expect(on).toContain(PHYSICAL_GUIDANCE_BLOCK_HEADING);
    // Byte for byte: the ON prompt is the OFF prompt with ONE block spliced in.
    const start = on.indexOf(`\n\n${PHYSICAL_GUIDANCE_BLOCK_HEADING}`);
    const end = on.indexOf("\n\n", start + 2 + PHYSICAL_GUIDANCE_BLOCK_HEADING.length);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(`${on.slice(0, start)}${on.slice(end)}`).toBe(off);
  });
});

describe.runIf(ready)("a braid and a wrong premise, through the committed cut", () => {
  it("fences the style and refuses the storm, and revives no cue block", async () => {
    process.env.CHAT_PHYSICAL_CONSTRAINTS = "on";
    delete process.env.CHAT_AFFORDANCE_CUES;
    const chat = await bathedChat();
    const prompt = await narratorPrompt(chat);

    const lines = guidanceLines(prompt);
    // The precedence sentence leads, then the premise checks, then the fence.
    expect(lines[0]).toContain("override any general appearance");
    expect(lines.join("\n")).toContain("Do not adopt rain as the cause of the wetness in");
    expect(lines.join("\n")).toContain("Do not adopt loose as how");
    expect(lines.join("\n")).toMatch(/Binding constraint: do not describe .* as loose, cascading, streaming, or whipping/u);
    // The committed style may be voiced because the hair is visible.
    expect(lines.join("\n")).toContain("it remains secured in a braid");
    // …and the truth behind the CORRECTIONS is not: the bath never reaches the prompt.
    expect(prompt).not.toMatch(/immersion|a soaking in water/u);

    // The closed cue experiment stays closed: this flag must not turn it back on.
    expect(prompt).not.toContain(CUE_HEADING);
  });

  it("says nothing about a premise when the player line asserts none", async () => {
    process.env.CHAT_PHYSICAL_CONSTRAINTS = "on";
    // The message is ABOUT her hair, so the fence is relevant; it asserts nothing the
    // committed cut contradicts, so there is no premise check.
    const chat = await bathedChat("You tuck your hair behind one ear.");
    const lines = guidanceLines(await narratorPrompt(chat)).join("\n");
    expect(lines).not.toContain("Premise check");
    expect(lines).toContain("Binding constraint");
  });

  it("spends no bytes at all on a turn that is about something else", async () => {
    process.env.CHAT_PHYSICAL_CONSTRAINTS = "on";
    // The braid is still braided and the soaking is still on the row — and neither is
    // what this exchange is about, so the prompt is the flag-off prompt. Repeating a
    // standing fence every turn is the negative priming the closed cue trial paid for.
    const chat = await bathedChat("Tell me about your day.");
    const prompt = await narratorPrompt(chat);
    expect(prompt).not.toContain(PHYSICAL_GUIDANCE_BLOCK_HEADING);

    const { state } = await storedCut(chat);
    expect(bodySurfaceWetnessAt(state.bodySurface, "hair", 0)).toEqual({ status: "known", level: 10_000 });
  });

  it("a live gust makes the motion fence relevant with no player line about it", async () => {
    process.env.CHAT_PHYSICAL_CONSTRAINTS = "on";
    const chat = await bathedChat("Tell me about your day.", {
      wind: "gusting",
      precipitation: "none",
      indoors: false,
    });
    const lines = guidanceLines(await narratorPrompt(chat)).join("\n");
    expect(lines).toMatch(/Binding constraint: do not describe .* as loose, cascading, streaming, or whipping/u);
    expect(lines).not.toContain("Premise check");
  });

  it("never corrects a storyteller line, even one that contradicts the cut", async () => {
    process.env.CHAT_PHYSICAL_CONSTRAINTS = "on";
    const chat = await newChat(fixture);
    mock.archivist = {
      value: continuity({
        environment: { precipitation: "none", indoors: true },
        surfaceWetness: [{ location: "hair", direction: "increase", degree: 3, cause: "immersion" }],
      }),
      degraded: false,
    };
    await settleChatExchange(fixture, { chat, wornItemIds: [shirtId()] });
    await db()
      .insert(characterChatMessages)
      .values({
        chatId: chat.chatId,
        role: "user",
        content: CONTRADICTING_LINE,
        meta: { inputMode: "narrator" },
      });

    const lines = guidanceLines(await narratorPrompt(chat)).join("\n");
    expect(lines).not.toContain("Premise check");
    expect(lines).toContain("Binding constraint");
  });
});

describe.runIf(ready)("a retake reproduces the block, with nothing persisted to roll back", () => {
  it("rebuilds byte-identical lines and fingerprints from the same cut and message", async () => {
    process.env.CHAT_PHYSICAL_CONSTRAINTS = "on";
    const chat = await bathedChat();

    const first = guidanceLines(await narratorPrompt(chat));
    const second = guidanceLines(await narratorPrompt(chat));
    expect(second).toEqual(first);
    expect(first.length).toBeGreaterThan(1);

    // The fingerprints are the retake identity, and they come out of a recompute —
    // there is no `physical_guidance` row, by design.
    const firstPreview = await previewChatPhysicalGuidance({
      chatId: chat.chatId,
      character: { id: fixture.characterId, name: fixture.characterName, profile: fixture.profile },
    });
    const secondPreview = await previewChatPhysicalGuidance({
      chatId: chat.chatId,
      character: { id: fixture.characterId, name: fixture.characterName, profile: fixture.profile },
    });
    expect(secondPreview.selection).toEqual(firstPreview.selection);
    expect(secondPreview.rendered).toEqual(firstPreview.rendered);
    expect(firstPreview.selection.corrections.length).toBe(2);
    expect(firstPreview.selection.constraints.length).toBe(1);
  });

  it("the inspector reports the flag and the whole staircase, read-only", async () => {
    delete process.env.CHAT_PHYSICAL_CONSTRAINTS;
    const chat = await bathedChat();
    const preview = await previewChatPhysicalGuidance({
      chatId: chat.chatId,
      character: { id: fixture.characterId, name: fixture.characterName, profile: fixture.profile },
    });
    // Reported, never obeyed: a developer asking why a fence never appeared needs the
    // answer with the flag off too.
    expect(preview.flagEnabled).toBe(false);
    expect(preview.rendered.length).toBeGreaterThan(0);
    expect(preview.inputAuthority.message).toBe(CONTRADICTING_LINE);
    expect(preview.inputAuthority.eligibleSpans).toBe(1);
    expect(preview.committed).toMatchObject({ arrangement: "braid", wetnessBand: "soaked", wetnessCause: "immersion" });
    expect(preview.candidates.corrections.map((row) => row.grade)).toEqual([
      "contradicted · ordinary_player_narration",
      "contradicted · ordinary_player_narration",
    ]);
  });
});
