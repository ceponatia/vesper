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

/** A render whose prose comfortably clears the substance floor. */
const SUBSTANTIAL_PROSE =
  "Mara sets the cup down without a word and crosses the room, the morning light catching the tired set of " +
  "her shoulders. She stops at the window, watching the street below, and when she finally speaks her voice is " +
  "quieter than before, worn thin by everything that has gone unsaid between them since dawn.";

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

  it("maps declared handles back to real event/effect ids, leaving unknown handles to be flagged", () => {
    const { result } = parseNarratorResult(
      {
        prose: "She apologizes.",
        enactedArmedEffectIds: ["E1"],
        enactedBeatEventIds: ["B1", "B9"],
        proposedSoftCanon: [],
      },
      fixtureCut(),
      undefined,
      { B1: "event-1", B2: "event-2", E1: "armed-1" },
    );
    // Handles translate to real ids; "B9" is not in the map, so it flows through
    // unchanged to the existing unknown-id flagging.
    expect(result.enactedBeatEventIds).toEqual(["event-1", "B9"]);
    expect(result.enactedArmedEffectIds).toEqual(["armed-1"]);
  });
});

describe("E4.3 auditPresentation (§23.2)", () => {
  it("accepts a render that declared every hard beat", () => {
    const audit = auditPresentation(fixtureCut(), {
      prose: SUBSTANTIAL_PROSE,
      enactedArmedEffectIds: [],
      enactedBeatEventIds: ["event-1", "event-2"],
      proposedSoftCanon: [],
    });
    expect(audit.verdict).toBe("accept");
    expect(audit.missingBeatEventIds).toEqual([]);
  });

  it("bridges a small omission with the beat's own neutral summary (direct call keeps legacy semantics)", () => {
    const audit = auditPresentation(fixtureCut(), {
      prose: SUBSTANTIAL_PROSE,
      enactedArmedEffectIds: [],
      enactedBeatEventIds: ["event-1"],
      proposedSoftCanon: [],
    });
    expect(audit.verdict).toBe("accept_with_bridge");
    expect(audit.missingBeatEventIds).toEqual(["event-2"]);
    expect(audit.bridgeProse).toBe("Beat event-2 happened.");
  });

  it("demotes the bridge to a feedback retry on a non-final attempt", () => {
    const audit = auditPresentation(
      fixtureCut(),
      {
        prose: SUBSTANTIAL_PROSE,
        enactedArmedEffectIds: [],
        enactedBeatEventIds: ["event-1"],
        proposedSoftCanon: [],
      },
      { attempt: 1, maxAttempts: 2 },
    );
    // The small omission would bridge on the final attempt, but the FIRST attempt
    // re-renders so a corrective retry can genuinely enact the missed beat.
    expect(audit.verdict).toBe("rerender");
    expect(audit.missingBeatEventIds).toEqual(["event-2"]);
  });

  it("treats a template-echo render as empty and sends it back (live find, R5 slice 6)", () => {
    const cut = fixtureCut();
    const audit = auditPresentation(cut, {
      ...emptyNarratorResult,
      prose: "<the scene, 100-350 words>",
      enactedBeatEventIds: cut.mustEnact.map((b) => b.eventId),
    });
    expect(audit.verdict).toBe("rerender");
    expect(audit.diagnostics).toContain("presentation.placeholder_echo");
  });

  it("sends an empty or beat-blind render back for rerender", () => {
    const cut = fixtureCut({
      mustEnact: [beat("event-1", 5), beat("event-2", 6), beat("event-3", 6)],
    });
    const blind = auditPresentation(cut, {
      prose: SUBSTANTIAL_PROSE,
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
      prose: SUBSTANTIAL_PROSE,
      enactedArmedEffectIds: ["armed-1", "armed-invented"],
      enactedBeatEventIds: ["event-1", "event-2", "event-invented"],
      proposedSoftCanon: [],
    });
    expect(audit.verdict).toBe("accept");
    expect(audit.unknownEnactedArmedEffectIds).toEqual(["armed-invented"]);
    expect(audit.unknownEnactedBeatEventIds).toEqual(["event-invented"]);
  });

  it("(a) sends back a render whose prose leaked a beat handle", () => {
    // A well-behaved reply lists handles only in the id arrays; a handle in the
    // prose is an id leak. Audited on the final attempt so ONLY the leak forces rerender.
    const audit = auditPresentation(
      fixtureCut(),
      {
        prose: `${SUBSTANTIAL_PROSE} B1`,
        enactedArmedEffectIds: [],
        enactedBeatEventIds: ["event-1", "event-2"],
        proposedSoftCanon: [],
      },
      { attempt: 2, maxAttempts: 2 },
    );
    expect(audit.verdict).toBe("rerender");
    expect(audit.diagnostics).toContain("presentation.id_leak");
  });

  it("(b) sends back a render whose prose is the JSON envelope", () => {
    const audit = auditPresentation(
      fixtureCut(),
      {
        prose: '{"prose":"she smiles","enactedBeatEventIds":["B1"]}',
        enactedArmedEffectIds: [],
        enactedBeatEventIds: ["event-1", "event-2"],
        proposedSoftCanon: [],
      },
      { attempt: 2, maxAttempts: 2 },
    );
    expect(audit.verdict).toBe("rerender");
    expect(audit.diagnostics).toContain("presentation.contract_echo");
  });

  it("(c) retries a thin render once, then accepts it on the final attempt", () => {
    const thin = {
      prose: "She nods and leaves.",
      enactedArmedEffectIds: [],
      enactedBeatEventIds: ["event-1", "event-2"],
      proposedSoftCanon: [],
    };
    const early = auditPresentation(fixtureCut(), thin, { attempt: 1, maxAttempts: 2 });
    expect(early.verdict).toBe("rerender");
    expect(early.diagnostics).toContain("presentation.too_thin");

    const final = auditPresentation(fixtureCut(), thin, { attempt: 2, maxAttempts: 2 });
    // Never withhold a turn over length alone — the last attempt accepts, diagnostic kept.
    expect(final.verdict).toBe("accept");
    expect(final.diagnostics).toContain("presentation.too_thin");
  });
});
