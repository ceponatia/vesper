import { describe, expect, it } from "vitest";
import { agentFailureSchema, agentRunSchema } from "@/contracts/turns/agent-failure";
import { compositionFallbackSchema } from "@/contracts/turns/composition-fallback";
import { buildEventRow } from "./events";

/**
 * The telemetry privacy boundary (issue #195, docs/database/README.md
 * §Operational tables): production `events` rows must carry no user-authored or
 * roleplay-derived text, and the development rows the chat inspector reads must
 * still carry it.
 *
 * Two defects this kills:
 *  - a `logEvent` that stores `content` unconditionally (or that reads the
 *    environment wrongly), which puts the player's own words back in the
 *    production table one call site at a time;
 *  - a contract field left REQUIRED after its value moved to `content`, which
 *    makes every production row fail the reader's `parseOr` and silently empties
 *    the admin inspector — a failure with no error anywhere.
 */

describe("buildEventRow", () => {
  it("stores content alongside the payload outside production", () => {
    const row = buildEventRow(
      "retrieval",
      { kind: "facts", hitIds: ["f1"] },
      { content: { query: "what did she say about the harbor" } },
      false,
    );
    expect(row.payload).toEqual({ kind: "facts", hitIds: ["f1"], query: "what did she say about the harbor" });
  });

  it("stores no content key at all in production", () => {
    const row = buildEventRow(
      "retrieval",
      { kind: "facts", hitIds: ["f1"] },
      { content: { query: "what did she say about the harbor" } },
      true,
    );
    expect(row.payload).toEqual({ kind: "facts", hitIds: ["f1"] });
    expect(JSON.stringify(row.payload)).not.toContain("harbor");
  });

  it("keeps the diagnostic payload authoritative — content can never shadow it", () => {
    const row = buildEventRow("agent_run", { summary: "3 facts" }, { content: { summary: "player text" } }, false);
    expect(row.payload.summary).toBe("3 facts");
  });

  it("carries the chat id when the caller has one, and null when it does not", () => {
    expect(buildEventRow("image.character_scene", {}, { chatId: "chat-1" }, true).chatId).toBe("chat-1");
    expect(buildEventRow("retrieval", {}, undefined, true).chatId).toBeNull();
    expect(buildEventRow("retrieval", {}, { chatId: null }, false).chatId).toBeNull();
  });
});

describe("production-scrubbed rows still parse for the inspector", () => {
  it("an agent_failure row without its detail keeps kind, cause and the rest", () => {
    const scrubbed = buildEventRow(
      "agent_failure",
      { legId: "chat_memory_scribe", kind: "timeout", cause: "model_slow", chatId: "chat-1", timeoutMs: 12_000 },
      { chatId: "chat-1", content: { detail: "the model said this back to us" } },
      true,
    );
    const parsed = agentFailureSchema.parse(scrubbed.payload);
    expect(parsed.cause).toBe("model_slow");
    expect(parsed.detail).toBe("");
  });

  it("an agent_run row without its summary or details keeps the leg and its latency", () => {
    const scrubbed = buildEventRow(
      "agent_run",
      { legId: "chat_continuity", modelId: "m", latencyMs: 4_200 },
      { chatId: "chat-1", content: { summary: "3 facts · 1 episode", details: [{ label: "Facts (1)", items: ["…"] }] } },
      true,
    );
    const parsed = agentRunSchema.parse(scrubbed.payload);
    expect(parsed.legId).toBe("chat_continuity");
    expect(parsed.latencyMs).toBe(4_200);
    expect(parsed.summary).toBe("");
    expect(parsed.details).toEqual([]);
  });

  it("a composition_fallback row without its detail keeps the tallied site and code", () => {
    const scrubbed = buildEventRow(
      "composition_fallback",
      { site: "travel", code: "traveled_alone", chatId: "chat-1" },
      { chatId: "chat-1", content: { detail: "the primary refused: …" } },
      true,
    );
    const parsed = compositionFallbackSchema.parse(scrubbed.payload);
    expect(parsed.site).toBe("travel");
    expect(parsed.code).toBe("traveled_alone");
    expect(parsed.detail).toBe("");
  });
});
