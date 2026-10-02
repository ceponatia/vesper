import { and, desc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * The #637 exchange trace, proved end to end through the real
 * `submitChatMessage` coordinator — not a unit test of the recorder (that is
 * `chat-exchange-trace.test.ts`, slice A) and not a unit test of the stage/
 * verdict wiring in `chat-reply-stream.ts` (that is this file's sibling
 * `chat-reply-stream.test.ts`). This is the one place that proves the
 * COORDINATOR actually threads the trace through a live exchange: the header
 * ids land, stages land in the order the exchange actually ran them, the
 * narrator fingerprint is real, `meta.traceId` on the persisted reply matches
 * the trace that wrote it, and a degraded recall leg reads differently from an
 * ordinarily empty family.
 *
 * `embedTexts` is the one seam mocked — wrapped (not replaced), so every
 * exchange but the one that opts in with `mockRejectedValueOnce` embeds for
 * real through the demo-mode provider. Everything else (`chat-memory.ts`'s
 * post-turn extraction, the narrator stream) runs for real under the test
 * suite's global `AI_FAKE=1`, exactly like every other chat-lane int test that
 * does not need a specific archivist shape.
 */

vi.mock("@/server/ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/ai")>();
  return { ...actual, embedTexts: vi.fn(actual.embedTexts) };
});

import { embedTexts } from "@/server/ai";
import { parseChatMessageMeta } from "@/contracts/turns/chat-message-meta";
import { characterChatMessages, db } from "@/server/db";
import { submitChatMessage } from "@/server/engine";
import { loadChatExchangeTraces } from "@/server/memory";
import {
  dropChatFixture,
  emptyChatFixture,
  newChat,
  probeIntegrationDb,
  seedChatFixture,
  type ChatFixture,
  type ChatSeat,
} from "@/server/test-support";

const mockEmbedTexts = vi.mocked(embedTexts);

const ready = await probeIntegrationDb("chat-exchange-trace-pipeline.int.test", "character_chat_state");

let fixture: ChatFixture = emptyChatFixture();

beforeAll(async () => {
  if (!ready) return;
  fixture = await seedChatFixture({ slug: "chat-trace-pipeline-int", userName: "Trace Pipeline Int" });
});

afterAll(async () => {
  await dropChatFixture(fixture);
});

/** One `send` exchange, drained to completion (which is what settles it). */
async function drive(chat: ChatSeat, content: string): Promise<void> {
  const result = await submitChatMessage({
    chatId: chat.chatId,
    memoryGroupId: chat.memoryGroupId,
    character: { id: fixture.characterId, name: fixture.characterName, profile: fixture.profile },
    kind: "send",
    content,
  });
  if (!result.ok) throw new Error(`exchange rejected: ${result.code}`);
  for await (const _chunk of result.stream) {
    // drain only — the persisted reply and its trace are read back separately.
  }
}

/** The newest assistant row's parsed meta, for this chat. */
async function latestAssistantMeta(chatId: string) {
  const [row] = await db()
    .select({ meta: characterChatMessages.meta })
    .from(characterChatMessages)
    .where(and(eq(characterChatMessages.chatId, chatId), eq(characterChatMessages.role, "assistant")))
    .orderBy(desc(characterChatMessages.createdAt))
    .limit(1);
  return parseChatMessageMeta(row?.meta);
}

describe.runIf(ready)("the #637 exchange trace, end to end through submitChatMessage", () => {
  it("records one trace per send: header ids, seq-ordered stages, the narrator fingerprint, a matching meta.traceId, and finish ok", async () => {
    const chat = await newChat(fixture);
    await drive(chat, "Hello there, how has your day been?");

    const replyMeta = await latestAssistantMeta(chat.chatId);
    const traceId = replyMeta.traceId;
    expect(traceId).toBeTruthy();
    if (traceId === undefined) throw new Error("expected a traceId on the persisted reply");

    // `flush()` is fire-and-forget (the recorder's own contract): the LAST part —
    // the one carrying `finish` — can still be in flight right after `drive()`
    // resolves. Poll until the assembled trace actually carries it, rather than
    // reading once and racing the flush (the same pattern
    // `chat-exchange-trace-log.int.test.ts` and the inspector int test use).
    const trace = await vi.waitFor(async () => {
      const [loaded] = await loadChatExchangeTraces({ chatId: chat.chatId, traceId });
      expect(loaded?.finish).toBeDefined();
      if (!loaded) throw new Error("expected the trace to load by its own id");
      return loaded;
    });

    // Header.
    expect(trace.header.chatId).toBe(chat.chatId);
    expect(trace.header.operation).toBe("send");
    expect(trace.header.lane).toBe("legacy_chat");
    expect(trace.header.authority).toBe("legacy_chat");
    expect(trace.header.promptMessageId).toBeTruthy();
    expect(trace.header.replyMessageId).toBeTruthy();

    // Stage ordering (by `seq`, chronological): a vanilla solo send touches
    // every one of these, in this relative order.
    const expectedOrder = [
      "admission.lock",
      "prepare.recall",
      "narrator.prompt",
      "narrator.stream",
      "reply.persist",
      "settle.finalize",
      "settle.permission",
    ];
    const seqs: number[] = [];
    for (const stageId of expectedOrder) {
      const seq = trace.stages.find((s) => s.stage === stageId)?.seq;
      expect(seq, `missing stage "${stageId}"`).toBeDefined();
      if (seq !== undefined) seqs.push(seq);
    }
    for (let i = 1; i < seqs.length; i++) {
      const prev = seqs[i - 1];
      const curr = seqs[i];
      if (prev === undefined || curr === undefined) throw new Error("unexpected gap collecting stage seqs");
      expect(curr).toBeGreaterThan(prev);
    }

    // The narrator fingerprint: no prompt text, but a real hash + real units.
    const narrator = trace.header.narrator;
    expect(narrator?.assembledSystemHash).toBeTruthy();
    expect(narrator?.instructionHash).toBeTruthy();
    expect((narrator?.promptUnits ?? []).length).toBeGreaterThan(0);
    for (const unit of narrator?.promptUnits ?? []) {
      expect(unit.hash).toBeTruthy();
      expect(unit.chars).toBeGreaterThanOrEqual(0);
    }

    // `meta.traceId` on the persisted reply names exactly this trace.
    expect(trace.traceId).toBe(traceId);

    // The exchange settled cleanly.
    expect(trace.finish?.kind).toBe("ok");
    expect(trace.outcome).toBe("ok");

    // Coverage for a vanilla send with every optional flag off.
    const coverage = (family: string) => trace.coverage.find((c) => c.family === family);
    expect(coverage("history")?.status).toBe("present");
    expect(coverage("summary")?.status).toBe("empty");
    expect(coverage("garments")?.status).toBe("suppressed");
    expect(coverage("affordances")?.status).toBe("suppressed");
    expect(coverage("physical_guidance")?.status).toBe("suppressed");
    expect(coverage("contact")?.status).toBe("suppressed");
    expect(coverage("visual_state")?.status).toBe("suppressed");
    expect(coverage("relationship")?.status).toBe("suppressed");
    expect(coverage("relationship")?.reason).toBe("policy:solo");
  });

  it("distinguishes a degraded memory.facts/memory.episodes leg (forced embed failure) from an ordinarily empty family in the SAME exchange", async () => {
    const chat = await newChat(fixture);
    mockEmbedTexts.mockRejectedValueOnce(new Error("embedding provider down"));
    await drive(chat, "Do you remember what we talked about last time?");

    const replyMeta = await latestAssistantMeta(chat.chatId);
    const traceId = replyMeta.traceId;
    if (traceId === undefined) throw new Error("expected a traceId on the persisted reply");
    // Poll until the flush carrying `finish` has actually landed — see the
    // sibling test above for why a single read races the fire-and-forget flush.
    const trace = await vi.waitFor(async () => {
      const [loaded] = await loadChatExchangeTraces({ chatId: chat.chatId, traceId });
      expect(loaded?.finish).toBeDefined();
      if (!loaded) throw new Error("expected the trace to load by its own id");
      return loaded;
    });

    const coverage = (family: string) => trace.coverage.find((c) => c.family === family);
    const facts = coverage("memory.facts");
    const episodes = coverage("memory.episodes");
    expect(facts?.status).toBe("degraded");
    expect(facts?.reason).toBeTruthy();
    expect(episodes?.status).toBe("degraded");
    expect(episodes?.reason).toBeTruthy();
    // The same exchange's `summary` family is legitimately EMPTY — a fresh
    // chat's rolling summary does not exist yet. Degraded (couldn't tell) and
    // empty (asked, genuinely nothing) must read as different statuses even
    // though neither one produced anything for the narrator.
    expect(coverage("summary")?.status).toBe("empty");
  });
});
