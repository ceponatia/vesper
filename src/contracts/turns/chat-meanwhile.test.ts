import { describe, expect, it } from "vitest";
import {
  applyMeanwhilePlanOutcomes,
  armMeanwhilePass,
  chatMeanwhileSchema,
  degradedChatMeanwhile,
  MEANWHILE_GATE_MINUTES,
  MEANWHILE_MAX_DEVELOPMENTS,
} from "./chat-meanwhile";
import type { ChatPlan } from "./chat-plans";

describe("armMeanwhilePass (ruling A — cumulative ≥ one story day since the last pass)", () => {
  it("arms on a days skip from a fresh chat, not on small skips", () => {
    expect(armMeanwhilePass(0, 4320)).toBe(true); // days
    expect(armMeanwhilePass(0, 540)).toBe(false); // one overnight
    expect(armMeanwhilePass(0, 1080)).toBe(false); // two overnights
    expect(armMeanwhilePass(0, 1620)).toBe(true); // three overnights accumulate past the gate
  });

  it("measures from the LAST pass, not the chat start", () => {
    expect(armMeanwhilePass(4320, 4320 + MEANWHILE_GATE_MINUTES - 1)).toBe(false);
    expect(armMeanwhilePass(4320, 4320 + MEANWHILE_GATE_MINUTES)).toBe(true);
  });
});

describe("chatMeanwhileSchema (degradation — a bad pass is an ordinary skip)", () => {
  it("caps developments and drops malformed rows without failing the parse", () => {
    const out = chatMeanwhileSchema.parse({
      developments: [
        { about: ["Nyx"], event: "closed the café alone; the espresso machine died" },
        { about: [], event: "" }, // malformed → drops
        { about: ["Nyx", "Kira", "Mira"], event: "went shopping" }, // about trims to 2
        { about: ["Kira"], event: "b" },
        { about: ["Mira"], event: "c" },
      ],
      whereabouts: [{ name: "Kira", where: "at her studio" }, null],
      note: "a quiet few days",
    });
    expect(out.developments.length).toBeLessThanOrEqual(MEANWHILE_MAX_DEVELOPMENTS);
    expect(out.developments[0]?.event).toContain("espresso");
    expect(out.developments[1]?.about).toEqual(["Nyx", "Kira"]);
    expect(out.whereabouts).toEqual([{ name: "Kira", where: "at her studio" }]);
  });

  it("degrades a wholly-bad blob to the empty pass", () => {
    expect(chatMeanwhileSchema.parse(42)).toEqual(degradedChatMeanwhile());
    expect(chatMeanwhileSchema.parse({})).toEqual(degradedChatMeanwhile());
  });
});

describe("applyMeanwhilePlanOutcomes (the pass replaces ruling E's assume-kept default)", () => {
  const plan = (what: string, participants: string[], status: ChatPlan["status"] = "upcoming"): ChatPlan => ({
    id: what,
    what,
    participants,
    when: { kind: "scheduled", targetMinutes: 100, label: "tonight" },
    status,
    struckAtMinutes: 0,
  });
  const dev = (planWhat: string, planOutcome: "kept" | "missed") => ({
    about: ["Nyx", "Kira"],
    event: "x",
    planWhat,
    planOutcome,
  });

  it("resolves an open NPC↔NPC plan by normalized what", () => {
    const { plans, resolved } = applyMeanwhilePlanOutcomes(
      [plan("Shopping with Kira", ["Nyx", "Kira"])],
      [dev("shopping with kira", "missed")],
      "Player",
    );
    expect(plans[0]?.status).toBe("missed");
    expect(resolved).toHaveLength(1);
  });

  it("never touches a plan involving the player, a resolved plan, or an unmatched name", () => {
    const input = [
      plan("dinner at the pier", ["Player", "Nyx"]),
      plan("book club", ["Nyx"], "kept"),
      plan("gym", ["Kira"]),
    ];
    const { plans, resolved } = applyMeanwhilePlanOutcomes(
      input,
      [dev("dinner at the pier", "missed"), dev("book club", "missed"), dev("no such plan", "kept")],
      "Player",
    );
    expect(plans.map((p) => p.status)).toEqual(["upcoming", "kept", "upcoming"]);
    expect(resolved).toHaveLength(0);
  });
});
