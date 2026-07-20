import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { zoneEnteredEventSchema } from "@/contracts/simulation/access";
import type { SimulationBranchEvent } from "@/contracts/simulation/branching";
import { KNOWLEDGE_DERIVATION_VERSION, disclosureMadeEventSchema, type disclosureContentSchema } from "@/contracts/simulation/knowledge";
import { engagementEndedEventSchema } from "@/contracts/simulation/engagements";
import { speechActDeliveredEventSchema, speechActTypes, type SpeechActType } from "@/contracts/simulation/narrative";
import {
  attractionBandKeys,
  authoredRelationshipLedgerKinds,
  relationshipChangeRecordedEventSchema,
  relationshipEntryAuthoredEventSchema,
  relationshipLedgerEntrySchema,
  relationshipLedgerKindPayloadKind,
  relationshipLedgerKinds,
  relationshipLedgerWeightRegistryV1,
  resentmentBandKeys,
  socialDerivationVersion,
  trustBandKeys,
  type AuthoredRelationshipLedgerKind,
  type ConsentScopeKey,
  type relationshipLedgerPayloadSchema,
  type RelationshipLedgerEntry,
  type RelationshipLedgerKind,
  type RelationshipLedgerWeight,
} from "@/contracts/simulation/social";
import { sortedUnique } from "./hash";
import {
  ATTRACTION_BAND_THRESHOLDS,
  RESENTMENT_BAND_THRESHOLDS,
  TRUST_BAND_THRESHOLDS,
  deriveRelationshipLedgerEntries,
  deriveRelationshipLedgerEntryId,
  deriveRelationshipRead,
  replaySocialLedgerHistory,
  resolveConsentCoverage,
  type DeriveLedgerEntriesInput,
} from "./social";

// `z.input<...>` (pre-brand) shapes — these fixtures build plain-string
// literals that flow into a `.parse()` call, mirroring households.test.ts's
// `*CommandInput` idiom for the same reason: a branded `z.infer` output type
// would reject an unbranded string literal before the schema ever runs.
type DisclosureContentInput = z.input<typeof disclosureContentSchema>;
type RelationshipLedgerPayloadInput = z.input<typeof relationshipLedgerPayloadSchema>;

/**
 * E5.5 slice 1 — the pure social-ledger kernel (engine.spec §21.3–21.4):
 * `deriveRelationshipLedgerEntries`'s fold, `deriveRelationshipRead`'s
 * decayed trust/attraction/resentment projection, and `resolveConsentCoverage`'s
 * fail-closed gate (uncalled by any live path yet, tested standalone).
 */

const WORLD = "world-e5-5";
const BRANCH = "branch-e5-5";
const RULESET = "e5-5-test-v1";
const ACTOR_A = "actor-aiko";
const ACTOR_B = "actor-bram";
const ACTOR_C = "actor-cora";
const ACTOR_D = "actor-dov";
const WALL_CLOCK = "2026-07-19T10:00:00.000Z";

const NO_COMMITMENTS: DeriveLedgerEntriesInput["commitmentById"] = () => undefined;

function fold(events: readonly SimulationBranchEvent[]): RelationshipLedgerEntry[] {
  return deriveRelationshipLedgerEntries({ events, commitmentById: NO_COMMITMENTS });
}

// ---------------------------------------------------------------------------
// Event builders — mirrors households.test.ts's command-builder shape
// ---------------------------------------------------------------------------

function speechActEvent(
  effectType: SpeechActType,
  overrides: {
    actorId?: string;
    targetActorIds?: string[];
    consentScopeKey?: ConsentScopeKey;
    sequence?: number;
    storySecond?: number;
    id?: string;
  } = {},
) {
  const actorId = overrides.actorId ?? ACTOR_A;
  const targetActorIds = sortedUnique(overrides.targetActorIds ?? [ACTOR_B]);
  return speechActDeliveredEventSchema.parse({
    id: overrides.id ?? `event-speech-${effectType}-${overrides.sequence ?? 1}`,
    worldId: WORLD,
    branchId: BRANCH,
    sequence: overrides.sequence ?? 1,
    storySecond: overrides.storySecond ?? 1_000,
    rulesetVersion: RULESET,
    correlationId: "corr-1",
    actorIds: sortedUnique([actorId, ...targetActorIds]),
    entityIds: [],
    recordedAtWallClock: WALL_CLOCK,
    commandId: "cmd-speech",
    type: "speech_act_delivered",
    schemaVersion: 1,
    payload: {
      cutId: "cut-1",
      engagementId: "engagement-1",
      effectType,
      actorId,
      targetActorIds,
      detail: "spoken detail",
      ...(overrides.consentScopeKey === undefined ? {} : { consentScopeKey: overrides.consentScopeKey }),
    },
  });
}

function disclosureEvent(
  content: DisclosureContentInput,
  overrides: { speakerActorId?: string; targetActorIds?: string[]; sequence?: number; storySecond?: number } = {},
) {
  const speakerActorId = overrides.speakerActorId ?? ACTOR_A;
  const targetActorIds = sortedUnique(overrides.targetActorIds ?? [ACTOR_B]);
  return disclosureMadeEventSchema.parse({
    id: `event-disclosure-${overrides.sequence ?? 1}`,
    worldId: WORLD,
    branchId: BRANCH,
    sequence: overrides.sequence ?? 1,
    storySecond: overrides.storySecond ?? 1_000,
    rulesetVersion: RULESET,
    correlationId: "corr-1",
    actorIds: sortedUnique([speakerActorId, ...targetActorIds]),
    entityIds: [],
    recordedAtWallClock: WALL_CLOCK,
    commandId: "cmd-disclosure",
    derivationVersion: KNOWLEDGE_DERIVATION_VERSION,
    type: "disclosure_made",
    schemaVersion: 1,
    payload: {
      speakerActorId,
      targetActorIds,
      content,
      derived: {
        assertionId: "assertion-1",
        sourceConfidenceFixedPoint: 10_000,
        learnedFromActorIds: [speakerActorId],
      },
    },
  });
}

function engagementEndedEvent(
  participants: readonly string[],
  overrides: { sequence?: number; storySecond?: number } = {},
) {
  const storySecond = overrides.storySecond ?? 1_000;
  return engagementEndedEventSchema.parse({
    id: `event-engagement-ended-${overrides.sequence ?? 1}`,
    worldId: WORLD,
    branchId: BRANCH,
    sequence: overrides.sequence ?? 1,
    storySecond,
    rulesetVersion: RULESET,
    correlationId: "corr-1",
    actorIds: sortedUnique([...participants]),
    entityIds: [],
    recordedAtWallClock: WALL_CLOCK,
    type: "engagement_ended",
    schemaVersion: 1,
    payload: { engagementId: "engagement-1", endedAt: storySecond, reason: "participant_choice" },
  });
}

function relationshipEntryAuthoredEvent(
  kind: AuthoredRelationshipLedgerKind,
  overrides: {
    fromActorId?: string;
    toActorId?: string;
    entryStorySecond?: number;
    eventStorySecond?: number;
    scopeKey?: ConsentScopeKey;
    weightOverride?: RelationshipLedgerWeight;
    sequence?: number;
  } = {},
) {
  const fromActorId = overrides.fromActorId ?? ACTOR_A;
  const toActorId = overrides.toActorId ?? ACTOR_B;
  const eventStorySecond = overrides.eventStorySecond ?? 1_000;
  return relationshipEntryAuthoredEventSchema.parse({
    id: `event-authored-${kind}-${overrides.sequence ?? 1}`,
    worldId: WORLD,
    branchId: BRANCH,
    sequence: overrides.sequence ?? 1,
    storySecond: eventStorySecond,
    rulesetVersion: RULESET,
    correlationId: "corr-1",
    actorIds: sortedUnique([fromActorId, toActorId]),
    entityIds: sortedUnique([fromActorId, toActorId]),
    recordedAtWallClock: WALL_CLOCK,
    commandId: "cmd-authored",
    type: "relationship_entry_authored",
    schemaVersion: 1,
    payload: {
      fromActorId,
      toActorId,
      kind,
      detail: "authored detail",
      entryStorySecond: overrides.entryStorySecond ?? eventStorySecond,
      ...(overrides.weightOverride === undefined ? {} : { weightOverride: overrides.weightOverride }),
      ...(overrides.scopeKey === undefined ? {} : { scopeKey: overrides.scopeKey }),
    },
  });
}

function relationshipChangeRecordedEvent(
  overrides: { fromActorId?: string; toActorId?: string; changeKey?: string; sequence?: number; storySecond?: number } = {},
) {
  const fromActorId = overrides.fromActorId ?? ACTOR_A;
  const toActorId = overrides.toActorId ?? ACTOR_B;
  return relationshipChangeRecordedEventSchema.parse({
    id: `event-change-${overrides.sequence ?? 1}`,
    worldId: WORLD,
    branchId: BRANCH,
    sequence: overrides.sequence ?? 1,
    storySecond: overrides.storySecond ?? 1_000,
    rulesetVersion: RULESET,
    correlationId: "corr-1",
    actorIds: sortedUnique([fromActorId, toActorId]),
    entityIds: sortedUnique([fromActorId, toActorId]),
    recordedAtWallClock: WALL_CLOCK,
    commandId: "cmd-change",
    type: "relationship_change_recorded",
    schemaVersion: 1,
    payload: { fromActorId, toActorId, changeKey: overrides.changeKey ?? "began_dating", detail: "change detail" },
  });
}

function unrelatedEvent(sequence = 1) {
  return zoneEnteredEventSchema.parse({
    id: `event-zone-entered-${sequence}`,
    worldId: WORLD,
    branchId: BRANCH,
    sequence,
    storySecond: 1_000,
    rulesetVersion: RULESET,
    correlationId: "corr-1",
    actorIds: [ACTOR_A],
    entityIds: [],
    recordedAtWallClock: WALL_CLOCK,
    commandId: "cmd-zone",
    type: "zone_entered",
    schemaVersion: 1,
    payload: {
      actorId: ACTOR_A,
      linkId: "link-1",
      fromZoneId: "zone-a",
      toZoneId: "zone-b",
      basis: "public",
      observerActorIds: [],
    },
  });
}

let entryCounter = 0;

function ledgerEntry(overrides: {
  kind: RelationshipLedgerKind;
  fromActorId?: string;
  toActorId?: string;
  payload?: RelationshipLedgerPayloadInput;
  detail?: string;
  sequence?: number;
  storySecond?: number;
  id?: string;
  sourceEventId?: string;
}): RelationshipLedgerEntry {
  entryCounter += 1;
  const payloadKind = relationshipLedgerKindPayloadKind[overrides.kind];
  const defaultPayload: RelationshipLedgerPayloadInput =
    payloadKind === "consent"
      ? { kind: "consent", scopeKey: "kiss" }
      : payloadKind === "commitment"
        ? { kind: "commitment", commitmentId: "commitment-1" }
        : payloadKind === "change"
          ? { kind: "change", changeKey: "began_dating" }
          : { kind: "none" };
  return relationshipLedgerEntrySchema.parse({
    id: overrides.id ?? `entry-${entryCounter}`,
    branchId: BRANCH,
    kind: overrides.kind,
    fromActorId: overrides.fromActorId ?? ACTOR_A,
    toActorId: overrides.toActorId ?? ACTOR_B,
    provenance: "derived",
    payload: overrides.payload ?? defaultPayload,
    ...(overrides.detail === undefined ? {} : { detail: overrides.detail }),
    sourceEventId: overrides.sourceEventId ?? "event-1",
    sequence: overrides.sequence ?? 1,
    storySecond: overrides.storySecond ?? 1_000,
    derivationVersion: socialDerivationVersion,
  });
}

// ---------------------------------------------------------------------------
// deriveRelationshipLedgerEntryId
// ---------------------------------------------------------------------------

describe("deriveRelationshipLedgerEntryId", () => {
  it("is deterministic for the same inputs", () => {
    const first = deriveRelationshipLedgerEntryId("event-1", "promise_made", ACTOR_A, ACTOR_B);
    const second = deriveRelationshipLedgerEntryId("event-1", "promise_made", ACTOR_A, ACTOR_B);
    expect(first).toBe(second);
  });

  it("distinguishes fromActorId — the fix for engagement_ended's 3+ participant fan-out collision", () => {
    const ac = deriveRelationshipLedgerEntryId("event-1", "shared_scene", ACTOR_A, ACTOR_C);
    const bc = deriveRelationshipLedgerEntryId("event-1", "shared_scene", ACTOR_B, ACTOR_C);
    expect(ac).not.toBe(bc);
  });

  it("round-trips through relationshipLedgerEntrySchema for realistic cuid2-length parts", () => {
    const cuidLikeEventId = "cm" + "a".repeat(23); // ~25-char cuid2-shaped id, this codebase's real id shape
    const id = deriveRelationshipLedgerEntryId(cuidLikeEventId, "relationship_change_recorded", ACTOR_A, ACTOR_B);
    // Round-trips through the real branded schema, not just a length check.
    const entry = ledgerEntry({ kind: "relationship_change_recorded", id, sourceEventId: cuidLikeEventId });
    expect(entry.id).toBe(id);
  });

  it("stays within relationshipLedgerEntryIdSchema's 2048-char observation-identity cap even at every component's own declared legal maximum", () => {
    // sourceEventId is itself composeSimulationId("event", [branchId, commandId, suffix]) —
    // each of branchId/commandId is legally up to 256 chars (compactSimulationIdSchema), so a
    // schema-valid (not pathological) sourceEventId can land well past a short cuid2 fixture.
    // eventIdSchema itself allows up to 1024 chars (derivedSimulationIdSchema).
    const maxSourceEventId = "e".repeat(1_024);
    const maxActorId = "a".repeat(256);
    const otherActorId = "b".repeat(256);
    const id = deriveRelationshipLedgerEntryId(maxSourceEventId, "relationship_change_recorded", maxActorId, otherActorId);
    expect(id.length).toBeLessThanOrEqual(2_048);
    // Must not throw — this is what made a stored branch permanently un-forkable (social.ts:136-151, branch-store.ts replay).
    const entry = ledgerEntry({
      kind: "relationship_change_recorded",
      id,
      sourceEventId: maxSourceEventId,
      fromActorId: maxActorId,
      toActorId: otherActorId,
    });
    expect(entry.id).toBe(id);
  });
});

// ---------------------------------------------------------------------------
// deriveRelationshipLedgerEntries — speech-act mapping (§4.2's 10-member table)
// ---------------------------------------------------------------------------

describe("deriveRelationshipLedgerEntries — speech_act_delivered", () => {
  const consentScoped: Record<string, ConsentScopeKey> = {
    boundary_expressed: "closeness",
    permission_granted: "kiss",
    permission_withdrawn: "kiss",
  };
  const mapping: Record<string, RelationshipLedgerKind | null> = {
    promise_offered: "promise_made",
    promise_accepted: "promise_accepted",
    boundary_expressed: "boundary_stated",
    warning_communicated: "warning_given",
    invitation_spoken: "invitation_extended",
    apology_delivered: "apology_offered",
    disclosure_made: "confidence_shared",
    permission_granted: "permission_granted",
    permission_withdrawn: "permission_withdrawn",
    question_asked: null,
  };

  for (const effectType of speechActTypes) {
    const expectedKind = mapping[effectType];
    it(`maps "${effectType}" → ${expectedKind ?? "(no entry)"}`, () => {
      const event = speechActEvent(effectType, { consentScopeKey: consentScoped[effectType] });
      const entries = fold([event]);
      if (expectedKind === null) {
        expect(entries).toHaveLength(0);
      } else {
        expect(entries).toHaveLength(1);
        expect(entries[0]?.kind).toBe(expectedKind);
        expect(entries[0]?.fromActorId).toBe(ACTOR_A);
        expect(entries[0]?.toActorId).toBe(ACTOR_B);
        expect(entries[0]?.provenance).toBe("derived");
        const scopeKey = consentScoped[effectType];
        if (scopeKey) {
          expect(entries[0]?.payload).toEqual({ kind: "consent", scopeKey });
        } else {
          expect(entries[0]?.payload).toEqual({ kind: "none" });
        }
      }
    });
  }

  it("produces one entry per target for a multi-target speech act", () => {
    const event = speechActEvent("apology_delivered", { targetActorIds: [ACTOR_B, ACTOR_C] });
    const entries = fold([event]);
    expect(entries).toHaveLength(2);
    expect(entries.map((entry) => entry.toActorId).sort()).toEqual([ACTOR_B, ACTOR_C].sort());
  });
});

// ---------------------------------------------------------------------------
// deriveRelationshipLedgerEntries — disclosure_made, engagement_ended, and
// the two self-produced event types
// ---------------------------------------------------------------------------

describe("deriveRelationshipLedgerEntries — disclosure_made", () => {
  it("non-retraction disclosures fold to confidence_shared", () => {
    const event = disclosureEvent({
      kind: "claim",
      propositionKey: "is_seeing_someone",
      subjectIds: [ACTOR_A],
      claimedValue: true,
    });
    const entries = fold([event]);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.kind).toBe("confidence_shared");
    expect(entries[0]?.fromActorId).toBe(ACTOR_A);
    expect(entries[0]?.toActorId).toBe(ACTOR_B);
  });

  it("a retraction produces no entry", () => {
    const event = disclosureEvent({ kind: "retraction", assertionId: "assertion-1" });
    expect(fold([event])).toHaveLength(0);
  });

  it("one entry per listener for a multi-target disclosure", () => {
    const event = disclosureEvent(
      { kind: "claim", propositionKey: "works_at", subjectIds: [ACTOR_A], claimedValue: "bakery" },
      { targetActorIds: [ACTOR_B, ACTOR_C] },
    );
    expect(fold([event])).toHaveLength(2);
  });
});

describe("deriveRelationshipLedgerEntries — engagement_ended", () => {
  it("2 participants → 1 pair, 1 entry", () => {
    const entries = fold([engagementEndedEvent([ACTOR_A, ACTOR_B])]);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.kind).toBe("shared_scene");
  });

  it("3 participants → 3 pairs, 3 entries with distinct ids", () => {
    const entries = fold([engagementEndedEvent([ACTOR_A, ACTOR_B, ACTOR_C])]);
    expect(entries).toHaveLength(3);
    expect(new Set(entries.map((entry) => entry.id)).size).toBe(3);
  });

  it("4 participants → 6 pairs, 6 entries with distinct ids", () => {
    const entries = fold([engagementEndedEvent([ACTOR_A, ACTOR_B, ACTOR_C, ACTOR_D])]);
    expect(entries).toHaveLength(6);
    expect(new Set(entries.map((entry) => entry.id)).size).toBe(6);
  });
});

describe("deriveRelationshipLedgerEntries — relationship_entry_authored", () => {
  for (const kind of authoredRelationshipLedgerKinds) {
    if (kind === "boundary_violated") continue; // needs a scopeKey — covered separately below
    if (kind === "authored_prior") continue; // needs a storySecond/weight override — covered separately below
    it(`mirrors "${kind}" verbatim with "none" payload`, () => {
      const entries = fold([relationshipEntryAuthoredEvent(kind)]);
      expect(entries).toHaveLength(1);
      expect(entries[0]?.kind).toBe(kind);
      expect(entries[0]?.provenance).toBe("authored");
      expect(entries[0]?.payload).toEqual({ kind: "none" });
      expect(entries[0]?.detail).toBe("authored detail");
    });
  }

  it('"boundary_violated" carries a consent payload with its scopeKey', () => {
    const entries = fold([relationshipEntryAuthoredEvent("boundary_violated", { scopeKey: "touch_intimate" })]);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.payload).toEqual({ kind: "consent", scopeKey: "touch_intimate" });
  });

  it('"authored_prior" backdates storySecond independent of the causing event', () => {
    const entries = fold([
      relationshipEntryAuthoredEvent("authored_prior", { eventStorySecond: 5_000, entryStorySecond: 100 }),
    ]);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.storySecond).toBe(100);
    expect(entries[0]?.sequence).toBe(1); // sequence is always the causing event's, never backdated
  });
});

describe("deriveRelationshipLedgerEntries — relationship_change_recorded", () => {
  it("mirrors the event with a change payload", () => {
    const entries = fold([relationshipChangeRecordedEvent({ changeKey: "became_partners" })]);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.kind).toBe("relationship_change_recorded");
    expect(entries[0]?.payload).toEqual({ kind: "change", changeKey: "became_partners" });
  });
});

describe("deriveRelationshipLedgerEntries — unrelated event types", () => {
  it("an event type the fold has no arm for produces zero entries", () => {
    expect(fold([unrelatedEvent()])).toHaveLength(0);
  });

  it("folds a mixed stream in sequence order regardless of input order", () => {
    const early = speechActEvent("promise_offered", { sequence: 1, storySecond: 500 });
    const late = speechActEvent("promise_accepted", { sequence: 2, storySecond: 600 });
    const forward = fold([early, late]);
    const reversed = fold([late, early]);
    expect(forward.map((entry) => entry.kind)).toEqual(["promise_made", "promise_accepted"]);
    expect(reversed.map((entry) => entry.kind)).toEqual(["promise_made", "promise_accepted"]);
  });
});

// ---------------------------------------------------------------------------
// relationshipLedgerEntrySchema's payload/kind refine — property check over
// the full relationshipLedgerKindPayloadKind table
// ---------------------------------------------------------------------------

describe("relationshipLedgerEntrySchema — payload/kind agreement", () => {
  const payloadVariants: Record<RelationshipLedgerPayloadInput["kind"], RelationshipLedgerPayloadInput> = {
    none: { kind: "none" },
    consent: { kind: "consent", scopeKey: "kiss" },
    commitment: { kind: "commitment", commitmentId: "commitment-1" },
    change: { kind: "change", changeKey: "began_dating" },
  };

  for (const kind of relationshipLedgerKinds) {
    const declaredVariant = relationshipLedgerKindPayloadKind[kind];
    it(`"${kind}" round-trips with its declared "${declaredVariant}" payload and rejects every other variant`, () => {
      expect(() => ledgerEntry({ kind, payload: payloadVariants[declaredVariant] })).not.toThrow();
      for (const otherVariant of Object.keys(payloadVariants) as RelationshipLedgerPayloadInput["kind"][]) {
        if (otherVariant === declaredVariant) continue;
        expect(() => ledgerEntry({ kind, payload: payloadVariants[otherVariant] })).toThrow();
      }
    });
  }
});

// ---------------------------------------------------------------------------
// resolveConsentCoverage (§21.4)
// ---------------------------------------------------------------------------

describe("resolveConsentCoverage", () => {
  const consentPayload = (scopeKey: ConsentScopeKey): RelationshipLedgerPayloadInput => ({ kind: "consent", scopeKey });

  it("no entries → false", () => {
    expect(
      resolveConsentCoverage({ entries: [], granterActorId: ACTOR_B, granteeActorId: ACTOR_A, scopeKey: "kiss" }),
    ).toBe(false);
  });

  it("boundary_stated only → false", () => {
    const entries = [
      ledgerEntry({ kind: "boundary_stated", fromActorId: ACTOR_B, toActorId: ACTOR_A, payload: consentPayload("kiss"), sequence: 1 }),
    ];
    expect(resolveConsentCoverage({ entries, granterActorId: ACTOR_B, granteeActorId: ACTOR_A, scopeKey: "kiss" })).toBe(
      false,
    );
  });

  it("permission_granted then boundary_stated (in that sequence order) → false — most recent wins", () => {
    const entries = [
      ledgerEntry({ kind: "permission_granted", fromActorId: ACTOR_B, toActorId: ACTOR_A, payload: consentPayload("kiss"), sequence: 1 }),
      ledgerEntry({ kind: "boundary_stated", fromActorId: ACTOR_B, toActorId: ACTOR_A, payload: consentPayload("kiss"), sequence: 2 }),
    ];
    expect(resolveConsentCoverage({ entries, granterActorId: ACTOR_B, granteeActorId: ACTOR_A, scopeKey: "kiss" })).toBe(
      false,
    );
  });

  it("boundary_stated then permission_granted → true", () => {
    const entries = [
      ledgerEntry({ kind: "boundary_stated", fromActorId: ACTOR_B, toActorId: ACTOR_A, payload: consentPayload("kiss"), sequence: 1 }),
      ledgerEntry({ kind: "permission_granted", fromActorId: ACTOR_B, toActorId: ACTOR_A, payload: consentPayload("kiss"), sequence: 2 }),
    ];
    expect(resolveConsentCoverage({ entries, granterActorId: ACTOR_B, granteeActorId: ACTOR_A, scopeKey: "kiss" })).toBe(
      true,
    );
  });

  it("permission_granted then permission_withdrawn → false", () => {
    const entries = [
      ledgerEntry({ kind: "permission_granted", fromActorId: ACTOR_B, toActorId: ACTOR_A, payload: consentPayload("kiss"), sequence: 1 }),
      ledgerEntry({ kind: "permission_withdrawn", fromActorId: ACTOR_B, toActorId: ACTOR_A, payload: consentPayload("kiss"), sequence: 2 }),
    ];
    expect(resolveConsentCoverage({ entries, granterActorId: ACTOR_B, granteeActorId: ACTOR_A, scopeKey: "kiss" })).toBe(
      false,
    );
  });

  it("wrong scopeKey → false — coverage for kiss does not cover sex", () => {
    const entries = [
      ledgerEntry({ kind: "permission_granted", fromActorId: ACTOR_B, toActorId: ACTOR_A, payload: consentPayload("kiss"), sequence: 1 }),
    ];
    expect(resolveConsentCoverage({ entries, granterActorId: ACTOR_B, granteeActorId: ACTOR_A, scopeKey: "sex" })).toBe(
      false,
    );
  });

  it("wrong direction → false", () => {
    const entries = [
      ledgerEntry({ kind: "permission_granted", fromActorId: ACTOR_A, toActorId: ACTOR_B, payload: consentPayload("kiss"), sequence: 1 }),
    ];
    expect(resolveConsentCoverage({ entries, granterActorId: ACTOR_B, granteeActorId: ACTOR_A, scopeKey: "kiss" })).toBe(
      false,
    );
  });
});

// ---------------------------------------------------------------------------
// deriveRelationshipRead — decay law, bands, diagnostics
// ---------------------------------------------------------------------------

describe("deriveRelationshipRead", () => {
  it("zero elapsed time → contribution equals the raw weight", () => {
    const entries = [ledgerEntry({ kind: "promise_kept", storySecond: 1_000 })];
    const read = deriveRelationshipRead({
      entries,
      subjectActorId: ACTOR_B,
      aboutActorId: ACTOR_A,
      atStorySecond: 1_000,
    });
    expect(read.trustFixedPoint).toBe(relationshipLedgerWeightRegistryV1.promise_kept.trustFixedPoint);
    expect(read.entryCount).toBe(1);
  });

  it("aged one full half-life → contribution is exactly half", () => {
    const halfLife = 2_592_000; // trust's half-life
    const entries = [ledgerEntry({ kind: "promise_kept", storySecond: 1_000 })];
    const read = deriveRelationshipRead({
      entries,
      subjectActorId: ACTOR_B,
      aboutActorId: ACTOR_A,
      atStorySecond: 1_000 + halfLife,
    });
    expect(read.trustFixedPoint).toBe(Math.floor(relationshipLedgerWeightRegistryV1.promise_kept.trustFixedPoint / 2));
  });

  it("attraction decays on ITS OWN half-life (10 days), not trust's — a single entry aged exactly one attraction half-life halves only attractionFixedPoint", () => {
    const attractionHalfLife = 864_000;
    // shared_scene carries both a trust and an attraction weight — proves the
    // two axes decay independently under the SAME elapsed time, per their own
    // RELATIONSHIP_AXIS_HALF_LIFE_SECONDS entry, not a shared rate.
    const entries = [ledgerEntry({ kind: "shared_scene", storySecond: 1_000 })];
    const read = deriveRelationshipRead({
      entries,
      subjectActorId: ACTOR_B,
      aboutActorId: ACTOR_A,
      atStorySecond: 1_000 + attractionHalfLife,
    });
    expect(read.attractionFixedPoint).toBe(Math.floor(relationshipLedgerWeightRegistryV1.shared_scene.attractionFixedPoint / 2));
    // Trust, aged the SAME elapsed seconds against its much longer 30-day
    // half-life, has decayed far less than half — proving it's not on
    // attraction's clock.
    expect(read.trustFixedPoint).toBeGreaterThan(Math.floor(relationshipLedgerWeightRegistryV1.shared_scene.trustFixedPoint / 2));
  });

  it("resentment decays on ITS OWN half-life (6 days) — aged one resentment half-life halves the contribution exactly", () => {
    const resentmentHalfLife = 518_400;
    const entries = [ledgerEntry({ kind: "conflict", storySecond: 1_000 })]; // resentment-only weight
    const read = deriveRelationshipRead({
      entries,
      subjectActorId: ACTOR_B,
      aboutActorId: ACTOR_A,
      atStorySecond: 1_000 + resentmentHalfLife,
    });
    expect(read.resentmentFixedPoint).toBe(Math.floor(relationshipLedgerWeightRegistryV1.conflict.resentmentFixedPoint / 2));
  });

  it("an entry with storySecond > atStorySecond contributes zero but still counts", () => {
    const entries = [ledgerEntry({ kind: "promise_kept", storySecond: 5_000 })];
    const read = deriveRelationshipRead({
      entries,
      subjectActorId: ACTOR_B,
      aboutActorId: ACTOR_A,
      atStorySecond: 1_000,
    });
    expect(read.trustFixedPoint).toBe(0);
    expect(read.entryCount).toBe(1);
  });

  it("wrong-direction entries never contribute and are excluded from entryCount", () => {
    const entries = [ledgerEntry({ kind: "promise_kept", fromActorId: ACTOR_B, toActorId: ACTOR_A, storySecond: 1_000 })];
    // Reading "how much B trusts A" wants fromActorId=A,toActorId=B — this entry is reversed.
    const read = deriveRelationshipRead({
      entries,
      subjectActorId: ACTOR_B,
      aboutActorId: ACTOR_A,
      atStorySecond: 1_000,
    });
    expect(read.trustFixedPoint).toBe(0);
    expect(read.entryCount).toBe(0);
  });

  it("relationship_change_recorded contributes to no axis but IS counted", () => {
    const entries = [
      ledgerEntry({ kind: "promise_kept", storySecond: 1_000 }),
      ledgerEntry({ kind: "relationship_change_recorded", storySecond: 1_000 }),
    ];
    const withChange = deriveRelationshipRead({
      entries,
      subjectActorId: ACTOR_B,
      aboutActorId: ACTOR_A,
      atStorySecond: 1_000,
    });
    const withoutChange = deriveRelationshipRead({
      entries: [entries[0]!],
      subjectActorId: ACTOR_B,
      aboutActorId: ACTOR_A,
      atStorySecond: 1_000,
    });
    expect(withChange.trustFixedPoint).toBe(withoutChange.trustFixedPoint);
    expect(withChange.entryCount).toBe(2);
  });

  it("an empty ledger degrades to the zero-sum default read: zero on every axis, entryCount 0, no diagnostics", () => {
    const read = deriveRelationshipRead({
      entries: [],
      subjectActorId: ACTOR_B,
      aboutActorId: ACTOR_A,
      atStorySecond: 1_000,
    });
    expect(read).toMatchObject({
      trustFixedPoint: 0,
      attractionFixedPoint: 0,
      resentmentFixedPoint: 0,
      entryCount: 0,
      diagnostics: [],
    });
    // Zero sits at-or-below every axis's lowest-magnitude threshold band, so
    // the default read lands on the neutral-ish middle band of each — never
    // an extreme (devoted/hostile/etc.) by construction.
    expect(read.trustBand).toBe(trustBandKeys[2]);
    expect(read.attractionBand).toBe(attractionBandKeys[2]);
    expect(read.resentmentBand).toBe(resentmentBandKeys[0]);
  });

  it("band boundaries land exactly on TRUST_BAND_THRESHOLDS with no off-by-one", () => {
    const registryAt = (trust: number) => ({
      ...relationshipLedgerWeightRegistryV1,
      help_given: { trustFixedPoint: trust, attractionFixedPoint: 0, resentmentFixedPoint: 0 },
    });
    for (const threshold of TRUST_BAND_THRESHOLDS) {
      const atThreshold = deriveRelationshipRead({
        entries: [ledgerEntry({ kind: "help_given", storySecond: 1_000 })],
        subjectActorId: ACTOR_B,
        aboutActorId: ACTOR_A,
        atStorySecond: 1_000,
        weightRegistry: registryAt(threshold),
      });
      const aboveThreshold = deriveRelationshipRead({
        entries: [ledgerEntry({ kind: "help_given", storySecond: 1_000 })],
        subjectActorId: ACTOR_B,
        aboutActorId: ACTOR_A,
        atStorySecond: 1_000,
        weightRegistry: registryAt(threshold + 1),
      });
      const indexAt = TRUST_BAND_THRESHOLDS.indexOf(threshold);
      expect(atThreshold.trustBand).toBe(trustBandKeys[indexAt]);
      expect(aboveThreshold.trustBand).toBe(trustBandKeys[indexAt + 1]);
    }
  });

  it("band boundaries land exactly on ATTRACTION_BAND_THRESHOLDS with no off-by-one", () => {
    const registryAt = (attraction: number) => ({
      ...relationshipLedgerWeightRegistryV1,
      help_given: { trustFixedPoint: 0, attractionFixedPoint: attraction, resentmentFixedPoint: 0 },
    });
    for (const threshold of ATTRACTION_BAND_THRESHOLDS) {
      const atThreshold = deriveRelationshipRead({
        entries: [ledgerEntry({ kind: "help_given", storySecond: 1_000 })],
        subjectActorId: ACTOR_B,
        aboutActorId: ACTOR_A,
        atStorySecond: 1_000,
        weightRegistry: registryAt(threshold),
      });
      const aboveThreshold = deriveRelationshipRead({
        entries: [ledgerEntry({ kind: "help_given", storySecond: 1_000 })],
        subjectActorId: ACTOR_B,
        aboutActorId: ACTOR_A,
        atStorySecond: 1_000,
        weightRegistry: registryAt(threshold + 1),
      });
      const indexAt = ATTRACTION_BAND_THRESHOLDS.indexOf(threshold);
      expect(atThreshold.attractionBand).toBe(attractionBandKeys[indexAt]);
      expect(aboveThreshold.attractionBand).toBe(attractionBandKeys[indexAt + 1]);
    }
  });

  it("resentment is a floor/clamp band — a negative sum from apology-heavy history reads as none", () => {
    const entries = [ledgerEntry({ kind: "apology_offered", storySecond: 1_000 })]; // resentmentFixedPoint: -500
    const read = deriveRelationshipRead({
      entries,
      subjectActorId: ACTOR_B,
      aboutActorId: ACTOR_A,
      atStorySecond: 1_000,
    });
    expect(read.resentmentFixedPoint).toBeLessThan(0);
    expect(read.resentmentBand).toBe(resentmentBandKeys[0]);
    expect(read.resentmentBand).toBe("none");
  });

  it("resentment bands at every RESENTMENT_BAND_THRESHOLDS entry exactly, one unit past on each side, no off-by-one", () => {
    const registryAt = (resentment: number) => ({
      ...relationshipLedgerWeightRegistryV1,
      help_given: { trustFixedPoint: 0, attractionFixedPoint: 0, resentmentFixedPoint: resentment },
    });
    for (const threshold of RESENTMENT_BAND_THRESHOLDS) {
      const atThreshold = deriveRelationshipRead({
        entries: [ledgerEntry({ kind: "help_given", storySecond: 1_000 })],
        subjectActorId: ACTOR_B,
        aboutActorId: ACTOR_A,
        atStorySecond: 1_000,
        weightRegistry: registryAt(threshold),
      });
      const aboveThreshold = deriveRelationshipRead({
        entries: [ledgerEntry({ kind: "help_given", storySecond: 1_000 })],
        subjectActorId: ACTOR_B,
        aboutActorId: ACTOR_A,
        atStorySecond: 1_000,
        weightRegistry: registryAt(threshold + 1),
      });
      const indexAt = RESENTMENT_BAND_THRESHOLDS.indexOf(threshold);
      expect(atThreshold.resentmentBand).toBe(resentmentBandKeys[indexAt]);
      expect(aboveThreshold.resentmentBand).toBe(resentmentBandKeys[indexAt + 1]);
    }
  });

  it("an authored_prior entry with a matching override contributes exactly that weight", () => {
    const entry = ledgerEntry({ kind: "authored_prior", storySecond: 1_000, id: "prior-1" });
    const read = deriveRelationshipRead({
      entries: [entry],
      subjectActorId: ACTOR_B,
      aboutActorId: ACTOR_A,
      atStorySecond: 1_000,
      authoredPriorWeights: [
        { entryId: "prior-1", weight: { trustFixedPoint: 777, attractionFixedPoint: 0, resentmentFixedPoint: 0 } },
      ],
    });
    expect(read.trustFixedPoint).toBe(777);
    expect(read.diagnostics).toHaveLength(0);
  });

  it("an authored_prior entry with NO matching override contributes zero and surfaces a diagnostic", () => {
    const entry = ledgerEntry({ kind: "authored_prior", storySecond: 1_000, id: "prior-missing" });
    const read = deriveRelationshipRead({
      entries: [entry],
      subjectActorId: ACTOR_B,
      aboutActorId: ACTOR_A,
      atStorySecond: 1_000,
    });
    expect(read.trustFixedPoint).toBe(0);
    expect(read.diagnostics).toContain("authored_prior_missing_weight:prior-missing");
  });
});

// ---------------------------------------------------------------------------
// Fork/replay parity (§6) — replaySocialLedgerHistory over the full stream
// matches the incremental per-command fold applied sequentially
// ---------------------------------------------------------------------------

describe("replaySocialLedgerHistory — fork/replay parity", () => {
  it("is the identical function as the incremental fold", () => {
    const events = [
      speechActEvent("promise_offered", { sequence: 1, storySecond: 100 }),
      disclosureEvent(
        { kind: "claim", propositionKey: "works_at", subjectIds: [ACTOR_A], claimedValue: "bakery" },
        { sequence: 2, storySecond: 200 },
      ),
      engagementEndedEvent([ACTOR_A, ACTOR_B, ACTOR_C], { sequence: 3, storySecond: 300 }),
    ];

    const fullReplay = replaySocialLedgerHistory({ events, commitmentById: NO_COMMITMENTS });

    // Incremental: fold each command's own new-events slice, as the recorder
    // does per command, then concatenate — ids must match the full replay's.
    const incremental = [
      ...deriveRelationshipLedgerEntries({ events: [events[0]!], commitmentById: NO_COMMITMENTS }),
      ...deriveRelationshipLedgerEntries({ events: [events[1]!], commitmentById: NO_COMMITMENTS }),
      ...deriveRelationshipLedgerEntries({ events: [events[2]!], commitmentById: NO_COMMITMENTS }),
    ];

    expect(fullReplay.map((entry) => entry.id).sort()).toEqual(incremental.map((entry) => entry.id).sort());
    expect(fullReplay).toHaveLength(incremental.length);
  });

  it("reorders a scrambled event slice back into sequence order before folding", () => {
    const early = relationshipEntryAuthoredEvent("help_given", { sequence: 1, eventStorySecond: 100 });
    const late = relationshipChangeRecordedEvent({ sequence: 2, storySecond: 200 });
    const replayed = replaySocialLedgerHistory({ events: [late, early], commitmentById: NO_COMMITMENTS });
    expect(replayed.map((entry) => entry.kind)).toEqual(["help_given", "relationship_change_recorded"]);
  });

  it("partition invariance: folding the stream split into arbitrary multi-event chunks and concatenating matches one full-stream fold", () => {
    const events = [
      speechActEvent("promise_offered", { sequence: 1, storySecond: 100 }),
      speechActEvent("promise_accepted", { sequence: 2, storySecond: 150 }),
      disclosureEvent(
        { kind: "claim", propositionKey: "works_at", subjectIds: [ACTOR_A], claimedValue: "bakery" },
        { sequence: 3, storySecond: 200 },
      ),
      engagementEndedEvent([ACTOR_A, ACTOR_B, ACTOR_C], { sequence: 4, storySecond: 300 }),
      relationshipEntryAuthoredEvent("help_given", { sequence: 5, eventStorySecond: 350 }),
      relationshipChangeRecordedEvent({ sequence: 6, storySecond: 400 }),
    ];

    const fullFold = replaySocialLedgerHistory({ events, commitmentById: NO_COMMITMENTS });

    // Split arbitrarily into a 2-event chunk + a 1-event chunk + a 3-event
    // chunk (a different partitioning than the "every event alone" case
    // above) — the fold is total and stateless, so any partition's union
    // must equal the whole.
    const chunked = [
      ...deriveRelationshipLedgerEntries({ events: events.slice(0, 2), commitmentById: NO_COMMITMENTS }),
      ...deriveRelationshipLedgerEntries({ events: events.slice(2, 3), commitmentById: NO_COMMITMENTS }),
      ...deriveRelationshipLedgerEntries({ events: events.slice(3), commitmentById: NO_COMMITMENTS }),
    ];

    expect(chunked.map((entry) => entry.id).sort()).toEqual(fullFold.map((entry) => entry.id).sort());
    expect(chunked).toHaveLength(fullFold.length);
  });
});
