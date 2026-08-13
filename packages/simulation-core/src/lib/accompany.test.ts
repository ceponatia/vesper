import { describe, expect, it } from "vitest";
import { activityInstanceSchema, type ActivityInstance } from "../contracts/activities";
import { commitmentSchema, type Commitment } from "../contracts/commitments";
import { decideAccompany, ACCOMPANY_ARRIVAL_BUFFER_SECONDS } from "./accompany";

/**
 * Pure walk-with-me acceptance-policy tests (world-ui.plan.md slice 5). No IO —
 * the decision matrix is body-claim × commitment-firmness/due × arrival estimate
 * → accept / decline + PUBLIC face, so every cell is asserted from fixtures. The
 * privacy invariant (a body claim and a due commitment must decline with the SAME
 * public reason — never the private cause) is asserted directly.
 */

const PRIMARY = "actor-primary";
const OTHER = "actor-other";
const SQUARE = "zone-square";
const NOW = 8 * 3_600;
const ARRIVAL = NOW + 300; // a 5-minute walk

function bodyActivity(actorId: string, phase: ActivityInstance["phase"] = "active"): ActivityInstance {
  return activityInstanceSchema.parse({
    id: `act-${actorId}`,
    actionDefinitionId: "stw-x-action-rest",
    actionVersion: 1,
    actorIds: [actorId],
    zoneId: SQUARE,
    phase,
    progressFixedPoint: 0,
    claims: [{ kind: "body" }],
    reservedItemIds: [],
    sourceCommandId: "cmd-x",
  });
}

function attentionActivity(actorId: string): ActivityInstance {
  return activityInstanceSchema.parse({
    id: `act-att-${actorId}`,
    actionDefinitionId: "stw-x-action-chat",
    actionVersion: 1,
    actorIds: [actorId],
    zoneId: SQUARE,
    phase: "active",
    progressFixedPoint: 0,
    claims: [{ kind: "attention", weight: "partial" }],
    reservedItemIds: [],
    sourceCommandId: "cmd-y",
  });
}

function commitment(overrides: {
  actorId?: string;
  latestArrival?: number;
  flexibility?: Commitment["flexibility"];
  status?: Commitment["status"];
}): Commitment {
  return commitmentSchema.parse({
    id: "commit-1",
    actorId: overrides.actorId ?? PRIMARY,
    kind: "shift",
    destinationZoneId: SQUARE,
    window: { latestArrival: overrides.latestArrival ?? NOW + 5 * 3_600 },
    priority: 5,
    flexibility: overrides.flexibility ?? "firm",
    preparationSeconds: 0,
    reliabilityBufferSeconds: 0,
    noticeLeadSeconds: 0,
    status: overrides.status ?? "accepted",
    knowledgeSource: { kind: "authored" },
    sourceCommandId: "cmd-c",
  });
}

const base = { primaryActorId: PRIMARY, primaryName: "Nora", arrivalStorySecond: ARRIVAL };

describe("decideAccompany", () => {
  it("accepts a free primary with nothing due", () => {
    expect(decideAccompany({ ...base, activities: [], commitments: [] })).toEqual({ accept: true });
  });

  it("declines when a claim-holding activity occupies the primary's BODY", () => {
    const decision = decideAccompany({ ...base, activities: [bodyActivity(PRIMARY)], commitments: [] });
    expect(decision.accept).toBe(false);
  });

  it("a body claim held by a claim-holding but non-active phase still blocks (queued/preparing/paused/interrupted)", () => {
    for (const phase of ["queued", "preparing", "paused", "interrupted"] as const) {
      expect(decideAccompany({ ...base, activities: [bodyActivity(PRIMARY, phase)], commitments: [] }).accept).toBe(false);
    }
  });

  it("a TERMINAL-phase body activity no longer blocks (its claims are released)", () => {
    for (const phase of ["completed", "failed", "cancelled"] as const) {
      expect(decideAccompany({ ...base, activities: [bodyActivity(PRIMARY, phase)], commitments: [] })).toEqual({ accept: true });
    }
  });

  it("an ATTENTION-only claim does not block a walk (only a body claim occupies departure)", () => {
    expect(decideAccompany({ ...base, activities: [attentionActivity(PRIMARY)], commitments: [] })).toEqual({ accept: true });
  });

  it("a body claim held by ANOTHER actor never blocks the primary", () => {
    expect(decideAccompany({ ...base, activities: [bodyActivity(OTHER)], commitments: [] })).toEqual({ accept: true });
  });

  it("declines when a FIRM commitment falls due before arrival + the buffer", () => {
    const dueSoon = commitment({ flexibility: "firm", latestArrival: ARRIVAL + ACCOMPANY_ARRIVAL_BUFFER_SECONDS - 1 });
    expect(decideAccompany({ ...base, activities: [], commitments: [dueSoon] }).accept).toBe(false);
  });

  it("declines when a HARD commitment falls due before arrival + the buffer", () => {
    const dueSoon = commitment({ flexibility: "hard", latestArrival: ARRIVAL });
    expect(decideAccompany({ ...base, activities: [], commitments: [dueSoon] }).accept).toBe(false);
  });

  it("accepts when the firm commitment's deadline is comfortably AFTER arrival + the buffer", () => {
    const later = commitment({ flexibility: "firm", latestArrival: ARRIVAL + ACCOMPANY_ARRIVAL_BUFFER_SECONDS + 1 });
    expect(decideAccompany({ ...base, activities: [], commitments: [later] })).toEqual({ accept: true });
  });

  it("a SOFT / NEGOTIABLE commitment due now never declines (firmness is the gate)", () => {
    for (const flexibility of ["soft", "negotiable"] as const) {
      const due = commitment({ flexibility, latestArrival: NOW });
      expect(decideAccompany({ ...base, activities: [], commitments: [due] })).toEqual({ accept: true });
    }
  });

  it("a firm commitment for ANOTHER actor, or already resolved, never declines the primary", () => {
    const otherActor = commitment({ actorId: OTHER, flexibility: "hard", latestArrival: NOW });
    const resolved = commitment({ flexibility: "hard", latestArrival: NOW, status: "kept" });
    expect(decideAccompany({ ...base, activities: [], commitments: [otherActor, resolved] })).toEqual({ accept: true });
  });

  it("a decline's PUBLIC face names the primary and never leaks the private cause (body vs. commitment read identically)", () => {
    const byClaim = decideAccompany({ ...base, activities: [bodyActivity(PRIMARY)], commitments: [] });
    const byCommitment = decideAccompany({
      ...base,
      activities: [],
      commitments: [commitment({ flexibility: "hard", latestArrival: NOW })],
    });
    expect(byClaim.accept).toBe(false);
    expect(byCommitment.accept).toBe(false);
    if (byClaim.accept || byCommitment.accept) throw new Error("expected declines");
    expect(byClaim.publicReason).toBe("Nora can't come with you right now.");
    // The two causes are indistinguishable to the player — no private leak (§14.4).
    expect(byCommitment.publicReason).toBe(byClaim.publicReason);
    expect(byClaim.legalAlternatives).toEqual(["go on your own", "wait a while"]);
    expect(byClaim.publicReason).not.toMatch(/shift|commitment|activity|rest|claim/i);
  });
});
