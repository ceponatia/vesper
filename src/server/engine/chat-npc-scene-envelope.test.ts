import { describe, expect, it } from "vitest";
import { DiagnosticCollector, emptySceneState, type SceneState } from "@/contracts";
import { expectDiagnostic } from "@/test/diagnostics";
import {
  canonicalNpcSceneDecisionBytes,
  chatNpcDigestHash,
  chatNpcReplyHash,
  chatNpcSceneHash,
  emptyNpcSceneDecisionPayload,
  npcSceneDecisionEquivalent,
  parseNpcSceneDecisionPayload,
  NPC_SCENE_DECISION_PAYLOAD_VERSION,
  type ChatNpcSceneDecisionEnvelope,
  type NpcSceneDecisionPayload,
} from "./chat-npc-scene-envelope";

/**
 * The envelope module's PURE half: the payload's trust boundary (malformed ⇒
 * the empty payload PLUS the diagnostic — docs/resilience.md §8 demands both
 * asserted together), the bounds that keep a once-per-reply blob from growing
 * by prose, and the canonical-byte-equivalence that predicate 3 of the guarded
 * transaction stands on — order-INsensitive where order carries no meaning
 * (object keys, which jsonb reorders on its own), byte-sensitive where it does
 * (the chronological action list).
 *
 * The database half — that the four predicates hold and roll back together —
 * is the integration suite's (`chat-npc-scene-envelope.int.test.ts`).
 */

/** A payload exercising every list and every optional field. */
function fullPayload(): NpcSceneDecisionPayload {
  return {
    version: NPC_SCENE_DECISION_PAYLOAD_VERSION,
    slots: { movement: "parsed", contact: "malformed" },
    actions: [
      {
        kind: "floor_ending",
        span: { start: 40, end: 61 },
        quoteHash: "a".repeat(64),
        summary: "npc_0 steps away from player",
        resolution: "committed",
        detail: "separated",
        contactRows: [{ eventRef: "contact-reply:msg_probe", sequence: 0 }],
      },
      {
        kind: "movement",
        span: { start: 5, end: 20 },
        quoteHash: "b".repeat(64),
        summary: "approach npc_0 → player, close",
        resolution: "committed",
        detail: "",
        committed: { kind: "proximity", band: "close", subjectId: "npc_probe" },
        contactRows: [],
      },
    ],
    drops: [
      {
        candidate: "contact",
        reason: "evidence_incongruent",
        field: "gesture",
        detail: "quote supports a squeeze, not a stroke",
      },
    ],
    contactRows: [{ eventRef: "contact-reply:msg_probe", sequence: 0 }],
    telemetry: {
      model: "probe/model",
      latencyMs: 812,
      timedOut: false,
      inputTokens: 1_240,
      outputTokens: 38,
      costUsd: 0.00031,
      settleWaitMs: 120,
    },
  };
}

/** A minimal in-bounds action, for the list-cap fixtures. */
function minimalAction(): Record<string, unknown> {
  return { kind: "movement", span: { start: 0, end: 1 }, resolution: "unresolved" };
}

/** Recursively rebuild objects with their keys REVERSED — the jsonb round-trip stand-in. */
function scrambleKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(scrambleKeys);
  if (value === null || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  return Object.keys(record)
    .reverse()
    .reduce<Record<string, unknown>>((acc, key) => ({ ...acc, [key]: scrambleKeys(record[key]) }), {});
}

describe("parseNpcSceneDecisionPayload (the payload's trust boundary)", () => {
  it("round-trips a full payload, defaults included", () => {
    expect(parseNpcSceneDecisionPayload(fullPayload())).toEqual(fullPayload());
  });

  it("fills the defaults on a minimal payload rather than demanding them", () => {
    const parsed = parseNpcSceneDecisionPayload({
      version: NPC_SCENE_DECISION_PAYLOAD_VERSION,
      slots: { movement: "absent", contact: "absent" },
    });
    expect(parsed).toEqual(emptyNpcSceneDecisionPayload());
  });

  it("reads a row written before the spend fields existed — they stay ABSENT, not zero", () => {
    // The version literal did not move for them, so the old blob is still a
    // current blob; "unmeasured" and "measured at zero" must stay distinguishable.
    const stored = { ...fullPayload(), telemetry: { model: "probe/model", latencyMs: 812, timedOut: false } };
    const parsed = parseNpcSceneDecisionPayload(stored);
    expect(parsed.version).toBe(NPC_SCENE_DECISION_PAYLOAD_VERSION);
    expect(parsed.telemetry).toEqual({ model: "probe/model", latencyMs: 812, timedOut: false });
    expect(parsed.telemetry.inputTokens).toBeUndefined();
    expect(parsed.telemetry.outputTokens).toBeUndefined();
    expect(parsed.telemetry.costUsd).toBeUndefined();
    expect(parsed.telemetry.settleWaitMs).toBeUndefined();
  });

  it("refuses a spend figure outside its bounds — which is why the WRITER checks before inserting", () => {
    for (const telemetry of [
      { model: "probe/model", latencyMs: 1, timedOut: false, inputTokens: 12.5 },
      { model: "probe/model", latencyMs: 1, timedOut: false, outputTokens: -3 },
      { model: "probe/model", latencyMs: 1, timedOut: false, costUsd: -0.01 },
      { model: "probe/model", latencyMs: 1, timedOut: false, settleWaitMs: -1 },
    ]) {
      const sink = new DiagnosticCollector();
      expect(parseNpcSceneDecisionPayload({ ...fullPayload(), telemetry }, sink)).toEqual(
        emptyNpcSceneDecisionPayload(),
      );
      expectDiagnostic(sink, "parse.boundary_failed");
    }
  });

  it("degrades a malformed blob to the empty payload AND says so — never a throw", () => {
    const sink = new DiagnosticCollector();
    expect(parseNpcSceneDecisionPayload("not a payload at all", sink)).toEqual(emptyNpcSceneDecisionPayload());
    expectDiagnostic(sink, "parse.boundary_failed");
  });

  it("fails closed on an unknown payload version — the version literal is the replay boundary", () => {
    const sink = new DiagnosticCollector();
    const parsed = parseNpcSceneDecisionPayload({ ...fullPayload(), version: 999 }, sink);
    expect(parsed).toEqual(emptyNpcSceneDecisionPayload());
    expectDiagnostic(sink, "parse.boundary_failed");
  });

  it("rejects a zero-width or inverted action span — a span that cannot order anything", () => {
    for (const span of [
      { start: 5, end: 5 },
      { start: 5, end: 4 },
    ]) {
      const sink = new DiagnosticCollector();
      const raw = { ...fullPayload(), actions: [{ ...minimalAction(), span }] };
      expect(parseNpcSceneDecisionPayload(raw, sink)).toEqual(emptyNpcSceneDecisionPayload());
      expectDiagnostic(sink, "parse.boundary_failed");
    }
  });

  it("enforces the list caps — an unbounded once-per-reply blob is a table that grows by prose", () => {
    const sink = new DiagnosticCollector();
    const overfull = {
      ...fullPayload(),
      actions: Array.from({ length: 25 }, () => minimalAction()),
    };
    expect(parseNpcSceneDecisionPayload(overfull, sink)).toEqual(emptyNpcSceneDecisionPayload());
    expectDiagnostic(sink, "parse.boundary_failed");
  });

  it("enforces the free-text bounds", () => {
    const sink = new DiagnosticCollector();
    const wordy = {
      ...fullPayload(),
      actions: [{ ...minimalAction(), summary: "x".repeat(201) }],
    };
    expect(parseNpcSceneDecisionPayload(wordy, sink)).toEqual(emptyNpcSceneDecisionPayload());
    expectDiagnostic(sink, "parse.boundary_failed");
  });

  it("enforces the byte cap on a carried committed blob", () => {
    const sink = new DiagnosticCollector();
    const bloated = {
      ...fullPayload(),
      actions: [{ ...minimalAction(), committed: { prose: "x".repeat(5_000) } }],
    };
    expect(parseNpcSceneDecisionPayload(bloated, sink)).toEqual(emptyNpcSceneDecisionPayload());
    expectDiagnostic(sink, "parse.boundary_failed");
  });

  it("rejects a drop reason outside the spec's vocabulary — tallies must GROUP BY, not regex", () => {
    const sink = new DiagnosticCollector();
    const offVocabulary = {
      ...fullPayload(),
      drops: [{ candidate: "contact", reason: "vibes_were_off" }],
    };
    expect(parseNpcSceneDecisionPayload(offVocabulary, sink)).toEqual(emptyNpcSceneDecisionPayload());
    expectDiagnostic(sink, "parse.boundary_failed");
  });
});

// ---------------------------------------------------------------------------
// Canonical-byte-equivalence
// ---------------------------------------------------------------------------

function envelope(overrides: Partial<ChatNpcSceneDecisionEnvelope> = {}): ChatNpcSceneDecisionEnvelope {
  return {
    replyHash: chatNpcReplyHash("She steps closer and rests a hand on your arm."),
    digestHash: chatNpcDigestHash({ roster: ["npc_0"], contacts: [] }),
    schemaVersion: 1,
    mode: "shadow",
    storyMinute: 100,
    status: "evaluated",
    baseSceneHash: chatNpcSceneHash(emptySceneState()),
    resultSceneHash: chatNpcSceneHash(emptySceneState()),
    payload: fullPayload(),
    ...overrides,
  };
}

describe("npcSceneDecisionEquivalent (predicate 3's judgment)", () => {
  it("accepts the same decision read back through jsonb — key order is not content", () => {
    const stored = {
      ...envelope(),
      payload: scrambleKeys(JSON.parse(JSON.stringify(fullPayload()))),
    };
    expect(npcSceneDecisionEquivalent(envelope(), stored)).toBe(true);
  });

  it("rejects a reordered action list — chronology is content, not presentation", () => {
    const base = fullPayload();
    const reordered: NpcSceneDecisionPayload = {
      ...base,
      actions: [...base.actions].reverse(),
    };
    expect(npcSceneDecisionEquivalent(envelope(), envelope({ payload: reordered }))).toBe(false);
  });

  it("rejects a disagreement in any semantic column", () => {
    for (const other of [
      envelope({ storyMinute: 101 }),
      envelope({ status: "degraded" }),
      envelope({ mode: "authority" }),
      envelope({ digestHash: chatNpcDigestHash({ roster: ["npc_0", "npc_1"] }) }),
      envelope({ resultSceneHash: "0".repeat(64) }),
    ]) {
      expect(npcSceneDecisionEquivalent(envelope(), other)).toBe(false);
    }
  });

  it("rejects a payload leaf drifting, however deep", () => {
    const base = fullPayload();
    const drifted: NpcSceneDecisionPayload = {
      ...base,
      telemetry: { ...base.telemetry, latencyMs: base.telemetry.latencyMs + 1 },
    };
    expect(npcSceneDecisionEquivalent(envelope(), envelope({ payload: drifted }))).toBe(false);
  });

  it("produces stable canonical bytes across construction order", () => {
    const scrambled = scrambleKeys(JSON.parse(JSON.stringify(envelope()))) as ChatNpcSceneDecisionEnvelope;
    expect(canonicalNpcSceneDecisionBytes(scrambled)).toBe(canonicalNpcSceneDecisionBytes(envelope()));
  });
});

// ---------------------------------------------------------------------------
// Hashes
// ---------------------------------------------------------------------------

describe("the envelope's fingerprints", () => {
  it("hashes the reply by its EXACT bytes — whitespace is a different reply", () => {
    expect(chatNpcReplyHash("She nods.")).toMatch(/^[0-9a-f]{64}$/);
    expect(chatNpcReplyHash("She nods.")).toBe(chatNpcReplyHash("She nods."));
    expect(chatNpcReplyHash("She nods.")).not.toBe(chatNpcReplyHash("She nods. "));
  });

  it("hashes a scene projection by content, surviving the jsonb key reorder", () => {
    const scrambled = scrambleKeys(JSON.parse(JSON.stringify(emptySceneState()))) as SceneState;
    expect(chatNpcSceneHash(scrambled)).toBe(chatNpcSceneHash(emptySceneState()));
  });

  it("hashes the digest by content — same content agrees, different content differs", () => {
    expect(chatNpcDigestHash({ a: 1, b: [1, 2] })).toBe(chatNpcDigestHash(scrambleKeys({ b: [1, 2], a: 1 })));
    expect(chatNpcDigestHash({ a: 1 })).not.toBe(chatNpcDigestHash({ a: 2 }));
  });
});
