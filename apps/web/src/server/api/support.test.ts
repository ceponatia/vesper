import { describe, expect, it } from "vitest";
import { SUPPORT_MEMORY_REDACTION, toSupportMemoryMetadata } from "./support";

describe("cross-account support DTOs", () => {
  it("returns only allow-listed metadata and redacts sensitive memory content", () => {
    const result = toSupportMemoryMetadata({
      id: "fact-1",
      kind: "fact",
      status: "active",
      createdAt: new Date("2026-07-26T12:00:00.000Z"),
      text: "the user's private memory",
      summary: "private rolling summary",
      prompt: "full narrator prompt",
      memory: { facts: ["secret"] },
      embedding: [0.1, 0.2],
      detail: "provider diagnostic",
      tags: ["private"],
      confidence: 0.9,
    });

    expect(result).toEqual({
      id: "fact-1",
      kind: "fact",
      status: "active",
      createdAt: "2026-07-26T12:00:00.000Z",
      content: SUPPORT_MEMORY_REDACTION,
    });
    expect(Object.keys(result).sort()).toEqual(["content", "createdAt", "id", "kind", "status"]);
    expect(result).not.toHaveProperty("text");
    expect(result).not.toHaveProperty("summary");
    expect(result).not.toHaveProperty("prompt");
    expect(result).not.toHaveProperty("memory");
    expect(result).not.toHaveProperty("embedding");
    expect(result).not.toHaveProperty("detail");
    expect(JSON.stringify(result)).not.toContain("private memory");
  });
});
