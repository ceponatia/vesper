import { describe, expect, it } from "vitest";
import {
  advancePlans,
  chatPlanProposalSchema,
  chatPlansSchema,
  CHAT_PLANS_OPEN_MAX,
  derivePlanSalience,
  fillMissingPlanIds,
  hasSalientPlan,
  mergeChatPlans,
  MINUTES_PER_DAY,
  planHubReason,
  planInvolvesPlayer,
  resolvePlanWhen,
  type ChatPlan,
} from "./chat-plans";

/** A deterministic id generator for the pure merge (contracts inject `mintId`). */
function counter() {
  let n = 0;
  return () => `plan-${++n}`;
}

const NOW = 3 * MINUTES_PER_DAY + 480; // day 3, 08:00

describe("resolvePlanWhen", () => {
  it("resolves a day-offset + day-part to an absolute future target on the story clock", () => {
    const when = resolvePlanWhen({ dayOffset: 1, dayPart: "evening" }, NOW);
    expect(when.kind).toBe("scheduled");
    if (when.kind !== "scheduled") throw new Error("expected scheduled");
    // day 3 start (3*1440) + 1 day + evening (1080)
    expect(when.targetMinutes).toBe(4 * MINUTES_PER_DAY + 1080);
    expect(when.label).toBe("tomorrow evening");
  });

  it("bumps a target that lands at/before the strike one day forward (a plan can't be born in the past)", () => {
    // "this morning" (360) is before NOW (480 on day 3) → pushed to day 4 morning.
    const when = resolvePlanWhen({ dayOffset: 0, dayPart: "morning" }, NOW);
    if (when.kind !== "scheduled") throw new Error("expected scheduled");
    expect(when.targetMinutes).toBe(4 * MINUTES_PER_DAY + 360);
  });

  it("treats a missing day / explicit unscheduled as unscheduled (never goes due)", () => {
    expect(resolvePlanWhen(undefined, NOW).kind).toBe("unscheduled");
    expect(resolvePlanWhen({ unscheduled: true }, NOW).kind).toBe("unscheduled");
  });
});

describe("mergeChatPlans", () => {
  it("mints a new upcoming plan from a proposal with no matching what", () => {
    const proposal = chatPlanProposalSchema.parse([
      { what: "dinner at the pier", participants: ["Mara", "the player"], when: { dayOffset: 1, dayPart: "evening" } },
    ]);
    const { plans } = mergeChatPlans([], proposal, { nowMinutes: NOW, mintId: counter() });
    expect(plans).toHaveLength(1);
    expect(plans[0]).toMatchObject({ id: "plan-1", what: "dinner at the pier", status: "upcoming" });
    expect(plans[0]?.when.kind).toBe("scheduled");
  });

  it("marks an existing plan kept by normalized-what match and reports it as archivistKept", () => {
    const existing: ChatPlan[] = [
      { id: "p1", what: "Dinner at the Pier.", participants: ["Mara", "the player"], when: { kind: "unscheduled" }, status: "upcoming", struckAtMinutes: 0 },
    ];
    const proposal = chatPlanProposalSchema.parse([{ what: "dinner at the pier", status: "kept" }]);
    const { plans, archivistKept } = mergeChatPlans(existing, proposal, { nowMinutes: NOW, mintId: counter() });
    expect(plans[0]?.status).toBe("kept");
    expect(archivistKept).toHaveLength(1);
  });

  it("never mints a plan already resolved (a status-only move matching nothing is a no-op)", () => {
    const proposal = chatPlanProposalSchema.parse([{ what: "some plan that was never struck", status: "kept" }]);
    const { plans } = mergeChatPlans([], proposal, { nowMinutes: NOW, mintId: counter() });
    expect(plans).toHaveLength(0);
  });

  it("evicts the oldest OPEN plan past the open cap", () => {
    const existing: ChatPlan[] = Array.from({ length: CHAT_PLANS_OPEN_MAX }, (_, i) => ({
      id: `p${i}`,
      what: `plan ${i}`,
      participants: [],
      when: { kind: "unscheduled" as const },
      status: "upcoming" as const,
      struckAtMinutes: i,
    }));
    const proposal = chatPlanProposalSchema.parse([{ what: "one more plan" }]);
    const { plans } = mergeChatPlans(existing, proposal, { nowMinutes: NOW, mintId: counter() });
    const open = plans.filter((p) => p.status === "upcoming");
    expect(open).toHaveLength(CHAT_PLANS_OPEN_MAX);
    expect(open.find((p) => p.what === "plan 0")).toBeUndefined(); // oldest open dropped
    expect(open.find((p) => p.what === "one more plan")).toBeDefined();
  });
});

describe("advancePlans", () => {
  const overdue = (participants: string[]): ChatPlan => ({
    id: "p1",
    what: "the plan",
    participants,
    when: { kind: "scheduled", targetMinutes: NOW - MINUTES_PER_DAY, label: "yesterday" },
    status: "upcoming",
    struckAtMinutes: 0,
  });

  it("transitions an overdue PLAYER plan to missed", () => {
    const { plans, justMissed, justKept } = advancePlans([overdue(["Mara", "the player"])], NOW, "the player");
    expect(plans[0]?.status).toBe("missed");
    expect(justMissed).toHaveLength(1);
    expect(justKept).toHaveLength(0);
  });

  it("assumes an overdue NPC↔NPC plan was kept (ruling E)", () => {
    const { plans, justMissed, justKept } = advancePlans([overdue(["Mara", "Kira"])], NOW, "the player");
    expect(plans[0]?.status).toBe("kept");
    expect(justKept).toHaveLength(1);
    expect(justMissed).toHaveLength(0);
  });

  it("leaves a plan within the due grace window alone", () => {
    const dueNow: ChatPlan = { ...overdue(["the player"]), when: { kind: "scheduled", targetMinutes: NOW, label: "now" } };
    const { plans, justMissed } = advancePlans([dueNow], NOW, "the player");
    expect(plans[0]?.status).toBe("upcoming");
    expect(justMissed).toHaveLength(0);
  });

  it("never touches an unscheduled plan", () => {
    const soon: ChatPlan = { ...overdue(["the player"]), when: { kind: "unscheduled" } };
    const { plans } = advancePlans([soon], NOW + 100 * MINUTES_PER_DAY, "the player");
    expect(plans[0]?.status).toBe("upcoming");
  });
});

describe("derivePlanSalience", () => {
  const at = (targetMinutes: number, status: ChatPlan["status"] = "upcoming"): ChatPlan => ({
    id: "p1",
    what: "the plan",
    participants: ["the player"],
    when: { kind: "scheduled", targetMinutes, label: "l" },
    status,
    struckAtMinutes: 0,
  });

  it("classifies imminent / dueNow / justMissed by the target vs the clock", () => {
    expect(derivePlanSalience([at(NOW + 120)], NOW)[0]?.salience).toBe("imminent");
    expect(derivePlanSalience([at(NOW - 60)], NOW)[0]?.salience).toBe("dueNow");
    expect(derivePlanSalience([at(NOW - MINUTES_PER_DAY, "missed")], NOW)[0]?.salience).toBe("justMissed");
  });

  it("drops far-future as merely upcoming and keeps kept/canceled out of the near list", () => {
    expect(derivePlanSalience([at(NOW + 5 * MINUTES_PER_DAY)], NOW)[0]?.salience).toBe("upcoming");
    expect(derivePlanSalience([at(NOW - 60, "kept")], NOW)).toHaveLength(0);
    expect(derivePlanSalience([at(NOW - 60, "canceled")], NOW)).toHaveLength(0);
  });

  it("hasSalientPlan is true only when something is near", () => {
    expect(hasSalientPlan(derivePlanSalience([at(NOW + 120)], NOW))).toBe(true);
    expect(hasSalientPlan(derivePlanSalience([at(NOW + 5 * MINUTES_PER_DAY)], NOW))).toBe(false);
  });
});

describe("planInvolvesPlayer + planHubReason + ids + boundary schema", () => {
  it("matches the player by name or a common alias", () => {
    const p = (who: string[]): ChatPlan => ({ id: "p", what: "w", participants: who, when: { kind: "unscheduled" }, status: "upcoming", struckAtMinutes: 0 });
    expect(planInvolvesPlayer(p(["Alex"]), "Alex")).toBe(true);
    expect(planInvolvesPlayer(p(["you"]), "Alex")).toBe(true);
    expect(planInvolvesPlayer(p(["Mara", "Kira"]), "Alex")).toBe(false);
  });

  it("planHubReason leads with the most-urgent near plan", () => {
    const missed: ChatPlan = { id: "p", what: "dinner", participants: ["the player"], when: { kind: "scheduled", targetMinutes: NOW - MINUTES_PER_DAY, label: "l" }, status: "missed", struckAtMinutes: 0 };
    expect(planHubReason([missed], NOW)).toBe("you skipped past dinner");
    expect(planHubReason([], NOW)).toBeNull();
  });

  it("fillMissingPlanIds mints only for blank ids", () => {
    const plans: ChatPlan[] = [
      { id: "keep", what: "a", participants: [], when: { kind: "unscheduled" }, status: "upcoming", struckAtMinutes: 0 },
      { id: "", what: "b", participants: [], when: { kind: "unscheduled" }, status: "upcoming", struckAtMinutes: 0 },
    ];
    const filled = fillMissingPlanIds(plans, counter());
    expect(filled[0]?.id).toBe("keep");
    expect(filled[1]?.id).toBe("plan-1");
  });

  it("the boundary schema heals a bad row to the empty list", () => {
    expect(chatPlansSchema.parse("not an array")).toEqual([]);
    expect(chatPlansSchema.parse([{ what: "" }])).toEqual([]); // a blank-what element sinks the list
  });
});
