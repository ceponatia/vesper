import { newId } from "@/lib/ids";
import { characterChatMessages, db } from "@/server/db";
import { startExchangeTrace } from "./chat-exchange-trace";
import { loadChatExchangeTraces } from "@/server/memory";
import {
  dropRoutedSimChat,
  emptyRoutedSimChat,
  probeIntegrationDb,
  routeSimChat,
  seedRoutedSimChat,
  type RoutedSimChatFixture,
} from "@/server/test-support";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { runShadowChatExchange } from "./sim-shadow";

/**
 * #637 slice C — the shadow pass as a recorded stage on the LEGACY exchange's
 * own trace (acceptance #6): `post_turn.shadow` lands with a success count on a
 * `successor_shadow` chat, and nothing at all lands on an ordinary `legacy_chat`
 * chat, because the absence is not meaningful there.
 *
 * This calls `runShadowChatExchange` directly against a trace built the same
 * way a legacy exchange's own recorder would be (B's wiring is a sibling slice
 * and is not present in this worktree) — the owning-layer test for this file's
 * behavior, per vesper-testing.
 */

const authState = vi.hoisted(() => ({
  user: { id: "", email: "", name: "Sim Shadow Trace Int", role: "user" as const },
}));

vi.mock("@/server/auth", async () => (await import("@/server/test-support")).routeAuthModule(authState));

import { POST as chatsCreate } from "@/app/api/chats/route";

const ready = await probeIntegrationDb("sim-shadow-trace.int.test", "character_chats");

let fixture: RoutedSimChatFixture = emptyRoutedSimChat(chatsCreate);

beforeAll(async () => {
  if (!ready) return;
  // One shadow-routed chat, one left at the `legacy_chat` default.
  fixture = await seedRoutedSimChat({ slug: "sim-shadow-trace", authState, chatsCreate, chats: 2 });
  await routeSimChat({ chatId: fixture.chatIds[0] ?? "", byUserId: fixture.userId, authority: "successor_shadow" });
});

afterAll(async () => {
  if (!ready || !fixture.userId) return;
  await dropRoutedSimChat(fixture);
});

/** A bare assistant row for the shadow pass to anchor its comparison against. */
async function seedAssistantReply(chatId: string, content: string): Promise<string> {
  const id = newId();
  await db().insert(characterChatMessages).values({ id, chatId, speakerCharacterId: null, role: "assistant", content });
  return id;
}

async function waitForTrace(chatId: string, traceId: string) {
  let traces = await loadChatExchangeTraces({ chatId, traceId });
  for (let attempt = 0; attempt < 400 && traces.length === 0; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    traces = await loadChatExchangeTraces({ chatId, traceId });
  }
  return traces;
}

describe.runIf(ready)("R(#637) shadow pass as a recorded post_turn stage", () => {
  it("records post_turn.shadow with a success count on a successor_shadow chat", async () => {
    const chatId = fixture.chatIds[0] ?? "";
    const assistantMessageId = await seedAssistantReply(chatId, "Good morning, Ana.");

    const trace = startExchangeTrace({ chatId, operation: "send", authority: "legacy_chat", lane: "legacy_chat" });
    const outcome = await runShadowChatExchange({
      chatId,
      userId: fixture.userId,
      assistantMessageId,
      content: "Good morning, Ana.",
      exchangeTrace: trace,
    });
    expect(outcome.ran).toBe(true);
    expect(outcome.rows).toBeGreaterThan(0);
    trace.finish({ kind: "ok" });
    trace.flush();

    const traces = await waitForTrace(chatId, trace.traceId);
    expect(traces).toHaveLength(1);
    const shadowStage = traces[0]?.stages.find((s) => s.stage === "post_turn.shadow");
    expect(shadowStage).toMatchObject({ phase: "post_turn", status: "success", count: outcome.rows });
  });

  it("records nothing on an ordinary legacy_chat chat — the absence is not meaningful there", async () => {
    const chatId = fixture.chatIds[1] ?? "";
    const assistantMessageId = await seedAssistantReply(chatId, "Hello there.");

    const trace = startExchangeTrace({ chatId, operation: "send", authority: "legacy_chat", lane: "legacy_chat" });
    // A marker stage so the trace itself has something to flush — otherwise an
    // empty flush writes no row at all, which would prove nothing about the
    // shadow leg specifically.
    trace.record({ stage: "state.load", phase: "admission", status: "success" });
    const outcome = await runShadowChatExchange({
      chatId,
      userId: fixture.userId,
      assistantMessageId,
      content: "Hello there.",
      exchangeTrace: trace,
    });
    expect(outcome.ran).toBe(false);
    trace.finish({ kind: "ok" });
    trace.flush();

    const traces = await waitForTrace(chatId, trace.traceId);
    expect(traces).toHaveLength(1);
    expect(traces[0]?.stages.map((s) => s.stage)).toEqual(["state.load"]);
    expect(traces[0]?.stages.some((s) => s.stage === "post_turn.shadow")).toBe(false);
  });
});
