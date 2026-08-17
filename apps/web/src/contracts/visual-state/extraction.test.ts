import { describe, expect, it } from "vitest";
import { expectCleanSink, expectDiagnostic } from "@/test/diagnostics";
import { fnv1aHex } from "@/lib/hash";
import { freckleClusterFact } from "../appearance-features";
import { attributeRegistry } from "../attributes";
import { toUnitInterval } from "../affordances/core";
import { DiagnosticCollector } from "../diagnostics";
import {
  VISUAL_STATE_EXTRACTION_CONFLICT,
  VISUAL_STATE_EXTRACTION_OWNER_UNAVAILABLE,
  VISUAL_STATE_EXTRACTION_PROPOSAL_INVALID,
} from "./diagnostics";
import {
  diffVisualExtractionProposal,
  parseVisualContractProposals,
  planVisualExtractionApply,
  reconcileVisualExtractionProposal,
  visualExtractionCurrentDigest,
  visualExtractionReviewTransition,
  visualExtractionSlotKey,
  VISUAL_EXTRACTION_MAX_PROPOSALS,
  VISUAL_EXTRACTION_SOURCE_ID_PREFIX,
  type VisualExtractionCanonicalTruth,
  type VisualExtractionPriorDecision,
} from "./extraction";
import { visualStateFingerprint } from "./feature";
import { visualStateGroomedPresentation } from "./fixtures";
import { emptyCharacterPresentationState } from "./presentation";

/**
 * Reference-image extraction — the pure half (slice 9). The property the whole
 * suite circles is the plan's success criterion: extraction proposes and can
 * NEVER write. Every function here returns data; the deep-freeze cases prove
 * canonical truth survives the full pipeline untouched.
 */

const CONFIDENCE = toUnitInterval(7_500);

function attributeProposal(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    targetOwner: "attribute",
    kindId: "hair.color",
    value: "auburn",
    confidence: CONFIDENCE,
    ...overrides,
  };
}

function freckleProposal(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    targetOwner: "located_fact",
    kindId: "pigmentation.freckle_cluster",
    locus: { bodyLocationId: "shoulders" },
    value: { density: "dense", pattern: "clustered" },
    confidence: CONFIDENCE,
    ...overrides,
  };
}

function hairstyleProposal(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    targetOwner: "presentation",
    kindId: "presentation.hairstyle",
    locus: { bodyLocationId: "hair" },
    value: { arrangement: "loose" },
    confidence: CONFIDENCE,
    ...overrides,
  };
}

function emptyTruth(): VisualExtractionCanonicalTruth {
  return {
    attributes: [],
    locatedFacts: [],
    presentation: emptyCharacterPresentationState(),
    atMinutes: 0,
  };
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const key of Object.keys(value as Record<string, unknown>)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

describe("parseVisualContractProposals — the untrusted boundary", () => {
  it("accepts one valid proposal per target owner, values re-issued by the owner's parser", () => {
    const sink = new DiagnosticCollector();
    const kept = parseVisualContractProposals(
      [attributeProposal(), freckleProposal(), hairstyleProposal()],
      sink,
    );
    expectCleanSink(sink);
    expect(kept.map((proposal) => proposal.slotKey)).toEqual([
      "attribute/hair.color",
      "located_fact/shoulders/pigmentation.freckle_cluster",
      "presentation/hair/presentation.hairstyle",
    ]);
    expect(kept[0]?.proposedFingerprint).toBe(visualStateFingerprint("auburn"));
    expect(kept[1]?.value).toEqual({ density: "dense", pattern: "clustered" });
  });

  it("orders output by slot key, deterministically", () => {
    const first = parseVisualContractProposals([hairstyleProposal(), attributeProposal(), freckleProposal()]);
    const second = parseVisualContractProposals([attributeProposal(), freckleProposal(), hairstyleProposal()]);
    expect(first).toEqual(second);
    expect(first.map((proposal) => proposal.slotKey)).toEqual([...first.map((p) => p.slotKey)].sort());
  });

  it("drops an unknown attribute id with the extraction code", () => {
    const sink = new DiagnosticCollector();
    expect(parseVisualContractProposals([attributeProposal({ kindId: "hair.mystery" })], sink)).toEqual([]);
    expectDiagnostic(sink, VISUAL_STATE_EXTRACTION_PROPOSAL_INVALID);
  });

  it("refuses a non-visual (sensory) attribute — an image cannot testify about a voice", () => {
    const sink = new DiagnosticCollector();
    expect(
      parseVisualContractProposals([attributeProposal({ kindId: "voice.pitch", value: "low" })], sink),
    ).toEqual([]);
    expectDiagnostic(sink, VISUAL_STATE_EXTRACTION_PROPOSAL_INVALID);
  });

  it("refuses an attribute proposal carrying a locus", () => {
    const sink = new DiagnosticCollector();
    expect(
      parseVisualContractProposals([attributeProposal({ locus: { bodyLocationId: "hair" } })], sink),
    ).toEqual([]);
    expectDiagnostic(sink, VISUAL_STATE_EXTRACTION_PROPOSAL_INVALID);
  });

  it("drops a value the attribute registry refuses", () => {
    const sink = new DiagnosticCollector();
    expect(parseVisualContractProposals([attributeProposal({ value: "chartreuse" })], sink)).toEqual([]);
    expectDiagnostic(sink, VISUAL_STATE_EXTRACTION_PROPOSAL_INVALID);
  });

  it("requires a locus on a located-fact proposal and honors the kind's allowed locations", () => {
    const sink = new DiagnosticCollector();
    expect(
      parseVisualContractProposals(
        [freckleProposal({ locus: undefined }), freckleProposal({ locus: { bodyLocationId: "legs" } })],
        sink,
      ),
    ).toEqual([]);
    expectDiagnostic(sink, VISUAL_STATE_EXTRACTION_PROPOSAL_INVALID, { times: 2 });
  });

  it("refuses a registered-but-item-backed presentation kind", () => {
    const sink = new DiagnosticCollector();
    expect(
      parseVisualContractProposals([hairstyleProposal({ kindId: "wardrobe.garment" })], sink),
    ).toEqual([]);
    expectDiagnostic(sink, VISUAL_STATE_EXTRACTION_PROPOSAL_INVALID);
  });

  it("keys grooming slots on the discriminator, exactly as the presentation owner does", () => {
    const kept = parseVisualContractProposals([
      hairstyleProposal({
        kindId: "presentation.grooming",
        locus: { bodyLocationId: "face" },
        value: { area: "brows", state: "shaped" },
      }),
      hairstyleProposal({
        kindId: "presentation.grooming",
        locus: { bodyLocationId: "face" },
        value: { area: "facial_hair", state: "trimmed" },
      }),
    ]);
    expect(kept.map((proposal) => proposal.slotKey)).toEqual([
      "presentation/face/presentation.grooming:brows",
      "presentation/face/presentation.grooming:facial_hair",
    ]);
  });

  it("drops a non-record item alone, keeping the rest", () => {
    const sink = new DiagnosticCollector();
    const kept = parseVisualContractProposals(["not a proposal", attributeProposal()], sink);
    expect(kept).toHaveLength(1);
    expectDiagnostic(sink, VISUAL_STATE_EXTRACTION_PROPOSAL_INVALID);
  });

  it("rejects a confidence outside the fixed-point unit interval", () => {
    const sink = new DiagnosticCollector();
    expect(parseVisualContractProposals([attributeProposal({ confidence: 10_001 })], sink)).toEqual([]);
    expect(parseVisualContractProposals([attributeProposal({ confidence: 0.5 })], sink)).toEqual([]);
    expectDiagnostic(sink, VISUAL_STATE_EXTRACTION_PROPOSAL_INVALID, { times: 2 });
  });

  it("keeps the first proposal when one run claims a slot twice", () => {
    const sink = new DiagnosticCollector();
    const kept = parseVisualContractProposals(
      [attributeProposal({ value: "auburn" }), attributeProposal({ value: "black" })],
      sink,
    );
    expect(kept).toHaveLength(1);
    expect(kept[0]?.value).toBe("auburn");
    expectDiagnostic(sink, VISUAL_STATE_EXTRACTION_PROPOSAL_INVALID);
  });

  it("caps a run with a report rather than silence", () => {
    const enums = attributeRegistry.definitions.filter(
      (definition) =>
        definition.kind !== "sensory" &&
        definition.valueType === "enum" &&
        (definition.allowedValues?.length ?? 0) > 0 &&
        (definition.appliesToEntityKinds ?? ["character"]).includes("character"),
    );
    expect(enums.length).toBeGreaterThan(VISUAL_EXTRACTION_MAX_PROPOSALS);
    const flood = enums
      .slice(0, VISUAL_EXTRACTION_MAX_PROPOSALS + 1)
      .map((definition) =>
        attributeProposal({ kindId: definition.id, value: definition.allowedValues?.[0] }),
      );
    const sink = new DiagnosticCollector();
    const kept = parseVisualContractProposals(flood, sink);
    expect(kept).toHaveLength(VISUAL_EXTRACTION_MAX_PROPOSALS);
    expectDiagnostic(sink, VISUAL_STATE_EXTRACTION_PROPOSAL_INVALID);
  });

  it("never throws on garbage", () => {
    const sink = new DiagnosticCollector();
    expect(parseVisualContractProposals("not even an array", sink)).toEqual([]);
    expect(parseVisualContractProposals(null, sink)).toEqual([]);
  });
});

describe("diffVisualExtractionProposal — canonical truth stays read-only", () => {
  it("reads `new` when the owner holds nothing in the slot", () => {
    const diff = diffVisualExtractionProposal(emptyTruth(), "attribute", "hair.color", undefined, "auburn");
    expect(diff.verdict).toBe("new");
    expect(diff.currentValues).toEqual([]);
    expect(diff.currentDigest).toBe(fnv1aHex(""));
  });

  it("reads `same` and `different` off the canonical fingerprint", () => {
    const truth: VisualExtractionCanonicalTruth = {
      ...emptyTruth(),
      attributes: [{ id: "hair.color", value: "auburn", source: "creation" }],
    };
    expect(diffVisualExtractionProposal(truth, "attribute", "hair.color", undefined, "auburn").verdict).toBe("same");
    expect(diffVisualExtractionProposal(truth, "attribute", "hair.color", undefined, "black").verdict).toBe("different");
  });

  it("treats located facts as multi-instance: matching ANY active value reads `same`", () => {
    const locus = { bodyLocationId: "shoulders" } as const;
    const truth: VisualExtractionCanonicalTruth = {
      ...emptyTruth(),
      locatedFacts: [
        freckleClusterFact({ id: "f1", density: "dense", pattern: "clustered" }),
        freckleClusterFact({ id: "f2", density: "sparse", pattern: "scattered" }),
      ],
    };
    const same = diffVisualExtractionProposal(truth, "located_fact", "pigmentation.freckle_cluster", locus, {
      density: "sparse",
      pattern: "scattered",
    });
    expect(same.verdict).toBe("same");
    expect(same.currentValues).toHaveLength(2);
    const different = diffVisualExtractionProposal(truth, "located_fact", "pigmentation.freckle_cluster", locus, {
      density: "moderate",
      pattern: "band",
    });
    expect(different.verdict).toBe("different");
  });

  it("excludes located facts outside their validity window", () => {
    const locus = { bodyLocationId: "shoulders" } as const;
    const truth: VisualExtractionCanonicalTruth = {
      ...emptyTruth(),
      atMinutes: 100,
      locatedFacts: [freckleClusterFact({ id: "gone", validFrom: 0, validUntil: 50 })],
    };
    expect(
      diffVisualExtractionProposal(truth, "located_fact", "pigmentation.freckle_cluster", locus, {
        density: "dense",
        pattern: "clustered",
      }).verdict,
    ).toBe("new");
  });

  it("diffs presentation against the entry in the same slot", () => {
    const truth: VisualExtractionCanonicalTruth = {
      ...emptyTruth(),
      presentation: visualStateGroomedPresentation(),
    };
    const locus = { bodyLocationId: "hair" } as const;
    expect(
      diffVisualExtractionProposal(truth, "presentation", "presentation.hairstyle", locus, {
        arrangement: "loose",
      }).verdict,
    ).toBe("same");
    expect(
      diffVisualExtractionProposal(truth, "presentation", "presentation.hairstyle", locus, {
        arrangement: "braided",
      }).verdict,
    ).toBe("different");
  });

  it("computes a digest independent of canonical order", () => {
    const forward = visualExtractionCurrentDigest(["aa", "bb"]);
    const backward = visualExtractionCurrentDigest(["bb", "aa"]);
    expect(forward).toBe(backward);
    expect(visualExtractionCurrentDigest([])).toBe(fnv1aHex(""));
    expect(visualExtractionCurrentDigest(["aa"])).not.toBe(forward);
  });

  it("never mutates canonical truth", () => {
    const truth = deepFreeze({
      ...emptyTruth(),
      attributes: [{ id: "hair.color" as const, value: "auburn", source: "creation" as const }],
      locatedFacts: [freckleClusterFact()],
      presentation: visualStateGroomedPresentation(),
    });
    expect(() =>
      diffVisualExtractionProposal(truth, "attribute", "hair.color", undefined, "black"),
    ).not.toThrow();
  });
});

describe("reconcileVisualExtractionProposal — rulings carry, disagreements conflict", () => {
  const SLOT = "attribute/hair.color";
  const auburn = visualStateFingerprint("auburn");
  const black = visualStateFingerprint("black");

  function ruling(overrides: Partial<VisualExtractionPriorDecision> = {}): VisualExtractionPriorDecision {
    return {
      proposalId: "prior_1",
      slotKey: SLOT,
      status: "accepted",
      proposedFingerprint: auburn,
      ...overrides,
    };
  }

  it("is fresh with no history", () => {
    const sink = new DiagnosticCollector();
    expect(reconcileVisualExtractionProposal([], SLOT, auburn, sink)).toEqual({ kind: "fresh" });
    expectCleanSink(sink);
  });

  it("carries an identical machine claim's ruling, manual edit included", () => {
    const sink = new DiagnosticCollector();
    expect(
      reconcileVisualExtractionProposal([ruling({ editedValue: "red" })], SLOT, auburn, sink),
    ).toEqual({ kind: "carried", fromProposalId: "prior_1", status: "accepted", editedValue: "red" });
    expectCleanSink(sink);
  });

  it("carries `applied` as `accepted` and `rejected` as `rejected`", () => {
    expect(reconcileVisualExtractionProposal([ruling({ status: "applied" })], SLOT, auburn)).toMatchObject({
      kind: "carried",
      status: "accepted",
    });
    expect(reconcileVisualExtractionProposal([ruling({ status: "rejected" })], SLOT, auburn)).toMatchObject({
      kind: "carried",
      status: "rejected",
    });
  });

  it("conflicts — never overwrites — when the machine's claim moved, with the reserved code", () => {
    const sink = new DiagnosticCollector();
    expect(reconcileVisualExtractionProposal([ruling()], SLOT, black, sink)).toEqual({
      kind: "conflict",
      withProposalId: "prior_1",
    });
    expectDiagnostic(sink, VISUAL_STATE_EXTRACTION_CONFLICT);
  });

  it("consults only the newest ruling for the slot", () => {
    const decisions = [
      ruling({ proposalId: "newest", proposedFingerprint: black, status: "rejected" }),
      ruling({ proposalId: "older", proposedFingerprint: auburn }),
    ];
    expect(reconcileVisualExtractionProposal(decisions, SLOT, black)).toMatchObject({
      kind: "carried",
      fromProposalId: "newest",
      status: "rejected",
    });
    const sink = new DiagnosticCollector();
    expect(reconcileVisualExtractionProposal(decisions, SLOT, auburn, sink)).toMatchObject({
      kind: "conflict",
      withProposalId: "newest",
    });
    expectDiagnostic(sink, VISUAL_STATE_EXTRACTION_CONFLICT);
  });

  it("ignores rulings about other slots", () => {
    expect(
      reconcileVisualExtractionProposal([ruling({ slotKey: "attribute/eyes.color" })], SLOT, auburn),
    ).toEqual({ kind: "fresh" });
  });
});

describe("visualExtractionReviewTransition — the review state machine", () => {
  it("lets a human rule and re-rule anything unapplied", () => {
    for (const status of ["pending", "accepted", "rejected"] as const) {
      expect(visualExtractionReviewTransition(status, "accept")).toEqual({ ok: true, next: "accepted" });
      expect(visualExtractionReviewTransition(status, "reject")).toEqual({ ok: true, next: "rejected" });
    }
  });

  it("keeps applied and superseded immutable", () => {
    for (const status of ["applied", "superseded"] as const) {
      expect(visualExtractionReviewTransition(status, "accept").ok).toBe(false);
      expect(visualExtractionReviewTransition(status, "reject").ok).toBe(false);
    }
  });
});

describe("planVisualExtractionApply — the only door into an owner, and it is data", () => {
  it("plans an attribute write as a manual-source value with proposal provenance", () => {
    const sink = new DiagnosticCollector();
    const plan = planVisualExtractionApply(
      { proposalId: "prop_1", targetOwner: "attribute", kindId: "hair.color", value: "auburn" },
      sink,
    );
    expectCleanSink(sink);
    expect(plan).toEqual({
      kind: "attribute",
      next: {
        id: "hair.color",
        value: "auburn",
        source: "manual",
        sourceId: `${VISUAL_EXTRACTION_SOURCE_ID_PREFIX}:prop_1`,
      },
    });
  });

  it("returns null with a diagnostic when the value no longer parses", () => {
    const sink = new DiagnosticCollector();
    expect(
      planVisualExtractionApply(
        { proposalId: "prop_1", targetOwner: "attribute", kindId: "hair.color", value: "chartreuse" },
        sink,
      ),
    ).toBeNull();
    expectDiagnostic(sink, VISUAL_STATE_EXTRACTION_PROPOSAL_INVALID);
  });

  it("answers `unavailable` for the two ownerless targets, with the owner-unavailable code", () => {
    for (const targetOwner of ["located_fact", "presentation"] as const) {
      const sink = new DiagnosticCollector();
      expect(
        planVisualExtractionApply(
          {
            proposalId: "prop_1",
            targetOwner,
            kindId: targetOwner === "presentation" ? "presentation.hairstyle" : "pigmentation.freckle_cluster",
            locus: { bodyLocationId: "hair" },
            value: {},
          },
          sink,
        ),
      ).toEqual({ kind: "unavailable", targetOwner });
      expectDiagnostic(sink, VISUAL_STATE_EXTRACTION_OWNER_UNAVAILABLE);
    }
  });
});

describe("the pipeline cannot write truth", () => {
  it("runs parse → diff → reconcile → plan over deep-frozen inputs without a single mutation", () => {
    const truth = deepFreeze({
      ...emptyTruth(),
      attributes: [{ id: "hair.color" as const, value: "black", source: "creation" as const }],
      presentation: visualStateGroomedPresentation(),
    });
    const raw = deepFreeze([attributeProposal(), freckleProposal(), hairstyleProposal()]);
    const priors = deepFreeze<VisualExtractionPriorDecision[]>([
      {
        proposalId: "prior_1",
        slotKey: "attribute/hair.color",
        status: "accepted",
        proposedFingerprint: visualStateFingerprint("black"),
      },
    ]);

    const sink = new DiagnosticCollector();
    const kept = parseVisualContractProposals(raw, sink);
    for (const proposal of kept) {
      const diff = diffVisualExtractionProposal(truth, proposal.targetOwner, proposal.kindId, proposal.locus, proposal.value);
      reconcileVisualExtractionProposal(priors, proposal.slotKey, proposal.proposedFingerprint, sink);
      planVisualExtractionApply(
        {
          proposalId: "prop_x",
          targetOwner: proposal.targetOwner,
          kindId: proposal.kindId,
          ...(proposal.locus === undefined ? {} : { locus: proposal.locus }),
          value: proposal.value,
        },
        sink,
      );
      expect(diff.slotKey).toBe(proposal.slotKey);
    }
    // The frozen canonical state is byte-identical to a fresh build: nothing wrote.
    expect(truth.attributes).toEqual([{ id: "hair.color", value: "black", source: "creation" }]);
    expect(truth.presentation).toEqual(visualStateGroomedPresentation());
  });
});

describe("slot keys", () => {
  it("are stable and owner-prefixed", () => {
    expect(visualExtractionSlotKey("attribute", "hair.color", undefined, "auburn")).toBe("attribute/hair.color");
    expect(
      visualExtractionSlotKey("located_fact", "mark.scar", { bodyLocationId: "face", side: "left" }, {}),
    ).toBe("located_fact/face:left/mark.scar");
    expect(
      visualExtractionSlotKey(
        "presentation",
        "presentation.cosmetic_mark",
        { bodyLocationId: "face" },
        { mark: "face_paint" },
      ),
    ).toBe("presentation/face/presentation.cosmetic_mark:face_paint");
  });
});
