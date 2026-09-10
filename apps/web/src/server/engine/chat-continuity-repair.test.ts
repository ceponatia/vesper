import { describe, expect, it } from "vitest";
import { planMemoryRepair } from "./chat-continuity-repair";

// The memory leg's decision matrix, pure. Chat memory is filed per EXCHANGE and
// stored under the reply's id, so which anchor a transcript edit touches is a
// function of the edited line's role, the operation, and the line that follows it
// — the DB-bound repair around it is covered in the int suites.

const reply = { id: "reply-1", role: "assistant" as const };
const player = { id: "player-1", role: "user" as const };
const nextPlayerLine = { id: "player-2", role: "user" as const };
const nextReply = { id: "reply-2", role: "assistant" as const };

describe("planMemoryRepair — an assistant line anchors its own exchange", () => {
  it("re-files the edited reply itself, from its new wording", () => {
    expect(planMemoryRepair({ message: reply, operation: "edit", following: null })).toEqual({
      action: "reextract",
      anchorId: "reply-1",
    });
  });

  it("retracts only when the reply is deleted (no anchor survives to file under)", () => {
    expect(planMemoryRepair({ message: reply, operation: "delete", following: null })).toEqual({
      action: "reconcile",
      anchorId: "reply-1",
    });
  });

  it("never looks forward: the line after a reply belongs to a different exchange", () => {
    expect(planMemoryRepair({ message: reply, operation: "edit", following: nextPlayerLine })).toEqual({
      action: "reextract",
      anchorId: "reply-1",
    });
  });
});

describe("planMemoryRepair — a player line's derivative lives on the reply that answered it", () => {
  it("re-files the FOLLOWING reply when the player's line is edited", () => {
    expect(planMemoryRepair({ message: player, operation: "edit", following: nextReply })).toEqual({
      action: "reextract",
      anchorId: "reply-2",
    });
  });

  it("re-files the following reply on a delete too (the reply survives, its player half does not)", () => {
    expect(planMemoryRepair({ message: player, operation: "delete", following: nextReply })).toEqual({
      action: "reextract",
      anchorId: "reply-2",
    });
  });

  it("does nothing when another player line follows: no exchange closed over this one", () => {
    expect(planMemoryRepair({ message: player, operation: "edit", following: nextPlayerLine })).toEqual({
      action: "none",
    });
  });

  it("does nothing for the newest player line — nothing has extracted it yet", () => {
    expect(planMemoryRepair({ message: player, operation: "delete", following: null })).toEqual({ action: "none" });
  });
});
