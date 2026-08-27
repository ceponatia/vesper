import { describe, expect, it } from "vitest";
import { simulationBranchEventSchema } from "../contracts/branching";
import { assertionSchema, beliefSchema } from "../contracts/knowledge";
import {
  authoredLoreSeedSchema,
  memoryDocumentSchema,
  type MemoryDocument,
} from "../contracts/memory";
import { speechActDeliveredEventSchema } from "../contracts/narrative";
import { observationSchema } from "../contracts/perception";
import { softCanonEntrySchema } from "../contracts/soft-canon";
import { eventEnvelope } from "../test-support/sim-envelopes";
import {
  projectAssertionDocument,
  projectAuthoredLoreDocument,
  projectBeliefDocument,
  projectObservationDocument,
  projectSoftCanonDocument,
  projectSpeechActDocument,
  rankMemoryDocuments,
  tokenizeMemoryText,
} from "./memory";

const NOW = 100_000;

function departureEvent() {
  return eventEnvelope(simulationBranchEventSchema, {
    type: "actor_departed",
    idSlug: "departed",
    sequence: 5,
    storySecond: NOW,
    rulesetVersion: "test-v1",
    commandId: "cmd-move",
    actorIds: ["mara"],
    entityIds: ["journey-1"],
    overrides: { locationId: "loc-cafe" },
    payload: { journeyId: "journey-1", fromZoneId: "zone-cafe", linkId: "link-cs", departedAt: NOW },
  });
}

function observation(overrides: Record<string, unknown> = {}) {
  return observationSchema.parse({
    id: "obs-1",
    branchId: "branch-1",
    sourceEventId: "event-departed-5",
    sourceEventSequence: 5,
    witnessActorId: "player",
    storySecond: NOW,
    channel: "sight",
    evidenceClass: "sensory",
    confidenceFixedPoint: 9_000,
    detailTier: 2,
    derivationVersion: "perception-v1",
    ...overrides,
  });
}

function fixtureAssertion(overrides: Record<string, unknown> = {}) {
  return assertionSchema.parse({
    id: "assert-1",
    branchId: "branch-1",
    propositionKey: "quitting_job",
    subjectIds: ["mara"],
    claimedValue: { quitting: true },
    sourceActorId: "mara",
    sourceEventId: "event-disclosure-6",
    sourceEventSequence: 6,
    assertedAt: NOW,
    status: "active",
    derivationVersion: "knowledge-v1",
    ...overrides,
  });
}

function fixtureBelief(overrides: Record<string, unknown> = {}) {
  return beliefSchema.parse({
    id: "belief-1",
    branchId: "branch-1",
    holderActorId: "player",
    assertionId: "assert-1",
    confidenceFixedPoint: 9_000,
    basisObservationIds: [],
    learnedFromActorIds: ["mara"],
    believedFrom: NOW,
    status: "active",
    sourceEventId: "event-disclosure-6",
    sourceEventSequence: 6,
    derivationVersion: "knowledge-v1",
    ...overrides,
  });
}

function fixtureEntry(overrides: Record<string, unknown> = {}) {
  return softCanonEntrySchema.parse({
    id: "canon-nickname",
    branchId: "branch-1",
    key: "nickname_for_player",
    scope: "relationship",
    subjectIds: ["mara", "player"],
    value: "stray",
    confidenceFixedPoint: 9_000,
    firstRecordedAt: NOW,
    lastRecordedAt: NOW,
    validUntil: NOW + 10_000,
    sourceCutIds: ["cut-1"],
    status: "active",
    rulesVersion: "soft-canon-rules-v1",
    derivationVersion: "soft-canon-v1",
    ...overrides,
  });
}

describe("E4.4 document projectors (redaction and eligibility)", () => {
  it("grades observation documents by evidence, and glimpses carry no names", () => {
    const seen = projectObservationDocument(observation(), departureEvent());
    expect(seen).toMatchObject({
      sourceKind: "observation",
      visibility: "actors",
      eligibleActorIds: ["player"],
      epistemicLabel: "observed",
      confidenceFixedPoint: 9_000,
    });
    expect(seen.text).toContain("someone departing");
    expect(seen.text).toContain("mara");

    const glimpsed = projectObservationDocument(observation({ detailTier: 1 }), departureEvent());
    expect(glimpsed.epistemicLabel).toBe("glimpsed");
    expect(glimpsed.text).not.toContain("mara");

    const told = projectObservationDocument(
      observation({ channel: "social", evidenceClass: "reported", detailTier: 3 }),
      departureEvent(),
    );
    expect(told.epistemicLabel).toBe("heard_about");
  });

  it("keeps spoken detail inside the participants' speech-act document", () => {
    const event = eventEnvelope(speechActDeliveredEventSchema, {
      type: "speech_act_delivered",
      idSlug: "speech",
      sequence: 7,
      storySecond: NOW,
      rulesetVersion: "test-v1",
      commandId: "cmd-confirm",
      actorIds: ["mara"],
      entityIds: ["engagement-1", "mara", "player"],
      overrides: { locationId: "loc-cafe" },
      payload: {
        cutId: "cut-1",
        engagementId: "engagement-1",
        effectType: "apology_delivered",
        actorId: "mara",
        targetActorIds: ["player"],
        detail: "Mara apologizes for leaving.",
      },
    });
    const doc = projectSpeechActDocument(event);
    expect(doc).toMatchObject({
      visibility: "actors",
      eligibleActorIds: ["mara", "player"],
      epistemicLabel: "witnessed_speech",
    });
    expect(doc.text).toContain("Mara apologizes for leaving.");
  });

  it("marks belief and assertion documents with relational visibility and supersedence", () => {
    const belief = projectBeliefDocument(fixtureBelief(), fixtureAssertion());
    expect(belief).toMatchObject({
      visibility: "actors",
      eligibleActorIds: ["player"],
      epistemicLabel: "believed",
    });
    expect(belief.supersededAtSecond).toBeUndefined();
    expect(belief.text).toContain("quitting_job");
    expect(belief.text).toContain("heard through mara");

    const rejected = projectBeliefDocument(
      fixtureBelief({ id: "belief-2", status: "rejected", believedUntil: NOW + 50 }),
      fixtureAssertion(),
    );
    expect(rejected.supersededAtSecond).toBe(NOW + 50);

    const assertion = projectAssertionDocument(fixtureAssertion());
    expect(assertion).toMatchObject({ visibility: "belief_holders", eligibleActorIds: [] });
    const contradicted = projectAssertionDocument(
      fixtureAssertion({ status: "contradicted", statusChangedAt: NOW + 20 }),
    );
    expect(contradicted.supersededAtSecond).toBe(NOW + 20);
  });

  it("scopes soft-canon documents: personal stays with subjects, world goes public, promotion never expires", () => {
    const personal = projectSoftCanonDocument(fixtureEntry(), 9);
    expect(personal).toMatchObject({
      visibility: "actors",
      eligibleActorIds: ["mara", "player"],
      validUntilSecond: NOW + 10_000,
    });
    const world = projectSoftCanonDocument(
      fixtureEntry({ id: "canon-rain", key: "rains_often", scope: "world", subjectIds: [] }),
      9,
    );
    expect(world).toMatchObject({ visibility: "public", eligibleActorIds: [] });
    const promoted = projectSoftCanonDocument(fixtureEntry({ status: "promoted" }), 9);
    expect(promoted.validUntilSecond).toBeUndefined();
    const demoted = projectSoftCanonDocument(
      fixtureEntry({ status: "demoted", statusChangedAt: NOW + 5 }),
      9,
    );
    expect(demoted.supersededAtSecond).toBe(NOW + 5);
  });

  it("projects deterministically and seeds lore visible to descendants", () => {
    expect(projectObservationDocument(observation(), departureEvent())).toEqual(
      projectObservationDocument(observation(), departureEvent()),
    );
    const lore = projectAuthoredLoreDocument(
      "branch-1",
      authoredLoreSeedSchema.parse({
        loreId: "lore-cafe-history",
        text: "The cafe has stood on this corner for forty years.",
        visibility: "public",
        eligibleActorIds: [],
        aboutEntityIds: ["loc-cafe"],
        validFromSecond: 0,
      }),
    );
    expect(lore).toMatchObject({ sourceKind: "authored_lore", firstSequence: 0, visibility: "public" });
  });
});

function doc(
  id: string,
  sourceKind: MemoryDocument["sourceKind"],
  text: string,
  storySecond: number,
): MemoryDocument {
  return memoryDocumentSchema.parse({
    id,
    branchId: "branch-1",
    sourceKind,
    sourceId: id,
    firstSequence: 1,
    lastSequence: 1,
    storySecond,
    visibility: "public",
    eligibleActorIds: [],
    aboutEntityIds: [],
    validFromSecond: 0,
    epistemicLabel: "authored_lore",
    text,
    docSchemaVersion: 1,
  });
}

function unitVector(hot: number): number[] {
  const vector = new Array<number>(1_536).fill(0);
  vector[hot] = 1;
  return vector;
}

describe("E4.4 ranking (inside the eligible set only)", () => {
  it("ranks lexically by token overlap with stable ties", () => {
    const { ranked } = rankMemoryDocuments({
      candidates: [
        { doc: doc("doc-b", "authored_lore", "the shop closes early on rainy days", NOW) },
        { doc: doc("doc-a", "authored_lore", "mara is quitting her job at the shop", NOW) },
        { doc: doc("doc-c", "authored_lore", "an unrelated fact", NOW) },
      ],
      queryText: "quitting the job",
      limit: 3,
    });
    expect(ranked[0]?.doc.id).toBe("doc-a");
    expect(tokenizeMemoryText("Quitting, the JOB!")).toEqual(["job", "quitting", "the"]);
  });

  it("ranks by cosine only among same-model embeddings and counts the rest as degraded", () => {
    const embedded = { ...doc("doc-a", "belief", "mara is quitting", NOW), embeddingModel: "stub-v1" };
    const otherModel = { ...doc("doc-b", "belief", "rain later", NOW), embeddingModel: "stub-v2" };
    const bare = doc("doc-c", "belief", "no embedding at all", NOW);
    const { ranked, unembeddedEligible } = rankMemoryDocuments({
      candidates: [
        { doc: embedded, embedding: unitVector(0) },
        { doc: otherModel, embedding: unitVector(0) },
        { doc: bare },
      ],
      queryEmbedding: unitVector(0),
      queryEmbeddingModel: "stub-v1",
      limit: 3,
    });
    expect(ranked.map((item) => item.doc.id)).toEqual(["doc-a"]);
    expect(ranked[0]?.scoreFixedPoint).toBe(10_000);
    expect(unembeddedEligible).toBe(2);
  });

  it("orders by recency without a query and diversifies across source kinds", () => {
    const recency = rankMemoryDocuments({
      candidates: [
        { doc: doc("doc-old", "authored_lore", "old", NOW - 100) },
        { doc: doc("doc-new", "authored_lore", "new", NOW) },
      ],
      limit: 2,
    });
    expect(recency.ranked.map((item) => item.doc.id)).toEqual(["doc-new", "doc-old"]);

    const diversified = rankMemoryDocuments({
      candidates: [
        { doc: doc("doc-s1", "speech_act", "chatter one", NOW) },
        { doc: doc("doc-s2", "speech_act", "chatter two", NOW - 1) },
        { doc: doc("doc-s3", "speech_act", "chatter three", NOW - 2) },
        { doc: doc("doc-b1", "belief", "one belief", NOW - 3) },
      ],
      limit: 2,
    });
    // Round-robin: the budget cannot be crowded out by one chatty kind.
    expect(diversified.ranked.map((item) => item.doc.sourceKind).sort()).toEqual([
      "belief",
      "speech_act",
    ]);
  });
});
