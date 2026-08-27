import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatEngineAuthorityState } from "@vesper/simulation-core/contracts/authority";
import { log } from "@/server/log";

// Each of the four state-read seams must
// degrade a thrown DB read to a null panel PLUS a distinct `log.warn`
// diagnostic (docs/resilience.md §7 — degrade at every trust boundary), never
// a 500. The authority guard stays OUTSIDE the wrap, so this mocks a routed
// authority (the guard passes) and forces every `db()` inside the wrap to
// throw. Pure — no Postgres.

const hoisted = vi.hoisted(() => ({
  routed: {
    authority: "successor_narrative_view",
    ragEligibility: false,
    simBranchId: "branch-degrade",
    simPlayerActorId: "actor-player",
    simPrimaryActorId: "actor-primary",
  } as ChatEngineAuthorityState,
}));

// The seam reads authority through `./chat-authority` directly — mock the
// module (by path) so a routed chat reaches the try, without touching the db.
vi.mock("@/server/engine/chat-authority", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/engine/chat-authority")>();
  return {
    ...actual,
    readChatEngineAuthority: async (): Promise<ChatEngineAuthorityState> => hoisted.routed,
  };
});

// Every `db()` inside the wrap throws — the malformed-row / missing-branch
// failure mode, uniform across all four seams (two of which never parse a row,
// so a data throw is not otherwise reachable).
vi.mock("@/server/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/db")>();
  return {
    ...actual,
    db: () => {
      throw new Error("simulated read failure");
    },
  };
});

import {
  readSimChatMeters,
  readSimChatOutfit,
  readSimChatPresence,
  readSimChatRelationship,
} from "@/server/engine";

describe("sim read seams degrade to null with a per-seam diagnostic (slice 1)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function expectSeamDegrades(
    read: (chatId: string) => Promise<unknown>,
    message: string,
  ): Promise<void> {
    const warn = vi.spyOn(log, "warn");
    const result = await read("chat-degrade");
    expect(result).toBeNull();
    expect(warn).toHaveBeenCalledWith(
      "engine.sim",
      message,
      expect.objectContaining({ chatId: "chat-degrade", error: "simulated read failure" }),
    );
  }

  it("presence degrades to null", async () => {
    await expectSeamDegrades(readSimChatPresence, "presence read degraded to null");
  });

  it("meters degrade to null", async () => {
    await expectSeamDegrades(readSimChatMeters, "meters read degraded to null");
  });

  it("relationship degrades to null", async () => {
    await expectSeamDegrades(readSimChatRelationship, "relationship read degraded to null");
  });

  it("outfit degrades to null", async () => {
    await expectSeamDegrades(readSimChatOutfit, "outfit read degraded to null");
  });
});
