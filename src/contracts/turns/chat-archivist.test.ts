import { describe, expect, it } from "vitest";
import {
  chatArchivistSchema,
  chatMemoryTraceSchema,
  CHAT_ARCHIVIST_MAX_FACTS,
  CHAT_ARCHIVIST_MAX_QUERIES,
  degradedChatArchivist,
  emptyChatMemoryTrace,
} from "./chat-archivist";

describe("chatArchivistSchema (parsed-empty IS the degraded fallback)", () => {
  it("parses {} to the degraded default", () => {
    expect(chatArchivistSchema.parse({})).toEqual(degradedChatArchivist());
  });

  it("keeps a well-formed extraction", () => {
    const parsed = chatArchivistSchema.parse({
      episodeSummary: "They talked about Prague.",
      facts: [{ subjectName: "the player", subjectKind: "player", text: "The player's sister marries in Prague." }],
      memoryQueries: ["the sister's wedding"],
      attributeChanges: [{ participantName: "Mara", attributeId: "hair.length", value: "short" }],
    });
    expect(parsed.episodeSummary).toBe("They talked about Prague.");
    expect(parsed.facts).toHaveLength(1);
    expect(parsed.memoryQueries).toEqual(["the sister's wedding"]);
    expect(parsed.attributeChanges).toHaveLength(1);
  });

  it("caps facts and queries, and drops a bad leaf without rejecting the object", () => {
    const parsed = chatArchivistSchema.parse({
      episodeSummary: 42, // wrong type ⇒ caught to ""
      facts: Array.from({ length: CHAT_ARCHIVIST_MAX_FACTS + 3 }, (_, i) => ({
        subjectName: `s${i}`,
        text: `fact ${i}`,
      })),
      memoryQueries: Array.from({ length: CHAT_ARCHIVIST_MAX_QUERIES + 2 }, (_, i) => `q${i}`),
    });
    expect(parsed.episodeSummary).toBe("");
    expect(parsed.facts).toHaveLength(CHAT_ARCHIVIST_MAX_FACTS);
    expect(parsed.memoryQueries).toHaveLength(CHAT_ARCHIVIST_MAX_QUERIES);
  });
});

describe("chatMemoryTraceSchema", () => {
  it("parses {} to a clean empty trace", () => {
    expect(chatMemoryTraceSchema.parse({})).toEqual(emptyChatMemoryTrace());
    expect(emptyChatMemoryTrace().degraded).toBe(false);
    expect(emptyChatMemoryTrace().factsAdded).toBe(0);
  });
});
