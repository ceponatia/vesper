import { describe, expect, it } from "vitest";
import { narrativeCutSchema, type NarrativeCut } from "@/contracts/simulation/narrative";
import {
  buildConfirmCommand,
  renderCommittedCut,
  renderSoloNarration,
  type RenderSeam,
  type SoloRenderSeam,
} from "./sim-narrator";

/**
 * Pure render-loop tests (presentation-charter.plan.md slice 3) — the cut is
 * injected (`loadCut`) and the model seam is stubbed, so no DB or live call runs.
 * The stubs declare no armed effects, so the confirm path (the only DB write) is
 * never reached.
 */

const NOW = 100_000;

/** A ≥40-word reply that clears the substance floor. */
const SUBSTANTIAL =
  "Nora sets the cup down without a word and crosses the room, the morning light catching the tired set of her " +
  "shoulders. She stops at the window, watching the street below, and when she finally speaks her voice is quieter " +
  "than before, worn thin by everything that has gone unsaid between them since dawn broke over the rooftops.";

function narratorCut(): NarrativeCut {
  return narrativeCutSchema.parse({
    id: "cut-n",
    semanticHash: "0badcafe",
    compilerVersion: "cut-v3",
    worldId: "world-1",
    branchId: "branch-1",
    branchVersion: 4,
    engagementId: "engagement-1",
    viewpointActorId: "actor-p",
    fromSequence: 4,
    throughSequence: 6,
    fromStorySecond: NOW,
    throughStorySecond: NOW + 400,
    currentLoci: [{ actorId: "actor-p", kind: "at", zoneId: "zone-home" }],
    currentActivities: [],
    mustEnact: [{ kind: "actor_departed", eventId: "event-a", sequence: 5, storySecond: NOW, summary: "Nora sets down the cup." }],
    perceptibleNow: [],
    speakerBeliefs: [],
    relevantPressures: [],
    allowedTransitions: [],
    forbiddenClaims: [],
    failurePresentations: [],
    creativeLicenses: [],
    armedEffects: [],
    bodilyReads: { observed: [] },
    provenance: [],
  });
}

/** A seam that records each attempt's prompt and returns canned replies in order. */
function recordingSeam(replies: unknown[]): { seam: RenderSeam; prompts: string[] } {
  const prompts: string[] = [];
  let call = 0;
  const seam: RenderSeam = async ({ prompt }) => {
    prompts.push(prompt);
    const raw = replies[Math.min(call, replies.length - 1)];
    call += 1;
    return { raw, degraded: false, provider: "stub", latencyMs: 1 };
  };
  return { seam, prompts };
}

const render = (seam: RenderSeam) =>
  renderCommittedCut(
    { branchId: "branch-1", engagementId: "engagement-1", cutId: "cut-n" },
    { render: seam, loadCut: async () => narratorCut() },
  );

describe("renderCommittedCut — targeted retry", () => {
  it("appends a correction naming the missed beat to the attempt-2 prompt", async () => {
    // Both attempts miss the beat (declare nothing) → attempt 1 re-renders with feedback.
    const missing = { prose: SUBSTANTIAL, enactedBeatEventIds: [], enactedArmedEffectIds: [], proposedSoftCanon: [] };
    const { seam, prompts } = recordingSeam([missing, missing]);
    await render(seam);

    expect(prompts).toHaveLength(2);
    expect(prompts[0]).not.toContain("CORRECTION");
    expect(prompts[1]).toContain("CORRECTION");
    expect(prompts[1]).toContain("B1 (Nora sets down the cup.)");
  });
});

describe("renderCommittedCut — normalization before audit", () => {
  it("strips a narrator artifact tag from the reply before it is audited and returned", async () => {
    const tagged = {
      prose: `${SUBSTANTIAL} </uncensored_response>`,
      enactedBeatEventIds: ["B1"], // handle → event-a at the boundary
      enactedArmedEffectIds: [],
      proposedSoftCanon: [],
    };
    const { seam } = recordingSeam([tagged]);
    const result = await render(seam);

    expect(result.status).toBe("rendered");
    expect(result.attempts).toBe(1); // clean prose passed the audit on the first try
    expect(result.prose).not.toContain("uncensored_response");
    expect(result.prose).toContain("Nora sets the cup down");
  });
});

describe("renderCommittedCut — bridge demoted to last resort", () => {
  it("re-renders a small omission first, and only bridges on the feedback retry (as its own paragraph)", async () => {
    const missing = { prose: SUBSTANTIAL, enactedBeatEventIds: [], enactedArmedEffectIds: [], proposedSoftCanon: [] };
    const { seam } = recordingSeam([missing, missing]);
    const result = await render(seam);

    expect(result.attempts).toBe(2); // attempt 1 was a feedback retry, not a bridge
    expect(result.audit?.verdict).toBe("accept_with_bridge");
    // The bridge lands as its own paragraph, never glued mid-sentence.
    expect(result.prose).toContain("\n\nNora sets down the cup.");
  });

  it("does not bridge on a single-attempt render — a small omission withholds instead", async () => {
    const missing = { prose: SUBSTANTIAL, enactedBeatEventIds: [], enactedArmedEffectIds: [], proposedSoftCanon: [] };
    const { seam } = recordingSeam([missing]);
    const result = await renderCommittedCut(
      { branchId: "branch-1", engagementId: "engagement-1", cutId: "cut-n", maxAttempts: 1 },
      { render: seam, loadCut: async () => narratorCut() },
    );
    // attempt 1 is < 2, so the demoted bridge never fires; the render re-renders and,
    // out of attempts, withholds (ruling 8) rather than bolting a raw summary on.
    expect(result.status).toBe("withheld");
  });
});

describe("buildConfirmCommand — one confirm per cut", () => {
  it("keys the idempotencyKey on the cut alone, so a retake's differing enacted set dedupes to the first", () => {
    const first = buildConfirmCommand({
      branchId: "branch-1",
      engagementId: "engagement-1",
      cutId: "cut-n",
      enacted: ["armed-1"],
      proposals: [],
    });
    const retake = buildConfirmCommand({
      branchId: "branch-1",
      engagementId: "engagement-1",
      cutId: "cut-n",
      enacted: ["armed-1", "armed-2"], // a different telling enacts a different subset
      proposals: [],
    });
    // Same cut ⇒ IDENTICAL idempotency key: the first accepted confirm wins, the retake dedupes.
    expect(first.idempotencyKey).toBe(retake.idempotencyKey);
    // The command id still differs per submission (a clean duplicate-id path).
    expect(first.id).not.toBe(retake.id);
  });
});

describe("renderSoloNarration — solo cut (world-ui.plan.md slice 0)", () => {
  const FALLBACK = "You look around the quiet square.\n\nElsewhere, Nora goes about her morning.";

  const soloSeam = (replies: string[]): { seam: SoloRenderSeam; calls: number[] } => {
    const calls: number[] = [];
    let n = 0;
    const seam: SoloRenderSeam = async ({ attempt }) => {
      calls.push(attempt);
      const prose = replies[Math.min(n, replies.length - 1)] ?? "";
      n += 1;
      return { prose, degraded: false, provider: "stub", latencyMs: 1 };
    };
    return { seam, calls };
  };

  it("accepts a non-empty first render and returns the normalized prose", async () => {
    const { seam } = soloSeam(["You step into the square, the keepsake warm in your pocket."]);
    const result = await renderSoloNarration({ system: "s", prompt: "p", fallbackProse: FALLBACK }, { render: seam });
    expect(result.status).toBe("rendered");
    expect(result.prose).toContain("keepsake warm in your pocket");
    expect(result.attempts).toBe(1);
    expect(result.degraded).toBe(false);
  });

  it("retries once when the first render is empty, then accepts", async () => {
    const { seam, calls } = soloSeam(["", "You linger a moment longer than you meant to."]);
    const result = await renderSoloNarration({ system: "s", prompt: "p", fallbackProse: FALLBACK }, { render: seam });
    expect(calls).toEqual([1, 2]);
    expect(result.status).toBe("rendered");
    expect(result.attempts).toBe(2);
    expect(result.prose).toContain("linger a moment");
  });

  it("degrades to the deterministic fallback (never a dead chat) when every render is empty", async () => {
    const { seam } = soloSeam([""]);
    const result = await renderSoloNarration({ system: "s", prompt: "p", fallbackProse: FALLBACK }, { render: seam });
    expect(result.status).toBe("rendered");
    expect(result.prose).toBe(FALLBACK);
    expect(result.degraded).toBe(true);
    expect(result.diagnostics).toContain("sim.narrator.solo.degraded_to_fallback");
  });
});
