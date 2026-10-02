import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { characterChatMessages, db } from "@/server/db";
import { loadChatExchangeTraces } from "@/server/memory";
import {
  dropRoutedSimChat,
  emptyRoutedSimChat,
  probeIntegrationDb,
  routeSimChat,
  seedRoutedSimChat,
  type RoutedSimChatFixture,
} from "@/server/test-support";
import { runSimChatExchange } from "./sim-exchange";

/**
 * #637 slice C — the sim-routed exchange's own durable trace. One admitted
 * `runSimChatExchange` call, asserted end to end against the REAL recorder and
 * read model (no mocking of either): lane `successor`, the sim header's branch
 * + cut ids, the ordered `sim.*` stages slice A's vocabulary defines, a
 * `meta.traceId` on the persisted reply that matches the trace, and a clean
 * `finish`.
 *
 * `flush()` is fire-and-forget (the recorder's own contract), so this suite
 * polls the read model rather than asserting immediately after the call —
 * the same pattern `chat-exchange-trace-log.int.test.ts` uses.
 */

const authState = vi.hoisted(() => ({
  user: { id: "", email: "", name: "Sim Exchange Trace Int", role: "user" as const },
}));

vi.mock("@/server/auth", async () => (await import("@/server/test-support")).routeAuthModule(authState));

import { ROLLOUT_BRANCH_ID } from "@/server/engine";
import { POST as chatsCreate } from "@/app/api/chats/route";

const ready = await probeIntegrationDb("sim-exchange.int.test", "character_chats");

let fixture: RoutedSimChatFixture = emptyRoutedSimChat(chatsCreate);

beforeAll(async () => {
  if (!ready) return;
  fixture = await seedRoutedSimChat({ slug: "sim-exchange-trace", authState, chatsCreate });
  await routeSimChat({ chatId: fixture.chatId, byUserId: fixture.userId, authority: "successor_narrative_view" });
});

afterAll(async () => {
  if (!ready || !fixture.userId) return;
  await dropRoutedSimChat(fixture);
});

/** Poll the read model for one trace by id — `flush()` is fire-and-forget. */
async function waitForTrace(chatId: string, traceId: string | undefined) {
  if (!traceId) return [];
  let traces = await loadChatExchangeTraces({ chatId, traceId });
  for (let attempt = 0; attempt < 400 && traces.length === 0; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    traces = await loadChatExchangeTraces({ chatId, traceId });
  }
  return traces;
}

async function replyTraceId(messageId: string): Promise<string | undefined> {
  const [row] = await db()
    .select({ meta: characterChatMessages.meta })
    .from(characterChatMessages)
    .where(eq(characterChatMessages.id, messageId));
  return (row?.meta as { traceId?: string } | null)?.traceId;
}

describe.runIf(ready)("R(#637) sim-exchange trace", () => {
  it("records lane, sim header, ordered sim.* stages, a matching reply traceId, and finish ok", async () => {
    const chatId = fixture.chatId;

    const result = await runSimChatExchange({
      chatId,
      userId: fixture.userId,
      speakerCharacterId: fixture.characterId,
      mode: "send",
      message: "I look around the kitchen.",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // The reply row's own meta carries the trace id (#637 acceptance #5).
    const traceId = await replyTraceId(result.messageId);
    expect(traceId?.length ?? 0).toBeGreaterThan(0);

    const traces = await waitForTrace(chatId, traceId);
    expect(traces).toHaveLength(1);
    const assembled = traces[0];
    expect(assembled?.traceId).toBe(traceId);
    expect(assembled?.unreadableParts).toBe(0);
    expect(assembled?.header).toMatchObject({
      traceId,
      chatId,
      operation: "send",
      authority: "successor_narrative_view",
      lane: "successor",
    });
    expect(assembled?.header.sim?.branchId).toBe(ROLLOUT_BRANCH_ID);
    // A fresh chat's mapped pair starts co-present on the rollout world, so this
    // send renders through the co-present cut — a real committed cutId, not the
    // solo lane's empty one.
    expect(assembled?.header.sim?.cutId).toBe(result.cutId);
    expect(result.cutId.length).toBeGreaterThan(0);
    expect(assembled?.header.sim?.branchVersion).toBeGreaterThanOrEqual(0);
    expect(assembled?.header.sim?.throughSequence).toBeGreaterThanOrEqual(assembled?.header.sim?.fromSequence ?? 0);

    // The real sim stage ids, mapped onto what the co-present path actually ran,
    // in the order it ran them.
    expect(assembled?.stages.map((s) => s.stage)).toEqual([
      "sim.admission",
      "sim.turn",
      "sim.context",
      "sim.narrator",
      "sim.persist",
    ]);
    const byStage = new Map(assembled?.stages.map((s) => [s.stage, s]));
    // No legal command matched this line — the admission stage still ran (success),
    // just admitted nothing.
    expect(byStage.get("sim.admission")).toMatchObject({ status: "success", count: 0 });
    expect(byStage.get("sim.turn")).toMatchObject({ status: "success" });
    // AI_FAKE demo mode always degrades the render (no live model call) — the
    // narrator stage's stable reason is one of its own diagnostic codes, not a
    // bare "it failed".
    const narratorStage = byStage.get("sim.narrator");
    expect(narratorStage?.status).toBe("degraded");
    expect(narratorStage?.reason?.length ?? 0).toBeGreaterThan(0);
    expect(byStage.get("sim.persist")).toMatchObject({ status: "success" });

    // Coverage: every family this slice records for the co-present path.
    const families = assembled?.coverage.map((c) => c.family).sort();
    expect(families).toEqual(
      ["actor_state", "directives", "garments", "history", "memory.episodes", "relationship", "schedule_time", "scene", "summary"].sort(),
    );

    expect(assembled?.finish).toMatchObject({ kind: "ok" });
    expect(assembled?.outcome).toBe("degraded"); // the narrator stage's own degrade (AI_FAKE) marks the exchange
  });

  it("retake re-renders the same cut under a fresh trace with its own meta.traceId", async () => {
    const chatId = fixture.chatId;
    const retaken = await runSimChatExchange({
      chatId,
      userId: fixture.userId,
      speakerCharacterId: fixture.characterId,
      mode: "retake",
    });
    expect(retaken.ok).toBe(true);
    if (!retaken.ok) return;

    const traceId = await replyTraceId(retaken.messageId);
    expect(traceId?.length ?? 0).toBeGreaterThan(0);

    const traces = await waitForTrace(chatId, traceId);
    expect(traces).toHaveLength(1);
    const assembled = traces[0];
    expect(assembled?.header.operation).toBe("rerun");
    expect(assembled?.header.sim?.cutId).toBe(retaken.cutId);
    expect(assembled?.stages.map((s) => s.stage)).toEqual(["sim.cut", "sim.context", "sim.narrator", "sim.persist"]);
    expect(assembled?.finish).toMatchObject({ kind: "ok" });
  });
});
