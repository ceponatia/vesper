import { describe, expect, it } from "vitest";
import { simulationBranchEventSchema, type SimulationBranchEvent } from "../contracts/branching";
import {
  defaultSoftCanonRules,
  deriveSoftCanonEntryId,
  softCanonEntrySchema,
  softCanonProposalSchema,
  type SoftCanonEntry,
  type SoftCanonProposal,
} from "../contracts/soft-canon";
import { eventEnvelope } from "../test-support/sim-envelopes";
import {
  isSoftCanonEntryLive,
  replaySoftCanonHistory,
  resolveDemoteSoftCanon,
  resolveSoftCanonProposals,
  selectCutSoftCanon,
} from "./soft-canon";

const NOW = 100_000;
const CUT = "cut-1";
const PARTICIPANTS = ["mara", "player"];
const ZONES = ["zone-cafe"];

function proposal(overrides: Record<string, unknown> = {}): SoftCanonProposal {
  return softCanonProposalSchema.parse({
    key: "nickname_for_player",
    value: "stray",
    scope: "relationship",
    subjectIds: ["mara", "player"],
    confidenceFixedPoint: 9_000,
    sourceCutId: CUT,
    ...overrides,
  });
}

function resolve(
  proposals: SoftCanonProposal[],
  entries: SoftCanonEntry[] = [],
  rules = defaultSoftCanonRules,
  storySecond = NOW,
) {
  return resolveSoftCanonProposals({
    branchId: "branch-1",
    cutId: CUT,
    participantActorIds: PARTICIPANTS,
    zoneIds: ZONES,
    proposals,
    entries,
    rules,
    storySecond,
  });
}

function entryFor(p: SoftCanonProposal, overrides: Record<string, unknown> = {}): SoftCanonEntry {
  return softCanonEntrySchema.parse({
    id: deriveSoftCanonEntryId("branch-1", p.scope, p.key, p.subjectIds),
    branchId: "branch-1",
    key: p.key,
    scope: p.scope,
    subjectIds: p.subjectIds,
    value: p.value,
    confidenceFixedPoint: p.confidenceFixedPoint,
    firstRecordedAt: NOW - 5_000,
    lastRecordedAt: NOW - 5_000,
    validUntil: NOW + 100_000,
    sourceCutIds: ["cut-earlier"],
    status: "active",
    rulesVersion: defaultSoftCanonRules.version,
    derivationVersion: "soft-canon-v1",
    ...overrides,
  });
}

describe("E4.3 resolveSoftCanonProposals (validation)", () => {
  it("mints a fresh entry with the scope's default TTL and this cut as provenance", () => {
    const { accepted, rejected } = resolve([proposal()]);
    expect(rejected).toEqual([]);
    expect(accepted).toHaveLength(1);
    expect(accepted[0]?.entry).toMatchObject({
      key: "nickname_for_player",
      status: "active",
      sourceCutIds: [CUT],
      validUntil: NOW + defaultSoftCanonRules.ttlStorySecondsByScope.relationship,
    });
    expect(accepted[0]?.reused).toBe(false);
    expect(accepted[0]?.promoted).toBe(false);
  });

  it("rejects provenance, confidence, scope, and privacy violations without failing the turn", () => {
    const { accepted, rejected } = resolve([
      proposal({ sourceCutId: "cut-other", key: "wrong_cut" }),
      proposal({ confidenceFixedPoint: 4_000, key: "hedged" }),
      // A stranger the cut never showed: soft canon cannot reach them.
      proposal({ key: "about_a_stranger", scope: "character", subjectIds: ["stranger"] }),
      // World scope carries no subjects at all.
      proposal({ key: "world_with_subject", scope: "world", subjectIds: ["mara"] }),
      // Location scope must name a zone the cut showed.
      proposal({ key: "wrong_zone", scope: "location", subjectIds: ["zone-elsewhere"] }),
    ]);
    expect(accepted).toEqual([]);
    expect(rejected.map((r) => r.code)).toEqual([
      "wrong_source_cut",
      "confidence_below_minimum",
      "subjects_outside_cut",
      "subjects_outside_cut",
      "subjects_outside_cut",
    ]);
  });

  it("rejects a conflicting value for a live key and duplicates within one batch", () => {
    const held = entryFor(proposal());
    const conflicting = proposal({ value: "kitten" });
    const { rejected } = resolve([conflicting], [held]);
    expect(rejected[0]?.code).toBe("conflicts_with_active_entry");

    const batch = resolve([proposal(), proposal({ value: "stray" })]);
    expect(batch.accepted).toHaveLength(1);
    expect(batch.rejected[0]?.code).toBe("duplicate_proposal");
  });

  it("bounds the store per scope and refuses to revive a demoted detail", () => {
    const tight = { ...defaultSoftCanonRules, maxEntriesPerScope: 1 };
    const held = entryFor(proposal());
    const overflow = resolve([proposal({ key: "second_detail" })], [held], tight);
    expect(overflow.rejected[0]?.code).toBe("scope_full");

    const demoted = entryFor(proposal(), {});
    const demotedEntry = softCanonEntrySchema.parse({ ...demoted, status: "demoted" });
    const revival = resolve([proposal()], [demotedEntry]);
    expect(revival.rejected[0]?.code).toBe("conflicts_with_active_entry");
  });

  it("treats a same-value re-proposal from a new cut as reuse and refreshes the clock", () => {
    const held = entryFor(proposal());
    const { accepted } = resolve([proposal()], [held]);
    expect(accepted[0]?.reused).toBe(true);
    expect(accepted[0]?.entry.sourceCutIds).toEqual(["cut-earlier", CUT]);
    expect(accepted[0]?.entry.lastRecordedAt).toBe(NOW);
    expect(accepted[0]?.entry.firstRecordedAt).toBe(NOW - 5_000);
    expect(accepted[0]?.promoted).toBe(false);
  });

  it("auto-promotes at the ruled reuse count — and only under the ruled conditions (ruling 14)", () => {
    const held = entryFor(proposal(), {});
    const twice = softCanonEntrySchema.parse({ ...held, sourceCutIds: ["cut-a", "cut-b"] });
    const { accepted } = resolve([proposal()], [twice]);
    expect(accepted[0]?.promoted).toBe(true);
    expect(accepted[0]?.reuseCutCount).toBe(3);
    // The recorded snapshot stays active; promotion is its own audited event.
    expect(accepted[0]?.entry.status).toBe("active");

    // A world type may disable auto-promotion entirely.
    const disabled = resolve([proposal()], [twice], { ...defaultSoftCanonRules, autoPromotionEnabled: false });
    expect(disabled.accepted[0]?.promoted).toBe(false);

    // Scene flavor never promotes: the scope is not in promotableScopes.
    const sceneProposal = proposal({ key: "scene_flair", scope: "scene", subjectIds: ["mara"] });
    const sceneHeld = softCanonEntrySchema.parse({
      ...entryFor(sceneProposal),
      sourceCutIds: ["cut-a", "cut-b"],
    });
    const scene = resolve([sceneProposal], [sceneHeld]);
    expect(scene.accepted[0]?.promoted).toBe(false);

    // Below the promotion confidence floor, reuse never canonizes a hedge.
    const hedged = softCanonEntrySchema.parse({
      ...twice,
      confidenceFixedPoint: 6_000,
    });
    const hedgedProposal = proposal({ confidenceFixedPoint: 6_000 });
    const hedgedResolution = resolve([hedgedProposal], [hedged]);
    expect(hedgedResolution.accepted[0]?.promoted).toBe(false);
  });

  it("revives an expired key as a fresh mint with new provenance", () => {
    const expired = softCanonEntrySchema.parse({
      ...entryFor(proposal()),
      validUntil: NOW - 1,
    });
    const { accepted } = resolve([proposal({ value: "songbird" })], [expired]);
    expect(accepted[0]?.reused).toBe(false);
    expect(accepted[0]?.entry).toMatchObject({
      value: "songbird",
      sourceCutIds: [CUT],
      firstRecordedAt: NOW,
    });
  });
});

describe("E4.3 demotion and liveness", () => {
  it("demotes active and promoted entries, never a demoted one, and never erases history", () => {
    const active = entryFor(proposal());
    const demotion = resolveDemoteSoftCanon(active, NOW);
    expect(demotion.ok && demotion.entry.status === "demoted").toBe(true);

    const promoted = softCanonEntrySchema.parse({ ...active, status: "promoted" });
    expect(resolveDemoteSoftCanon(promoted, NOW).ok).toBe(true);

    const demoted = softCanonEntrySchema.parse({ ...active, status: "demoted" });
    const refused = resolveDemoteSoftCanon(demoted, NOW);
    expect(!refused.ok && refused.code === "entry_not_demotable").toBe(true);
    expect(resolveDemoteSoftCanon(undefined, NOW).ok).toBe(false);
  });

  it("computes liveness lazily: active entries expire, promoted canon does not", () => {
    const entry = entryFor(proposal());
    expect(isSoftCanonEntryLive(entry, NOW)).toBe(true);
    expect(isSoftCanonEntryLive(entry, NOW + 200_000)).toBe(false);
    const promoted = softCanonEntrySchema.parse({ ...entry, status: "promoted" });
    expect(isSoftCanonEntryLive(promoted, NOW + 200_000)).toBe(true);
    const demoted = softCanonEntrySchema.parse({ ...entry, status: "demoted" });
    expect(isSoftCanonEntryLive(demoted, NOW)).toBe(false);
  });
});

function canonEvent(
  sequence: number,
  type: "soft_canon_recorded" | "soft_canon_promoted" | "soft_canon_demoted",
  entry: SoftCanonEntry,
): SimulationBranchEvent {
  return eventEnvelope(simulationBranchEventSchema, {
    type,
    idSlug: "canon",
    sequence,
    storySecond: NOW,
    rulesetVersion: "test-v1",
    commandId: `cmd-${sequence}`,
    overrides: { derivationVersion: "soft-canon-v1" },
    payload:
      type === "soft_canon_recorded"
        ? { proposal: proposal(), derived: { entry, reused: false } }
        : type === "soft_canon_promoted"
          ? {
              entry,
              reuseCutCount: 3,
              thresholds: {
                rulesVersion: defaultSoftCanonRules.version,
                promotionReuseCutCount: 3,
                promotionMinimumConfidenceFixedPoint: 7_000,
              },
            }
          : { entry, reason: "storyteller retraction" },
  });
}

describe("E4.3 replaySoftCanonHistory (snapshot fold)", () => {
  it("rebuilds the ledger from event snapshots alone, last snapshot winning", () => {
    const base = entryFor(proposal());
    const promoted = softCanonEntrySchema.parse({ ...base, status: "promoted", statusChangedAt: NOW });
    const demoted = softCanonEntrySchema.parse({ ...promoted, status: "demoted", statusChangedAt: NOW + 10 });
    const events = [
      canonEvent(1, "soft_canon_recorded", base),
      canonEvent(2, "soft_canon_promoted", promoted),
      canonEvent(3, "soft_canon_demoted", demoted),
    ];
    const replayed = replaySoftCanonHistory(events);
    expect(replayed).toHaveLength(1);
    expect(replayed[0]?.status).toBe("demoted");
    // Order independence: the fold sorts by sequence before applying.
    expect(replaySoftCanonHistory([...events].reverse())).toEqual(replayed);
  });
});

describe("E4.3 selectCutSoftCanon", () => {
  it("licenses only live, in-scope entries, promoted first, bounded, id-ordered", () => {
    const relationship = entryFor(proposal());
    const foreign = softCanonEntrySchema.parse({
      ...entryFor(proposal({ key: "foreign_pair", subjectIds: ["iris", "stranger"] })),
      subjectIds: ["iris", "stranger"],
    });
    const expired = softCanonEntrySchema.parse({
      ...entryFor(proposal({ key: "stale_detail" })),
      validUntil: NOW - 1,
    });
    const world = softCanonEntrySchema.parse({
      ...entryFor(proposal({ key: "rains_often", scope: "world", subjectIds: [] })),
      scope: "world",
      subjectIds: [],
      status: "promoted",
    });
    const selected = selectCutSoftCanon({
      entries: [relationship, foreign, expired, world],
      participantActorIds: PARTICIPANTS,
      zoneIds: ZONES,
      storySecond: NOW,
      limit: 32,
    });
    expect(selected.map((entry) => entry.key).sort()).toEqual(["nickname_for_player", "rains_often"]);
    const limited = selectCutSoftCanon({
      entries: [relationship, world],
      participantActorIds: PARTICIPANTS,
      zoneIds: ZONES,
      storySecond: NOW,
      limit: 1,
    });
    // The promoted world detail outranks fresher scene flavor at the cap.
    expect(limited.map((entry) => entry.key)).toEqual(["rains_often"]);
  });
});
