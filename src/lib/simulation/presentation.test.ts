import { describe, expect, it } from "vitest";
import type { Diagnostic } from "@/contracts/diagnostics";
import { narrativeCutSchema, type NarrativeCut } from "@/contracts/simulation/narrative";
import { auditPresentation, emptyNarratorResult, parseNarratorResult } from "./presentation";

const NOW = 100_000;

function beat(eventId: string, sequence: number) {
  return {
    kind: "actor_departed",
    eventId,
    sequence,
    storySecond: NOW,
    summary: `Beat ${eventId} happened.`,
  };
}

function fixtureCut(overrides: Record<string, unknown> = {}): NarrativeCut {
  return narrativeCutSchema.parse({
    id: "cut-1",
    semanticHash: "0badcafe",
    compilerVersion: "cut-v2",
    worldId: "world-1",
    branchId: "branch-1",
    branchVersion: 4,
    engagementId: "engagement-1",
    viewpointActorId: "player",
    fromSequence: 4,
    throughSequence: 6,
    fromStorySecond: NOW,
    throughStorySecond: NOW + 400,
    currentLoci: [{ actorId: "player", kind: "at", zoneId: "zone-cafe" }],
    currentActivities: [],
    mustEnact: [beat("event-1", 5), beat("event-2", 6)],
    perceptibleNow: [],
    speakerBeliefs: [],
    relevantPressures: [],
    allowedTransitions: [],
    forbiddenClaims: [],
    failurePresentations: [],
    creativeLicenses: [],
    armedEffects: [
      {
        id: "armed-1",
        cutId: "cut-1",
        preconditionVersion: 4,
        effectType: "apology_delivered",
        actorId: "player",
        targetActorIds: ["mara"],
        detail: "an apology",
      },
    ],
    provenance: [],
    ...overrides,
  });
}

describe("E4.3 parseNarratorResult (§23.1 trust boundary)", () => {
  it("degrades garbage to the empty result instead of failing the turn", () => {
    const sink: Diagnostic[] = [];
    const { result, proposals } = parseNarratorResult(42, fixtureCut(), sink);
    expect(result).toEqual(emptyNarratorResult);
    expect(proposals).toEqual([]);
    expect(sink[0]?.code).toBe("parse.boundary_failed");
  });

  it("strips unknown fields and stamps proposals with the cut id, never trusting the model's own citation", () => {
    const { result, proposals } = parseNarratorResult(
      {
        prose: "She smiles.",
        enactedArmedEffectIds: ["armed-1"],
        enactedBeatEventIds: ["event-1"],
        proposedSoftCanon: [
          {
            key: "nickname_for_player",
            value: "stray",
            scope: "relationship",
            subjectIds: ["mara", "player"],
            confidenceFixedPoint: 9_000,
          },
        ],
        hardOutcomeSmuggling: "mara hands over her keys",
      },
      fixtureCut(),
    );
    expect("hardOutcomeSmuggling" in result).toBe(false);
    expect(proposals).toHaveLength(1);
    expect(proposals[0]?.sourceCutId).toBe("cut-1");
  });
});

describe("E4.3 auditPresentation (§23.2)", () => {
  it("accepts a render that declared every hard beat", () => {
    const audit = auditPresentation(fixtureCut(), {
      prose: "Mara leaves; the room empties.",
      enactedArmedEffectIds: [],
      enactedBeatEventIds: ["event-1", "event-2"],
      proposedSoftCanon: [],
    });
    expect(audit.verdict).toBe("accept");
    expect(audit.missingBeatEventIds).toEqual([]);
  });

  it("bridges a small omission with the beat's own neutral summary", () => {
    const audit = auditPresentation(fixtureCut(), {
      prose: "Mara leaves.",
      enactedArmedEffectIds: [],
      enactedBeatEventIds: ["event-1"],
      proposedSoftCanon: [],
    });
    expect(audit.verdict).toBe("accept_with_bridge");
    expect(audit.missingBeatEventIds).toEqual(["event-2"]);
    expect(audit.bridgeProse).toBe("Beat event-2 happened.");
  });

  it("sends an empty or beat-blind render back for rerender", () => {
    const cut = fixtureCut({
      mustEnact: [beat("event-1", 5), beat("event-2", 6), beat("event-3", 6)],
    });
    const blind = auditPresentation(cut, {
      prose: "Nothing but vibes.",
      enactedArmedEffectIds: [],
      enactedBeatEventIds: [],
      proposedSoftCanon: [],
    });
    expect(blind.verdict).toBe("rerender");
    const empty = auditPresentation(fixtureCut(), {
      prose: "   ",
      enactedArmedEffectIds: [],
      enactedBeatEventIds: ["event-1", "event-2"],
      proposedSoftCanon: [],
    });
    expect(empty.verdict).toBe("rerender");
    expect(empty.proseEmpty).toBe(true);
  });

  it("flags declared ids the cut never contained — audit only, truth untouched", () => {
    const audit = auditPresentation(fixtureCut(), {
      prose: "Mara leaves; the room empties.",
      enactedArmedEffectIds: ["armed-1", "armed-invented"],
      enactedBeatEventIds: ["event-1", "event-2", "event-invented"],
      proposedSoftCanon: [],
    });
    expect(audit.verdict).toBe("accept");
    expect(audit.unknownEnactedArmedEffectIds).toEqual(["armed-invented"]);
    expect(audit.unknownEnactedBeatEventIds).toEqual(["event-invented"]);
  });
});
