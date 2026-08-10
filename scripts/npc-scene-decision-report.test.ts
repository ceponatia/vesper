import { describe, expect, it } from "vitest";
import {
  emptyNpcSceneDecisionPayload,
  type NpcSceneDecisionActionKind,
  type NpcSceneDecisionDropReason,
  type NpcSceneDecisionMode,
  type NpcSceneDecisionPayload,
  type NpcSceneDecisionResolution,
  type NpcSceneDecisionStatus,
} from "@/server/engine";
import {
  aggregateNpcSceneDecisionReport,
  reviewCorpusLine,
  type NpcSceneDecisionModeReport,
  type NpcSceneDecisionReport,
  type NpcSceneDecisionReportRow,
  type NpcSceneDecisionUsageTelemetry,
} from "./npc-scene-decision-report";

/**
 * The shadow-gate arithmetic, pinned without a database: every figure the owner
 * reads before movement authority is enabled is computed here, so a wrong
 * denominator is a failing test rather than a bad rollout decision.
 */

type Action = NpcSceneDecisionPayload["actions"][number];
type Drop = NpcSceneDecisionPayload["drops"][number];

interface RowOverrides {
  readonly mode?: NpcSceneDecisionMode;
  readonly status?: NpcSceneDecisionStatus;
  readonly createdAt?: string;
  readonly telemetry?: Partial<NpcSceneDecisionPayload["telemetry"]>;
  readonly usage?: NpcSceneDecisionUsageTelemetry;
  readonly slots?: NpcSceneDecisionPayload["slots"];
  readonly actions?: Action[];
  readonly drops?: Drop[];
}

let sequence = 0;

/** One envelope row. Defaults to a fired shadow decision with real telemetry. */
function row(overrides: RowOverrides = {}): NpcSceneDecisionReportRow {
  sequence += 1;
  const payload = emptyNpcSceneDecisionPayload();
  return {
    chatId: "chat_1",
    assistantMessageId: `msg_${sequence}`,
    createdAt: overrides.createdAt ?? "2026-08-05T00:00:00.000Z",
    mode: overrides.mode ?? "shadow",
    status: overrides.status ?? "evaluated",
    storyMinute: 0,
    replyHash: "a".repeat(64),
    payload: {
      ...payload,
      slots: overrides.slots ?? payload.slots,
      actions: overrides.actions ?? [],
      drops: overrides.drops ?? [],
      telemetry: { ...payload.telemetry, model: "test/model", ...overrides.telemetry },
    },
    usage: overrides.usage ?? {},
  };
}

function action(kind: NpcSceneDecisionActionKind, resolution: NpcSceneDecisionResolution, detail = ""): Action {
  return { kind, span: { start: 0, end: 1 }, quoteHash: "", summary: "", resolution, detail, contactRows: [] };
}

function drop(
  reason: NpcSceneDecisionDropReason,
  candidate: "movement" | "contact" = "contact",
  evidence = "",
): Drop {
  return { candidate, reason, field: "", detail: "", evidence };
}

function groupFor(report: NpcSceneDecisionReport, mode: NpcSceneDecisionMode): NpcSceneDecisionModeReport {
  const found = report.groups.find((group) => group.mode === mode);
  if (!found) throw new Error(`report carries no ${mode} group`);
  return found;
}

/** A fired row that took `latencyMs` in the classifier. */
function latency(latencyMs: number): NpcSceneDecisionReportRow {
  return row({ telemetry: { latencyMs } });
}

describe("aggregateNpcSceneDecisionReport", () => {
  it("reports nothing rather than zeros for an empty window", () => {
    const report = aggregateNpcSceneDecisionReport([]);
    expect(report.envelopes).toBe(0);
    expect(report.window).toBeNull();
    expect(report.groups).toEqual([]);
    expect(report.pricing).toEqual({ inputPerMillionUsd: null, outputPerMillionUsd: null });
  });

  it("covers the window actually observed, whatever order the rows arrive in", () => {
    const report = aggregateNpcSceneDecisionReport([
      row({ createdAt: "2026-08-06T12:00:00.000Z" }),
      row({ createdAt: "2026-08-05T09:30:00.000Z" }),
      row({ createdAt: "2026-08-07T23:59:59.999Z" }),
    ]);
    expect(report.window).toEqual({ from: "2026-08-05T09:30:00.000Z", to: "2026-08-07T23:59:59.999Z" });
    expect(groupFor(report, "shadow").window?.from).toBe("2026-08-05T09:30:00.000Z");
  });

  it("splits every figure by mode, shadow first, and skips a mode with no rows", () => {
    const report = aggregateNpcSceneDecisionReport([
      row({ mode: "shadow" }),
      row({ mode: "shadow", status: "trigger_miss" }),
      row({ mode: "authority" }),
    ]);
    expect(report.groups.map((group) => group.mode)).toEqual(["shadow", "authority"]);
    expect(groupFor(report, "shadow").envelopes).toBe(2);
    expect(groupFor(report, "shadow").triggerFireRate).toBeCloseTo(0.5);
    // Authority's own denominator — never diluted by the shadow rows beside it.
    expect(groupFor(report, "authority").envelopes).toBe(1);
    expect(groupFor(report, "authority").triggerFireRate).toBe(1);

    const shadowOnly = aggregateNpcSceneDecisionReport([row({ mode: "shadow" })]);
    expect(shadowOnly.groups).toHaveLength(1);
  });

  it("derives fire, miss, degraded, and timeout rates from the right denominators", () => {
    const rows = [
      ...Array.from({ length: 6 }, () => row()),
      row({ status: "degraded", telemetry: { model: "" } }),
      row({ status: "degraded", telemetry: { timedOut: true } }),
      row({ status: "trigger_miss", telemetry: { model: "" } }),
      row({ status: "trigger_miss", telemetry: { model: "" } }),
    ];
    const group = groupFor(aggregateNpcSceneDecisionReport(rows), "shadow");

    expect(group.envelopes).toBe(10);
    expect(group.status).toEqual({ evaluated: 6, degraded: 2, trigger_miss: 2 });
    expect(group.fired).toBe(8);
    // Fired over ALL replies; degraded and timeout over the fired ones only.
    expect(group.triggerFireRate).toBeCloseTo(0.8);
    expect(group.triggerMisses).toBe(2);
    expect(group.triggerMissRate).toBeCloseTo(0.2);
    expect(group.degradedRateAmongFired).toBeCloseTo(0.25);
    expect(group.timedOut).toBe(1);
    expect(group.timeoutRateAmongFired).toBeCloseTo(0.125);
  });

  it("has no percentile for an empty sample and one value for a single sample", () => {
    const empty = groupFor(aggregateNpcSceneDecisionReport([row({ status: "trigger_miss" })]), "shadow");
    expect(empty.classifierLatencyMs).toEqual({ samples: 0, p50: null, p95: null, p99: null });
    expect(empty.addedSettleLatencyMs).toEqual({ samples: 0, p50: null, p95: null, p99: null });

    const single = groupFor(aggregateNpcSceneDecisionReport([latency(42)]), "shadow");
    expect(single.classifierLatencyMs).toEqual({ samples: 1, p50: 42, p95: 42, p99: 42 });
  });

  it("takes nearest-rank percentiles over an unsorted sample", () => {
    const three = groupFor(aggregateNpcSceneDecisionReport([latency(300), latency(100), latency(200)]), "shadow");
    // n=3: p50 → index ceil(1.5)-1 = 1; p95/p99 → index 2.
    expect(three.classifierLatencyMs).toEqual({ samples: 3, p50: 200, p95: 300, p99: 300 });

    const shuffled = [70, 20, 100, 50, 10, 90, 30, 80, 40, 60].map(latency);
    const ten = groupFor(aggregateNpcSceneDecisionReport(shuffled), "shadow");
    // n=10: p50 → index 4 (50); p95/p99 → index 9 (100).
    expect(ten.classifierLatencyMs).toEqual({ samples: 10, p50: 50, p95: 100, p99: 100 });
  });

  it("counts a row without telemetry as unavailable instead of a 0 ms sample", () => {
    const rows = [
      latency(100),
      latency(200),
      // Empty payload / degraded parse: model "" and a latency of 0 that never happened.
      row({ status: "degraded", telemetry: { model: "", latencyMs: 0 } }),
      row({ status: "degraded", telemetry: { model: "", latencyMs: 0 } }),
    ];
    const group = groupFor(aggregateNpcSceneDecisionReport(rows), "shadow");
    expect(group.telemetryUnavailable).toBe(2);
    // Four samples including the zeros would put p50 at 0; two real ones put it at 100.
    expect(group.classifierLatencyMs).toEqual({ samples: 2, p50: 100, p95: 200, p99: 200 });
  });

  it("reports added settle latency only where the optional field is present, with coverage", () => {
    const rows = [
      row({ usage: { settleWaitMs: 120 } }),
      row({ usage: { settleWaitMs: 480 } }),
      row(), // an older build: no usage telemetry at all
      row({ status: "trigger_miss" }),
    ];
    const group = groupFor(aggregateNpcSceneDecisionReport(rows), "shadow");
    expect(group.addedSettleLatencyMs).toEqual({ samples: 2, p50: 120, p95: 480, p99: 480 });
    expect(group.fired).toBe(3);
  });

  it("groups actions by kind × resolution with their top detail values", () => {
    const rows = [
      row({
        actions: [
          action("movement", "dropped", "shadow_admitted_not_executed"),
          action("contact", "dropped", "shadow_admitted_not_executed"),
          action("floor_ending", "committed"),
        ],
      }),
      row({
        actions: [
          action("movement", "dropped", "shadow_admitted_not_executed composite_departure"),
          action("movement", "dropped", "shadow_admitted_not_executed"),
          action("movement", "refused", "actor_not_controlled"),
        ],
      }),
    ];
    const group = groupFor(aggregateNpcSceneDecisionReport(rows), "shadow");

    const movementDropped = group.actions.find((entry) => entry.kind === "movement" && entry.resolution === "dropped");
    expect(movementDropped?.count).toBe(3);
    expect(movementDropped?.topDetails).toEqual([
      { detail: "shadow_admitted_not_executed", count: 2 },
      { detail: "shadow_admitted_not_executed composite_departure", count: 1 },
    ]);
    // Biggest group first, and the floor's own outcome is still recorded.
    expect(group.actions[0]?.kind).toBe("movement");
    expect(group.actions.some((entry) => entry.kind === "floor_ending" && entry.resolution === "committed")).toBe(true);
  });

  it("groups drops by reason and scales them per 100 replies, misses included", () => {
    const rows = [
      row({ drops: [drop("evidence_ungrounded"), drop("evidence_ungrounded")] }),
      row({ drops: [drop("contact_conflict")] }),
      row(),
      row({ status: "trigger_miss" }),
    ];
    const group = groupFor(aggregateNpcSceneDecisionReport(rows), "shadow");
    expect(group.drops).toEqual([
      { reason: "evidence_ungrounded", count: 2, per100Replies: 50 },
      { reason: "contact_conflict", count: 1, per100Replies: 25 },
    ]);
  });

  it("counts slot outcomes over fired rows only", () => {
    const rows = [
      row({ slots: { movement: "parsed", contact: "malformed" } }),
      row({ status: "degraded", slots: { movement: "malformed", contact: "absent" } }),
      row({ status: "trigger_miss", slots: { movement: "absent", contact: "absent" } }),
    ];
    const group = groupFor(aggregateNpcSceneDecisionReport(rows), "shadow");
    expect(group.slots.movement).toEqual({ parsed: 1, malformed: 1, absent: 0 });
    expect(group.slots.contact).toEqual({ parsed: 0, malformed: 1, absent: 1 });
  });

  it("measures acceptance over tier-2 candidates only", () => {
    const rows = [
      row({
        actions: [action("movement", "committed"), action("contact", "committed"), action("floor_ending", "committed")],
        drops: [drop("evidence_ambiguous"), drop("presence_conflict")],
      }),
      row({ actions: [action("presence_ending", "committed")], drops: [drop("ref_invalid", "movement")] }),
    ];
    const group = groupFor(aggregateNpcSceneDecisionReport(rows), "shadow");
    // The frozen floor and the presence fold are not proposals: 2 admitted, 3 dropped.
    expect(group.acceptance).toEqual({ admitted: 2, dropped: 3, candidates: 5, rate: 0.4 });
  });

  it("splits cost into recorded, token-priced, and uncosted — and never totals the unknown as zero", () => {
    const rows = [
      row({ usage: { costUsd: 0.01 } }),
      row({ usage: { inputTokens: 1_000, outputTokens: 500 } }),
      row(),
      row({ status: "trigger_miss" }),
    ];
    const group = groupFor(
      aggregateNpcSceneDecisionReport(rows, { inputPerMillionUsd: 3, outputPerMillionUsd: 15 }),
      "shadow",
    );

    expect(group.cost.recordedRows).toBe(1);
    expect(group.cost.recordedUsd).toBeCloseTo(0.01);
    expect(group.cost.pricedRows).toBe(1);
    expect(group.cost.pricedUsd).toBeCloseTo(0.0105);
    expect(group.cost.costedRows).toBe(2);
    expect(group.cost.uncostedRows).toBe(1);
    expect(group.cost.firedRows).toBe(3);
    expect(group.cost.complete).toBe(false);
    expect(group.cost.costedUsd).toBeCloseTo(0.0205);
    expect(group.cost.meanUsdPerCostedCall).toBeCloseTo(0.01025);
    // Per 100 REPLIES: the trigger miss is a real reply that cost nothing.
    expect(group.cost.per100RepliesUsd).toBeCloseTo(0.5125);
    expect(group.cost.per100RepliesEstimatedUsd).toBeCloseTo(0.76875);
  });

  it("leaves cost unavailable when nothing is costed, and exact when everything is", () => {
    const unpriced = groupFor(
      aggregateNpcSceneDecisionReport([row({ usage: { inputTokens: 1_000, outputTokens: 500 } }), row()]),
      "shadow",
    );
    expect(unpriced.cost.costedRows).toBe(0);
    expect(unpriced.cost.uncostedRows).toBe(2);
    expect(unpriced.cost.per100RepliesUsd).toBeNull();
    expect(unpriced.cost.per100RepliesEstimatedUsd).toBeNull();

    // Half a price prices nothing — an input-only cost would understate silently.
    const halfPriced = groupFor(
      aggregateNpcSceneDecisionReport([row({ usage: { inputTokens: 1_000, outputTokens: 500 } })], {
        inputPerMillionUsd: 3,
      }),
      "shadow",
    );
    expect(halfPriced.cost.costedRows).toBe(0);
    expect(halfPriced.cost.uncostedRows).toBe(1);

    const complete = groupFor(
      aggregateNpcSceneDecisionReport([row({ usage: { costUsd: 0.02 } }), row({ usage: { costUsd: 0.02 } })]),
      "shadow",
    );
    expect(complete.cost.complete).toBe(true);
    expect(complete.cost.per100RepliesUsd).toBeCloseTo(2);
    // Nothing is missing, so there is nothing to extrapolate.
    expect(complete.cost.per100RepliesEstimatedUsd).toBeNull();
  });

  it("totals tokens with their coverage and distributes models over fired rows", () => {
    const rows = [
      row({ telemetry: { model: "vendor/a" }, usage: { inputTokens: 900, outputTokens: 100 } }),
      row({ telemetry: { model: "vendor/a" }, usage: { inputTokens: 100 } }),
      row({ telemetry: { model: "vendor/b" } }),
      row({ status: "trigger_miss", telemetry: { model: "" } }),
    ];
    const group = groupFor(aggregateNpcSceneDecisionReport(rows), "shadow");
    expect(group.tokens).toEqual({ firedRows: 3, rowsWithTokens: 2, inputTokens: 1_000, outputTokens: 100 });
    expect(group.models).toEqual([
      { model: "vendor/a", count: 2 },
      { model: "vendor/b", count: 1 },
    ]);
  });

  it("echoes the pricing it was given so a dump states its own assumption", () => {
    const report = aggregateNpcSceneDecisionReport([row()], { inputPerMillionUsd: 3, outputPerMillionUsd: 15 });
    expect(report.pricing).toEqual({ inputPerMillionUsd: 3, outputPerMillionUsd: 15 });
  });
});

describe("reviewCorpusLine", () => {
  it("carries the reply beside the decision and drops replay-only material", () => {
    const reply = "She reaches over and takes your hand.";
    const source = row({
      actions: [{ ...action("contact", "committed", "start"), quoteHash: "b".repeat(64), committed: { any: "blob" } }],
      drops: [drop("evidence_unasserted", "contact", reply)],
      usage: { settleWaitMs: 120, costUsd: 0.01 },
    });
    const line = reviewCorpusLine(source, reply);

    expect(line.reply).toBe(reply);
    expect(line.replyHash).toBe(source.replyHash);
    expect(line.actions).toEqual([
      { kind: "contact", span: { start: 0, end: 1 }, summary: "", resolution: "committed", detail: "start" },
    ]);
    // The action's quote HASH is replay material and goes; the drop's quote is
    // the reviewer's whole basis for judging the gate, so it survives verbatim.
    expect(line.drops).toEqual([
      { candidate: "contact", reason: "evidence_unasserted", field: "", detail: "", evidence: reply },
    ]);
    expect(line.telemetry).toEqual({ model: "test/model", latencyMs: 0, timedOut: false, settleWaitMs: 120, costUsd: 0.01 });
  });

  it("keeps a missing reply row as null rather than an empty reply", () => {
    expect(reviewCorpusLine(row(), null).reply).toBeNull();
  });
});
