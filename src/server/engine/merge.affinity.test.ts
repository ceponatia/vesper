import { describe, expect, it } from "vitest";
import { DiagnosticCollector } from "@/contracts/diagnostics";
import { emptyParticipantState } from "@/contracts/state/participant-state";
import { emptyCharacterProfile } from "@/contracts/world/profile";
import { stageForValue } from "@/contracts/relationships/stages";
import type { BundleRelationship } from "./bundle";
import { AFFINITY_DECAY_WEEK_MINUTES, AFFINITY_DELTA_CLAMP } from "./constants";
import { decayAffinityValue, planAffinityDecay, planAffinityUpdates, type WorkingParticipant } from "./merge";
import { computeFollowScores, FOLLOW_THRESHOLD } from "./scene";

function person(id: string, displayName: string, isUser = false): WorkingParticipant {
  return {
    id,
    displayName,
    isUser,
    role: isUser ? "player" : "npc",
    characterId: null,
    snapshot: emptyCharacterProfile(),
    locationId: "loc-1",
    state: emptyParticipantState(),
  };
}

const brian = person("p-brian", "Brian", true);
const mara = person("p-mara", "Mara");
const tom = person("p-tom", "Tom");
const parts = [brian, mara, tom];

describe("planAffinityUpdates", () => {
  it("NPC → anyone is a feeling edge owned by the NPC", () => {
    const updates = planAffinityUpdates([{ fromName: "Mara", towardName: "Brian", delta: 3 }], parts);
    expect(updates).toEqual([
      { fromParticipantId: "p-mara", toParticipantId: "p-brian", kind: "feeling", delta: 3, reason: undefined },
    ]);
  });

  it("player → NPC becomes the NPC's perceived edge (decision 41)", () => {
    const updates = planAffinityUpdates([{ fromName: "Brian", towardName: "Mara", delta: 2, reason: "he opened up" }], parts);
    expect(updates).toEqual([
      { fromParticipantId: "p-mara", toParticipantId: "p-brian", kind: "perceived", delta: 2, reason: "he opened up" },
    ]);
  });

  it("NPC ↔ NPC edges work both directions independently", () => {
    const updates = planAffinityUpdates(
      [
        { fromName: "Mara", towardName: "Tom", delta: 1 },
        { fromName: "Tom", towardName: "Mara", delta: -2 },
      ],
      parts,
    );
    expect(updates).toHaveLength(2);
    expect(updates.every((u) => u.kind === "feeling")).toBe(true);
  });

  it("clamps the summed per-edge delta to ±AFFINITY_DELTA_CLAMP", () => {
    const updates = planAffinityUpdates(
      [
        { fromName: "Mara", towardName: "Brian", delta: 4 },
        { fromName: "Mara", towardName: "Brian", delta: 4 },
      ],
      parts,
    );
    expect(updates).toHaveLength(1);
    expect(updates[0]?.delta).toBe(AFFINITY_DELTA_CLAMP);
  });

  it("drops unresolved names with a diagnostic and zero-deltas silently", () => {
    const sink = new DiagnosticCollector();
    const updates = planAffinityUpdates(
      [
        { fromName: "Nobody", towardName: "Brian", delta: 3 },
        { fromName: "Mara", towardName: "Brian", delta: 0.2 },
      ],
      parts,
      sink,
    );
    expect(updates).toEqual([]);
    expect(sink.items.filter((d) => d.code === "merge.affinity.unresolved_pair")).toHaveLength(1);
  });

  it("drops self-edges and garbage deltas", () => {
    const updates = planAffinityUpdates(
      [
        { fromName: "Mara", towardName: "Mara", delta: 3 },
        { fromName: "Tom", towardName: "Brian", delta: Number.NaN },
      ],
      parts,
      new DiagnosticCollector(),
    );
    expect(updates).toEqual([]);
  });
});

describe("affinity decay (planAffinityDecay / decayAffinityValue)", () => {
  const WEEK = AFFINITY_DECAY_WEEK_MINUTES;

  function rel(value: number, overrides: Partial<BundleRelationship> = {}): BundleRelationship {
    return {
      fromParticipantId: "p-mara",
      toParticipantId: "p-brian",
      kind: "feeling",
      value,
      stage: stageForValue(value).id,
      ...overrides,
    };
  }

  it("seeds the marker on first use without decaying", () => {
    const result = planAffinityDecay({ relationships: [rel(50)], clockMinutes: 3 * WEEK, lastAffinityDecayAt: undefined });
    expect(result.edges).toEqual([]);
    expect(result.lastAffinityDecayAt).toBe(3 * WEEK);
  });

  it("does not decay within < 1 week and leaves the marker untouched", () => {
    const result = planAffinityDecay({ relationships: [rel(50)], clockMinutes: WEEK - 1, lastAffinityDecayAt: 0 });
    expect(result.edges).toEqual([]);
    expect(result.lastAffinityDecayAt).toBe(0);
  });

  it("decays 1 point per whole elapsed week toward 0, consuming only whole weeks", () => {
    const result = planAffinityDecay({
      relationships: [rel(50)],
      clockMinutes: 3 * WEEK + Math.floor(WEEK / 2),
      lastAffinityDecayAt: 0,
    });
    expect(result.edges).toEqual([
      { fromParticipantId: "p-mara", toParticipantId: "p-brian", kind: "feeling", previousValue: 50, value: 47, clamped: false },
    ]);
    // Only whole weeks are consumed — the half-week remainder keeps accumulating.
    expect(result.lastAffinityDecayAt).toBe(3 * WEEK);
  });

  it("stops exactly at the stage's zero-side boundary and never changes the stage", () => {
    const result = planAffinityDecay({ relationships: [rel(37)], clockMinutes: 10 * WEEK, lastAffinityDecayAt: 0 });
    expect(result.edges[0]).toMatchObject({ previousValue: 37, value: 35, clamped: true }); // friendly min = 35
    expect(stageForValue(result.edges[0]!.value).id).toBe(stageForValue(37).id);
  });

  it("negative values decay upward toward 0 and stop at the stage's zero-side edge", () => {
    const drift = planAffinityDecay({ relationships: [rel(-20)], clockMinutes: 3 * WEEK, lastAffinityDecayAt: 0 });
    expect(drift.edges[0]).toMatchObject({ previousValue: -20, value: -17, clamped: false });
    const stop = planAffinityDecay({ relationships: [rel(-20)], clockMinutes: 12 * WEEK, lastAffinityDecayAt: 0 });
    expect(stop.edges[0]).toMatchObject({ previousValue: -20, value: -15, clamped: true }); // wary max = -15
    expect(stageForValue(-15).id).toBe("wary");
  });

  it("stranger-band values decay all the way to 0 without a clamp (0 is the target, not a boundary)", () => {
    const result = planAffinityDecay({
      relationships: [rel(3), rel(-3, { toParticipantId: "p-tom" })],
      clockMinutes: 5 * WEEK,
      lastAffinityDecayAt: 0,
    });
    expect(result.edges).toHaveLength(2);
    expect(result.edges[0]).toMatchObject({ previousValue: 3, value: 0, clamped: false });
    expect(result.edges[1]).toMatchObject({ previousValue: -3, value: 0, clamped: false });
  });

  it("an edge already parked at its boundary still plans a clamped edge — the events-row fossilizing evidence", () => {
    const result = planAffinityDecay({ relationships: [rel(35)], clockMinutes: WEEK, lastAffinityDecayAt: 0 });
    expect(result.edges[0]).toMatchObject({ previousValue: 35, value: 35, clamped: true });
  });

  it("a value of 0 plans nothing", () => {
    const result = planAffinityDecay({ relationships: [rel(0)], clockMinutes: WEEK, lastAffinityDecayAt: 0 });
    expect(result.edges).toEqual([]);
  });

  it("invariant: decay never changes any value's stage (full sweep)", () => {
    for (let value = -100; value <= 100; value++) {
      for (const weeks of [1, 4, 60, 500]) {
        const decayed = decayAffinityValue(value, weeks);
        expect(stageForValue(decayed.value).id).toBe(stageForValue(value).id);
      }
    }
  });

  it("a marker ahead of the clock reseeds with a diagnostic instead of decaying", () => {
    const sink = new DiagnosticCollector();
    const result = planAffinityDecay({ relationships: [rel(50)], clockMinutes: 100, lastAffinityDecayAt: 5000 }, sink);
    expect(result.edges).toEqual([]);
    expect(result.lastAffinityDecayAt).toBe(100);
    expect(sink.items.some((d) => d.code === "merge.affinity.decay_marker_reset")).toBe(true);
  });
});

describe("follow scores with affinity stages", () => {
  const base = {
    playerInput: "Mara, come with me",
    fromLocationName: "Kitchen",
    toLocationName: "Garden",
    npcs: [{ displayName: "Mara", coLocated: true, activity: "idle" }],
    relationshipFacts: [],
    turnsSinceInteraction: { Mara: 0 },
  };

  it("a close friend addressed and recently engaged likely follows", () => {
    const [c] = computeFollowScores({ ...base, affinityStages: { Mara: "close" } });
    expect(c?.likelyFollows).toBe(true);
    expect(c?.reasons.some((r) => r.includes("relationship stage: close"))).toBe(true);
  });

  it("affinity gate: a stranger never reaches likely-follows on scene warmth alone", () => {
    const [c] = computeFollowScores({ ...base, affinityStages: { Mara: "stranger" } });
    expect(c?.likelyFollows).toBe(false);
    expect(c?.reasons.some((r) => r.includes("affinity gate"))).toBe(true);
    expect(c!.score).toBeLessThan(FOLLOW_THRESHOLD);
  });

  it("hostile stage pushes the score down", () => {
    const friendly = computeFollowScores({ ...base, affinityStages: { Mara: "friendly" } })[0]!;
    const hostile = computeFollowScores({ ...base, affinityStages: { Mara: "hostile" } })[0]!;
    expect(hostile.score).toBeLessThan(friendly.score);
  });

  it("without stages, the fact-count fallback still applies", () => {
    const [c] = computeFollowScores({
      ...base,
      relationshipFacts: [
        { subjectName: "Mara", text: "Mara trusts Brian" },
        { subjectName: "Mara", text: "Mara shared her secret" },
        { subjectName: "Mara", text: "Mara enjoys his company" },
      ],
    });
    expect(c?.reasons.some((r) => r.includes("relationship warmth"))).toBe(true);
  });
});
