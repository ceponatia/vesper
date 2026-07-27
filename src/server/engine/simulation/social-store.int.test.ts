import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { materialBranchSeedSchema, type MaterialBranchSeed } from "@/contracts/simulation/materials";
import { proposedArmedEffectSchema, type ProposedArmedEffect } from "@/contracts/simulation/narrative";
import {
  recordRelationshipChangeCommandSchema,
  recordRelationshipEntryCommandSchema,
  relationshipLedgerWeightRegistryV1,
  type RecordRelationshipChangeCommand,
  type RecordRelationshipEntryCommand,
} from "@/contracts/simulation/social";
import { newId } from "@/lib/ids";
import {
  deriveCommitmentId,
  deriveEngagementId,
  deriveRelationshipRead,
  replaySocialLedgerHistory,
  simulationHash,
} from "@/lib/simulation";
import { db, simBranches, simEvents, simRelationshipLedger, simTemporalPressures, simWorlds } from "@/server/db";
import { seedDurableActionDefinitions, submitDurableStartActivity } from "./activity-store";
import { prepareEngagementTurn, submitDurableConfirmNarratorResult } from "./arbiter-store";
import { forkBranch } from "./branch-store";
import { submitDurableCreateCommitment, submitDurableFulfillCommitment } from "./commitment-store";
import { submitDurableAcknowledgePressure, submitDurableOpenEngagement } from "./engagement-store";
import { InjectedSimulationCrash, seedDurableMaterialBranch } from "./material-store";
import { branchEventFromRow } from "./observation-store";
import { advanceBranchStoryTime } from "./scheduler-store";
import { loadRelationshipLedgerProjection } from "./social-recorder";
import {
  submitDurableAttemptConsentEscalation,
  submitDurableRecordRelationshipChange,
  submitDurableRecordRelationshipEntry,
} from "./social-store";
import { seedDurableSpaceTopology } from "./space-store";
import { requireLegacyUnanchoredEngineTestMode } from "@/server/test-support";

/**
 * E5.5 slice 1 durable relationship-ledger substrate (engine.spec §21.3):
 * `record_relationship_entry`/`record_relationship_change` end to end,
 * speech-act/disclosure-derived entries landing through the recorder on REAL
 * `confirm_narrator_result` commands (mirrors narrative-store.int.test.ts's
 * harness), fork-mid-ledger parity, crash-injection atomicity, and
 * rebuild-from-zero hash parity. Mirrors household-store.int.test.ts's shape:
 * a single `describe.runIf(ready)` block, `afterAll` teardown of every
 * seeded world.
 */

async function probe(): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      db().execute(sql`select 1 from sim_relationship_ledger limit 1`),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("connect timeout")), 4_000);
      }),
    ]);
    return true;
  } catch (error) {
    if (process.env.CI === "true" || process.env.VESPER_REQUIRE_TEST_DB === "1") {
      throw error;
    }
    process.stderr.write(
      `[social-store.int.test] skipping: database unreachable or unmigrated: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
    return false;
  } finally {
    clearTimeout(timer);
  }
}

const ready = await probe();
if (ready) requireLegacyUnanchoredEngineTestMode("social-store.int.test");
const seededWorldIds: string[] = [];

afterAll(async () => {
  if (!ready || seededWorldIds.length === 0) return;
  await db().delete(simWorlds).where(inArray(simWorlds.id, seededWorldIds));
});

const SEED_SECOND = 200_000;

interface SocialCase {
  worldId: string;
  branchId: string;
  locationId: string;
  zoneId: string;
  ana: string;
  ben: string;
  cy: string;
}

function branchSeed(ids: SocialCase): MaterialBranchSeed {
  return materialBranchSeedSchema.parse({
    worldId: ids.worldId,
    worldTypeId: "e5-5-test-world",
    worldSeed: `seed-${ids.worldId}`,
    branchId: ids.branchId,
    rulesetVersion: "e5-5-test-v1",
    originStorySecond: SEED_SECOND,
    actors: [
      { id: ids.ana, name: "Ana" },
      { id: ids.ben, name: "Ben" },
      { id: ids.cy, name: "Cy" },
    ],
    items: [],
  });
}

async function seedCase(): Promise<SocialCase> {
  const worldId = newId();
  const branchId = newId();
  const ids: SocialCase = {
    worldId,
    branchId,
    locationId: `${worldId}-loc-cafe`,
    zoneId: `${branchId}-zone-cafe`,
    ana: newId(),
    ben: newId(),
    cy: newId(),
  };
  seededWorldIds.push(worldId);
  await seedDurableMaterialBranch(branchSeed(ids));
  await seedDurableSpaceTopology({
    branchId,
    locations: [{ id: ids.locationId, worldId, kind: "cafe", defaultAccessPolicy: "public" }],
    zones: [{ id: ids.zoneId, locationId: ids.locationId, kind: "cafe", privacyPolicy: "public" }],
    links: [],
    loci: [
      { kind: "at", actorId: ids.ana, locationId: ids.locationId, zoneId: ids.zoneId, since: SEED_SECOND },
      { kind: "at", actorId: ids.ben, locationId: ids.locationId, zoneId: ids.zoneId, since: SEED_SECOND },
      { kind: "at", actorId: ids.cy, locationId: ids.locationId, zoneId: ids.zoneId, since: SEED_SECOND },
    ],
  });
  return ids;
}

const gmPrincipal = { kind: "storyteller" as const, principalId: "gm-1", controlledActorIds: [] };
const playerPrincipal = (actorId: string) => ({ kind: "player" as const, principalId: "player-1", controlledActorIds: [actorId] });

function recordEntryCmd(input: {
  branchId: string;
  fromActorId: string;
  toActorId: string;
  kind: string;
  detail?: string;
  storySecond?: number;
  weightOverride?: { trustFixedPoint: number; attractionFixedPoint: number; resentmentFixedPoint: number };
  scopeKey?: string;
  expectedVersion: number;
  principal?: { kind: string; principalId: string; controlledActorIds: string[] };
  id?: string;
  idempotencyKey?: string;
}): RecordRelationshipEntryCommand {
  return recordRelationshipEntryCommandSchema.parse({
    id: input.id ?? newId(),
    branchId: input.branchId,
    expectedVersion: input.expectedVersion,
    idempotencyKey: input.idempotencyKey ?? newId(),
    principal: input.principal ?? gmPrincipal,
    submittedAtWallClock: "2026-07-20T12:00:00.000Z",
    correlationId: newId(),
    type: "record_relationship_entry",
    schemaVersion: 1,
    payload: {
      fromActorId: input.fromActorId,
      toActorId: input.toActorId,
      kind: input.kind,
      detail: input.detail ?? "authored via the storyteller",
      ...(input.storySecond === undefined ? {} : { storySecond: input.storySecond }),
      ...(input.weightOverride === undefined ? {} : { weightOverride: input.weightOverride }),
      ...(input.scopeKey === undefined ? {} : { scopeKey: input.scopeKey }),
    },
  });
}

function recordChangeCmd(input: {
  branchId: string;
  fromActorId: string;
  toActorId: string;
  changeKey: string;
  detail?: string;
  expectedVersion: number;
  id?: string;
  idempotencyKey?: string;
}): RecordRelationshipChangeCommand {
  return recordRelationshipChangeCommandSchema.parse({
    id: input.id ?? newId(),
    branchId: input.branchId,
    expectedVersion: input.expectedVersion,
    idempotencyKey: input.idempotencyKey ?? newId(),
    principal: gmPrincipal,
    submittedAtWallClock: "2026-07-20T12:00:00.000Z",
    correlationId: newId(),
    type: "record_relationship_change",
    schemaVersion: 1,
    payload: { fromActorId: input.fromActorId, toActorId: input.toActorId, changeKey: input.changeKey, detail: input.detail ?? "a change" },
  });
}

/** Bridges an unbranded literal into `ProposedArmedEffect` via the real
 * schema — validates AND brands in one step, mirroring households.test.ts's
 * `*CommandInput` idiom for the same unbranded-literal-into-`.parse()` shape. */
function armedEffect(input: Record<string, unknown>): ProposedArmedEffect {
  return proposedArmedEffectSchema.parse(input);
}

async function ledgerRows(branchId: string) {
  return db()
    .select()
    .from(simRelationshipLedger)
    .where(eq(simRelationshipLedger.branchId, branchId))
    .orderBy(asc(simRelationshipLedger.entryId));
}

describe.runIf(ready)("E5.5 slice 1 durable relationship-ledger substrate", () => {
  it("records both authoring commands end to end: row shapes, authored_prior's backdated storySecond, and boundary_violated's scopeKey", async () => {
    const ids = await seedCase();

    const helpGiven = await submitDurableRecordRelationshipEntry(
      recordEntryCmd({ branchId: ids.branchId, fromActorId: ids.ana, toActorId: ids.ben, kind: "help_given", expectedVersion: 0 }),
    );
    expect(helpGiven.status).toBe("accepted");

    const boundaryViolated = await submitDurableRecordRelationshipEntry(
      recordEntryCmd({
        branchId: ids.branchId,
        fromActorId: ids.ben,
        toActorId: ids.ana,
        kind: "boundary_violated",
        scopeKey: "kiss",
        expectedVersion: 1,
      }),
    );
    expect(boundaryViolated.status).toBe("accepted");

    const authoredPrior = await submitDurableRecordRelationshipEntry(
      recordEntryCmd({
        branchId: ids.branchId,
        fromActorId: ids.cy,
        toActorId: ids.ana,
        kind: "authored_prior",
        storySecond: SEED_SECOND - 5_000, // predates the branch's live story second
        weightOverride: { trustFixedPoint: 900, attractionFixedPoint: 0, resentmentFixedPoint: 0 },
        expectedVersion: 2,
      }),
    );
    expect(authoredPrior.status).toBe("accepted");

    const change = await submitDurableRecordRelationshipChange(
      recordChangeCmd({ branchId: ids.branchId, fromActorId: ids.ana, toActorId: ids.ben, changeKey: "became_lovers", expectedVersion: 3 }),
    );
    expect(change.status).toBe("accepted");

    const projection = await loadRelationshipLedgerProjection(ids.branchId);
    expect(projection).toHaveLength(4);

    const help = projection.find((entry) => entry.kind === "help_given");
    expect(help).toMatchObject({ fromActorId: ids.ana, toActorId: ids.ben, provenance: "authored", payload: { kind: "none" } });

    const violated = projection.find((entry) => entry.kind === "boundary_violated");
    expect(violated).toMatchObject({ payload: { kind: "consent", scopeKey: "kiss" } });

    const prior = projection.find((entry) => entry.kind === "authored_prior");
    expect(prior?.storySecond).toBe(SEED_SECOND - 5_000);
    // The weightOverride affects only the later READ, never the persisted row.
    expect(prior?.payload).toEqual({ kind: "none" });

    const changeRow = projection.find((entry) => entry.kind === "relationship_change_recorded");
    expect(changeRow).toMatchObject({ payload: { kind: "change", changeKey: "became_lovers" } });
  });

  it("rejects a non-storyteller/system principal as unauthorized_principal, and an unknown actor as actor_not_found", async () => {
    const ids = await seedCase();

    const unauthorized = await submitDurableRecordRelationshipEntry(
      recordEntryCmd({
        branchId: ids.branchId,
        fromActorId: ids.ana,
        toActorId: ids.ben,
        kind: "help_given",
        expectedVersion: 0,
        principal: playerPrincipal(ids.ana),
      }),
    );
    expect(unauthorized).toMatchObject({ status: "rejected", code: "unauthorized_principal" });

    const unknownActor = await submitDurableRecordRelationshipEntry(
      recordEntryCmd({ branchId: ids.branchId, fromActorId: ids.ana, toActorId: "actor-does-not-exist", kind: "help_given", expectedVersion: 0 }),
    );
    expect(unknownActor).toMatchObject({ status: "rejected", code: "actor_not_found" });

    // Neither rejection wrote a ledger row.
    expect(await loadRelationshipLedgerProjection(ids.branchId)).toHaveLength(0);
  });

  it("is idempotent: resubmitting the identical command (same id + idempotencyKey) never double-writes a ledger row", async () => {
    const ids = await seedCase();
    const command = recordEntryCmd({ branchId: ids.branchId, fromActorId: ids.ana, toActorId: ids.ben, kind: "help_given", expectedVersion: 0 });

    const first = await submitDurableRecordRelationshipEntry(command);
    expect(first.status).toBe("accepted");
    const second = await submitDurableRecordRelationshipEntry(command);
    expect(second).toEqual(first);

    const projection = await loadRelationshipLedgerProjection(ids.branchId);
    expect(projection).toHaveLength(1);
  });

  it("recovers atomically from an injected crash at each checkpoint, retrying the SAME idempotency key to exactly one ledger row", async () => {
    const crashPoints = ["after_event_append", "after_branch_advance"] as const;
    for (const crashAt of crashPoints) {
      const ids = await seedCase();
      const command = recordEntryCmd({ branchId: ids.branchId, fromActorId: ids.ana, toActorId: ids.ben, kind: "help_given", expectedVersion: 0 });

      let threw: unknown;
      try {
        await submitDurableRecordRelationshipEntry(command, { crashAt });
      } catch (error) {
        threw = error;
      }
      expect(threw).toBeInstanceOf(InjectedSimulationCrash);
      expect(await loadRelationshipLedgerProjection(ids.branchId)).toHaveLength(0);

      const retry = await submitDurableRecordRelationshipEntry(command);
      expect(retry.status).toBe("accepted");
      expect(await loadRelationshipLedgerProjection(ids.branchId)).toHaveLength(1);
    }
  });

  it("derives boundary_stated (with its consentScopeKey) and confidence_shared entries from a REAL confirm_narrator_result, in the same transaction as the speech-act/disclosure events", async () => {
    const ids = await seedCase();

    const opened = await submitDurableOpenEngagement(
      {
        id: `cmd-open-${ids.branchId}`,
        branchId: ids.branchId,
        expectedVersion: 0,
        idempotencyKey: `open-key-${ids.branchId}`,
        principal: playerPrincipal(ids.ana),
        submittedAtWallClock: "2026-07-20T12:00:00.000Z",
        correlationId: newId(),
        type: "open_engagement",
        schemaVersion: 1,
        payload: { participantIds: [ids.ana, ids.ben].sort(), channel: "co_present" },
      },
      { admitAtLockedVersion: true },
    );
    expect(opened.status).toBe("accepted");
    const engagementId = deriveEngagementId(ids.branchId, `cmd-open-${ids.branchId}`);

    const turn = await prepareEngagementTurn({
      branchId: ids.branchId,
      engagementId,
      viewpointActorId: ids.ana,
      spanSeconds: 300,
      horizonSeconds: 900,
      workerId: "w-e5-5",
      proposedArmedEffects: [
        armedEffect({
          effectType: "boundary_expressed",
          actorId: ids.ben,
          targetActorIds: [ids.ana],
          detail: "Ben says he's fine with kissing but nothing further.",
          consentScopeKey: "kiss",
        }),
        armedEffect({
          effectType: "disclosure_made",
          actorId: ids.ana,
          targetActorIds: [ids.ben],
          detail: "Ana admits she's nervous.",
          disclosureContent: { kind: "claim", propositionKey: "is_nervous", subjectIds: [ids.ana], claimedValue: true },
        }),
      ],
    });
    expect(turn.cut.armedEffects).toHaveLength(2);

    const confirmed = await submitDurableConfirmNarratorResult(
      {
        id: `cmd-confirm-${ids.branchId}`,
        branchId: ids.branchId,
        expectedVersion: 0,
        idempotencyKey: `confirm-key-${ids.branchId}`,
        principal: { kind: "system", principalId: "system-1", controlledActorIds: [] },
        submittedAtWallClock: "2026-07-20T12:00:00.000Z",
        correlationId: newId(),
        type: "confirm_narrator_result",
        schemaVersion: 2,
        payload: {
          engagementId,
          cutId: turn.cut.id,
          enactedArmedEffectIds: turn.cut.armedEffects.map((effect) => effect.id),
          softCanonProposals: [],
        },
      },
      { admitAtLockedVersion: true },
    );
    expect(confirmed.status).toBe("accepted");

    const projection = await loadRelationshipLedgerProjection(ids.branchId);
    const boundary = projection.find((entry) => entry.kind === "boundary_stated");
    expect(boundary).toMatchObject({
      fromActorId: ids.ben,
      toActorId: ids.ana,
      provenance: "derived",
      payload: { kind: "consent", scopeKey: "kiss" },
    });
    const confidence = projection.find((entry) => entry.kind === "confidence_shared");
    expect(confidence).toMatchObject({ fromActorId: ids.ana, toActorId: ids.ben, provenance: "derived" });
  });

  it("forks mid-ledger: the child's ledger rows exactly match a replaySocialLedgerHistory rebuild over the inherited stream, and a diverged child never touches the parent", async () => {
    const ids = await seedCase();
    await submitDurableRecordRelationshipEntry(
      recordEntryCmd({ branchId: ids.branchId, fromActorId: ids.ana, toActorId: ids.ben, kind: "help_given", expectedVersion: 0 }),
    );
    await submitDurableRecordRelationshipEntry(
      recordEntryCmd({
        branchId: ids.branchId,
        fromActorId: ids.ben,
        toActorId: ids.cy,
        kind: "affection_shown",
        expectedVersion: 1,
      }),
    );
    await submitDurableRecordRelationshipChange(
      recordChangeCmd({ branchId: ids.branchId, fromActorId: ids.ana, toActorId: ids.ben, changeKey: "became_lovers", expectedVersion: 2 }),
    );

    const [parentBranchRow] = await db().select().from(simBranches).where(eq(simBranches.id, ids.branchId));
    if (!parentBranchRow) throw new Error("parent branch row missing");

    const childBranchId = newId();
    await forkBranch({
      parentBranchId: ids.branchId,
      childBranchId,
      atSequence: parentBranchRow.headSequence,
      principal: { kind: "storyteller", principalId: "gm-1" },
      reason: "E5.5 slice 1 fork parity",
    });

    const parentEventRows = await db()
      .select()
      .from(simEvents)
      .where(eq(simEvents.branchId, ids.branchId))
      .orderBy(asc(simEvents.sequence));
    const parentEvents = parentEventRows.map(branchEventFromRow);

    const expected = replaySocialLedgerHistory({ events: parentEvents, commitmentById: () => undefined });
    const childProjection = await loadRelationshipLedgerProjection(childBranchId);

    // Entries are stamped with the branch they live IN (insertReplayedSocialLedger
    // targets the child branch id), not the source event's branch — normalize
    // before comparing, the same way E5.4's household fork-parity test compares
    // against a seed built with the CHILD's branch id, not the parent's.
    const byId = (entries: typeof expected) =>
      [...entries].map((entry) => ({ ...entry, branchId: childBranchId })).sort((a, b) => a.id.localeCompare(b.id));
    expect(simulationHash(byId(childProjection))).toBe(simulationHash(byId(expected)));

    // Diverge the CHILD only.
    const [childBranchRow] = await db().select().from(simBranches).where(eq(simBranches.id, childBranchId));
    if (!childBranchRow) throw new Error("child branch row missing");
    const diverge = await submitDurableRecordRelationshipEntry(
      recordEntryCmd({
        branchId: childBranchId,
        fromActorId: ids.cy,
        toActorId: ids.ana,
        kind: "conflict",
        expectedVersion: childBranchRow.version,
      }),
    );
    expect(diverge.status).toBe("accepted");

    const childAfter = await loadRelationshipLedgerProjection(childBranchId);
    const parentAfter = await loadRelationshipLedgerProjection(ids.branchId);
    expect(childAfter.some((entry) => entry.kind === "conflict")).toBe(true);
    expect(parentAfter.some((entry) => entry.kind === "conflict")).toBe(false);
  });

  it("rebuilds the ledger projection from zero to the live hash across authored entries, changes, and speech-act-derived entries together", async () => {
    const ids = await seedCase();
    await submitDurableRecordRelationshipEntry(
      recordEntryCmd({ branchId: ids.branchId, fromActorId: ids.ana, toActorId: ids.ben, kind: "help_given", expectedVersion: 0 }),
    );
    await submitDurableRecordRelationshipChange(
      recordChangeCmd({ branchId: ids.branchId, fromActorId: ids.ana, toActorId: ids.ben, changeKey: "became_lovers", expectedVersion: 1 }),
    );

    const opened = await submitDurableOpenEngagement(
      {
        id: `cmd-open2-${ids.branchId}`,
        branchId: ids.branchId,
        expectedVersion: 2,
        idempotencyKey: `open2-key-${ids.branchId}`,
        principal: playerPrincipal(ids.ana),
        submittedAtWallClock: "2026-07-20T12:00:00.000Z",
        correlationId: newId(),
        type: "open_engagement",
        schemaVersion: 1,
        payload: { participantIds: [ids.ana, ids.ben].sort(), channel: "co_present" },
      },
      { admitAtLockedVersion: true },
    );
    expect(opened.status).toBe("accepted");
    const engagementId = deriveEngagementId(ids.branchId, `cmd-open2-${ids.branchId}`);
    const turn = await prepareEngagementTurn({
      branchId: ids.branchId,
      engagementId,
      viewpointActorId: ids.ana,
      spanSeconds: 300,
      horizonSeconds: 900,
      workerId: "w-e5-5-hash",
      proposedArmedEffects: [
        armedEffect({ effectType: "apology_delivered", actorId: ids.ben, targetActorIds: [ids.ana], detail: "Ben apologizes." }),
      ],
    });
    await submitDurableConfirmNarratorResult(
      {
        id: `cmd-confirm2-${ids.branchId}`,
        branchId: ids.branchId,
        expectedVersion: 0,
        idempotencyKey: `confirm2-key-${ids.branchId}`,
        principal: { kind: "system", principalId: "system-1", controlledActorIds: [] },
        submittedAtWallClock: "2026-07-20T12:00:00.000Z",
        correlationId: newId(),
        type: "confirm_narrator_result",
        schemaVersion: 2,
        payload: {
          engagementId,
          cutId: turn.cut.id,
          enactedArmedEffectIds: turn.cut.armedEffects.map((effect) => effect.id),
          softCanonProposals: [],
        },
      },
      { admitAtLockedVersion: true },
    );

    const eventRows = await db().select().from(simEvents).where(eq(simEvents.branchId, ids.branchId)).orderBy(asc(simEvents.sequence));
    const events = eventRows.map(branchEventFromRow);
    const rebuilt = replaySocialLedgerHistory({ events, commitmentById: () => undefined });

    const live = await ledgerRows(ids.branchId);
    expect(live.length).toBe(rebuilt.length);
    expect(live.length).toBeGreaterThanOrEqual(3); // help_given + relationship_change_recorded + apology_offered

    const liveProjection = await loadRelationshipLedgerProjection(ids.branchId);
    const byId = (entries: typeof rebuilt) => [...entries].sort((a, b) => a.id.localeCompare(b.id));
    expect(simulationHash(byId(liveProjection))).toBe(simulationHash(byId(rebuilt)));
  });
});

// ---------------------------------------------------------------------------
// E5.5 slice 2 — the consent gate, destinationless commitments, and repair
// chains, wired end to end through the durable stores. Mirrors slice 1's
// harness shape above: one describe.runIf(ready) block, cross-domain command
// sequences, ledger assertions against the SAME transaction a command wrote.
// ---------------------------------------------------------------------------

describe.runIf(ready)("E5.5 slice 2 durable consent gate, destinationless commitments, and repair chains", () => {
  it("consent_covered blocks a start until a permission_granted speech act covers it, captures consentGrant, records boundary_respected, and a withdrawal blocks it again (most-recent-wins)", async () => {
    const ids = await seedCase();
    const kissActionId = `${ids.branchId}-action-kiss`;
    await seedDurableActionDefinitions({
      branchId: ids.branchId,
      definitions: [
        {
          id: kissActionId,
          version: 1,
          controllerKinds: ["player", "npc_policy"],
          duration: { kind: "fixed", seconds: 60 },
          preconditions: [{ kind: "consent_covered", scopeKey: "kiss" }],
          requiredClaims: [],
          interruptibility: "pausable",
          noticeability: "obvious",
        },
      ],
    });

    const startKiss = (suffix: string) =>
      submitDurableStartActivity(
        {
          id: `cmd-${suffix}-${ids.branchId}`,
          branchId: ids.branchId,
          expectedVersion: 0,
          idempotencyKey: `${suffix}-key-${ids.branchId}`,
          principal: playerPrincipal(ids.ana),
          submittedAtWallClock: "2026-07-20T12:00:00.000Z",
          correlationId: newId(),
          type: "start_activity",
          schemaVersion: 1,
          payload: { actionDefinitionId: kissActionId, actorId: ids.ana, targetActorId: ids.ben },
        },
        { admitAtLockedVersion: true },
      );

    const beforeConsent = await startKiss("kiss-before");
    expect(beforeConsent).toMatchObject({ status: "rejected", code: "consent_required" });

    // A single open engagement hosts both exchanges below — opening a SECOND
    // engagement between the same two participants would reject
    // participant_already_engaged, since the first is never closed.
    const opened = await submitDurableOpenEngagement(
      {
        id: `cmd-open-consent-${ids.branchId}`,
        branchId: ids.branchId,
        expectedVersion: 0,
        idempotencyKey: `open-consent-key-${ids.branchId}`,
        principal: playerPrincipal(ids.ben),
        submittedAtWallClock: "2026-07-20T12:00:00.000Z",
        correlationId: newId(),
        type: "open_engagement",
        schemaVersion: 1,
        payload: { participantIds: [ids.ana, ids.ben].sort(), channel: "co_present" },
      },
      { admitAtLockedVersion: true },
    );
    expect(opened.status).toBe("accepted");
    const engagementId = deriveEngagementId(ids.branchId, `cmd-open-consent-${ids.branchId}`);

    async function speakConsent(effectType: "permission_granted" | "permission_withdrawn", suffix: string) {
      const turn = await prepareEngagementTurn({
        branchId: ids.branchId,
        engagementId,
        viewpointActorId: ids.ben,
        spanSeconds: 300,
        horizonSeconds: 900,
        workerId: `w-${suffix}`,
        proposedArmedEffects: [
          armedEffect({
            effectType,
            actorId: ids.ben,
            targetActorIds: [ids.ana],
            detail: `Ben ${effectType === "permission_granted" ? "consents to" : "withdraws consent for"} a kiss.`,
            consentScopeKey: "kiss",
          }),
        ],
      });
      const confirmed = await submitDurableConfirmNarratorResult(
        {
          id: `cmd-confirm-${suffix}-${ids.branchId}`,
          branchId: ids.branchId,
          expectedVersion: 0,
          idempotencyKey: `confirm-${suffix}-key-${ids.branchId}`,
          principal: { kind: "system", principalId: "system-1", controlledActorIds: [] },
          submittedAtWallClock: "2026-07-20T12:00:00.000Z",
          correlationId: newId(),
          type: "confirm_narrator_result",
          schemaVersion: 2,
          payload: {
            engagementId,
            cutId: turn.cut.id,
            enactedArmedEffectIds: turn.cut.armedEffects.map((effect) => effect.id),
            softCanonProposals: [],
          },
        },
        { admitAtLockedVersion: true },
      );
      expect(confirmed.status).toBe("accepted");
    }

    await speakConsent("permission_granted", "grant");
    const afterGrant = await startKiss("kiss-after-grant");
    expect(afterGrant.status).toBe("accepted");
    if (afterGrant.status !== "accepted") return;
    const [startedRow] = await db()
      .select()
      .from(simEvents)
      .where(and(eq(simEvents.branchId, ids.branchId), eq(simEvents.type, "activity_started")))
      .orderBy(asc(simEvents.sequence));
    expect(startedRow?.payload).toMatchObject({
      consentGrant: { granterActorId: ids.ben, granteeActorId: ids.ana, scopeKey: "kiss" },
    });

    const projectionAfterGrant = await loadRelationshipLedgerProjection(ids.branchId);
    expect(
      projectionAfterGrant.some(
        (entry) => entry.kind === "boundary_respected" && entry.fromActorId === ids.ben && entry.toActorId === ids.ana,
      ),
    ).toBe(true);

    await speakConsent("permission_withdrawn", "withdraw");
    const afterWithdraw = await startKiss("kiss-after-withdraw");
    expect(afterWithdraw).toMatchObject({ status: "rejected", code: "consent_required" });
  });

  it("fulfill_commitment on a destinationless promise records commitment_kept AND a promise_kept ledger row in the same transaction, moving trust", async () => {
    const ids = await seedCase();
    const create = await submitDurableCreateCommitment(
      {
        id: `cmd-promise-${ids.branchId}`,
        branchId: ids.branchId,
        expectedVersion: 0,
        idempotencyKey: `promise-key-${ids.branchId}`,
        principal: playerPrincipal(ids.ana),
        submittedAtWallClock: "2026-07-20T12:00:00.000Z",
        correlationId: newId(),
        type: "create_commitment",
        schemaVersion: 1,
        payload: {
          actorId: ids.ana,
          kind: "promise",
          promisedToActorId: ids.ben,
          window: { latestArrival: SEED_SECOND + 2_000 },
          priority: 0,
          flexibility: "soft",
          preparationSeconds: 0,
          reliabilityBufferSeconds: 0,
          noticeLeadSeconds: 0,
          knowledgeSource: { kind: "authored" },
        },
      },
      { admitAtLockedVersion: true },
    );
    expect(create.status).toBe("accepted");
    const commitmentId = deriveCommitmentId(ids.branchId, `cmd-promise-${ids.branchId}`);

    const fulfilled = await submitDurableFulfillCommitment(
      {
        id: `cmd-fulfill-${ids.branchId}`,
        branchId: ids.branchId,
        expectedVersion: 0,
        idempotencyKey: `fulfill-key-${ids.branchId}`,
        principal: playerPrincipal(ids.ana),
        submittedAtWallClock: "2026-07-20T12:05:00.000Z",
        correlationId: newId(),
        type: "fulfill_commitment",
        schemaVersion: 1,
        payload: { commitmentId },
      },
      { admitAtLockedVersion: true },
    );
    expect(fulfilled.status).toBe("accepted");

    const projection = await loadRelationshipLedgerProjection(ids.branchId);
    const kept = projection.find((entry) => entry.kind === "promise_kept");
    expect(kept).toMatchObject({
      fromActorId: ids.ana,
      toActorId: ids.ben,
      payload: { kind: "commitment", commitmentId },
    });

    // Trust movement: Ben's read of Ana rises by exactly the promise_kept registry weight.
    if (!kept) throw new Error("expected a promise_kept ledger entry");
    const read = deriveRelationshipRead({
      entries: [kept],
      subjectActorId: ids.ben,
      aboutActorId: ids.ana,
      atStorySecond: kept.storySecond,
    });
    expect(read.trustFixedPoint).toBe(relationshipLedgerWeightRegistryV1.promise_kept.trustFixedPoint);
    expect(read.trustFixedPoint).toBeGreaterThan(0);
  });

  it("a repair chain end to end: A misses, B repairs it → a promise_repaired ledger row lands alongside B's creation", async () => {
    const ids = await seedCase();
    const promiseCommand = (suffix: string, expectedVersion: number, payloadOverrides: Record<string, unknown> = {}) => ({
      id: `cmd-${suffix}-${ids.branchId}`,
      branchId: ids.branchId,
      expectedVersion,
      idempotencyKey: `${suffix}-key-${ids.branchId}`,
      principal: playerPrincipal(ids.ana),
      submittedAtWallClock: "2026-07-20T12:00:00.000Z",
      correlationId: newId(),
      type: "create_commitment",
      schemaVersion: 1,
      payload: {
        actorId: ids.ana,
        kind: "promise",
        promisedToActorId: ids.ben,
        window: { latestArrival: SEED_SECOND + 100 },
        priority: 0,
        flexibility: "soft",
        preparationSeconds: 0,
        reliabilityBufferSeconds: 0,
        noticeLeadSeconds: 0,
        knowledgeSource: { kind: "authored" },
        ...payloadOverrides,
      },
    });

    const createA = await submitDurableCreateCommitment(promiseCommand("promise-a", 0), { admitAtLockedVersion: true });
    expect(createA.status).toBe("accepted");
    const commitmentAId = deriveCommitmentId(ids.branchId, `cmd-promise-a-${ids.branchId}`);

    const missResult = await advanceBranchStoryTime(ids.branchId, SEED_SECOND + 200, { workerId: "w-repair-miss" });
    expect(missResult.status).toBe("advanced");

    const createB = await submitDurableCreateCommitment(
      promiseCommand("promise-b", 0, {
        repairsCommitmentId: commitmentAId,
        window: { latestArrival: SEED_SECOND + 2_000 }, // A's window has already elapsed by now
      }),
      { admitAtLockedVersion: true },
    );
    expect(createB.status).toBe("accepted");

    const projection = await loadRelationshipLedgerProjection(ids.branchId);
    const repaired = projection.find((entry) => entry.kind === "promise_repaired");
    expect(repaired).toMatchObject({ fromActorId: ids.ana, toActorId: ids.ben });
  });

  it("forks mid-ledger across the widened event shapes (commitment_kept, activity_started/consentGrant): child ledger rows exactly match a replaySocialLedgerHistory rebuild", async () => {
    const ids = await seedCase();

    const create = await submitDurableCreateCommitment(
      {
        id: `cmd-promise-fork-${ids.branchId}`,
        branchId: ids.branchId,
        expectedVersion: 0,
        idempotencyKey: `promise-fork-key-${ids.branchId}`,
        principal: playerPrincipal(ids.ana),
        submittedAtWallClock: "2026-07-20T12:00:00.000Z",
        correlationId: newId(),
        type: "create_commitment",
        schemaVersion: 1,
        payload: {
          actorId: ids.ana,
          kind: "promise",
          promisedToActorId: ids.ben,
          window: { latestArrival: SEED_SECOND + 2_000 },
          priority: 0,
          flexibility: "soft",
          preparationSeconds: 0,
          reliabilityBufferSeconds: 0,
          noticeLeadSeconds: 0,
          knowledgeSource: { kind: "authored" },
        },
      },
      { admitAtLockedVersion: true },
    );
    expect(create.status).toBe("accepted");
    const commitmentId = deriveCommitmentId(ids.branchId, `cmd-promise-fork-${ids.branchId}`);
    const fulfilled = await submitDurableFulfillCommitment(
      {
        id: `cmd-fulfill-fork-${ids.branchId}`,
        branchId: ids.branchId,
        expectedVersion: 0,
        idempotencyKey: `fulfill-fork-key-${ids.branchId}`,
        principal: playerPrincipal(ids.ana),
        submittedAtWallClock: "2026-07-20T12:05:00.000Z",
        correlationId: newId(),
        type: "fulfill_commitment",
        schemaVersion: 1,
        payload: { commitmentId },
      },
      { admitAtLockedVersion: true },
    );
    expect(fulfilled.status).toBe("accepted");

    const [parentBranchRow] = await db().select().from(simBranches).where(eq(simBranches.id, ids.branchId));
    if (!parentBranchRow) throw new Error("parent branch row missing");

    const childBranchId = newId();
    await forkBranch({
      parentBranchId: ids.branchId,
      childBranchId,
      atSequence: parentBranchRow.headSequence,
      principal: { kind: "storyteller", principalId: "gm-1" },
      reason: "E5.5 slice 2 fork parity over the widened event shapes",
    });

    const parentEventRows = await db()
      .select()
      .from(simEvents)
      .where(eq(simEvents.branchId, ids.branchId))
      .orderBy(asc(simEvents.sequence));
    const parentEvents = parentEventRows.map(branchEventFromRow);
    const commitmentById = (id: string) => (id === commitmentId ? { kind: "promise", promisedToActorId: ids.ben } : undefined);

    const expected = replaySocialLedgerHistory({ events: parentEvents, commitmentById });
    const childProjection = await loadRelationshipLedgerProjection(childBranchId);
    expect(childProjection.some((entry) => entry.kind === "promise_kept")).toBe(true);

    const byId = (entries: typeof expected) =>
      [...entries].map((entry) => ({ ...entry, branchId: childBranchId })).sort((a, b) => a.id.localeCompare(b.id));
    expect(simulationHash(byId(childProjection))).toBe(simulationHash(byId(expected)));
  });
});

// ---------------------------------------------------------------------------
// E5.5 slice 3 — attempt_consent_escalation (ruling 16) and acknowledge_pressure,
// wired end to end through the durable stores. Mirrors slices 1–2's harness
// shape: one describe.runIf(ready) block, cross-domain command sequences,
// ledger assertions against the SAME transaction a command wrote.
// ---------------------------------------------------------------------------

describe.runIf(ready)("E5.5 slice 3 durable consent escalation and pressure acknowledgment", () => {
  function escalationCmd(input: {
    branchId: string;
    actorId: string;
    targetActorId: string;
    scopeKey?: string;
    expectedVersion: number;
    id?: string;
    idempotencyKey?: string;
  }) {
    return {
      id: input.id ?? newId(),
      branchId: input.branchId,
      expectedVersion: input.expectedVersion,
      idempotencyKey: input.idempotencyKey ?? newId(),
      principal: playerPrincipal(input.actorId),
      submittedAtWallClock: "2026-07-20T12:00:00.000Z",
      correlationId: newId(),
      type: "attempt_consent_escalation",
      schemaVersion: 1,
      payload: { actorId: input.actorId, targetActorId: input.targetActorId, scopeKey: input.scopeKey ?? "kiss" },
    };
  }

  it("admission refused (no model budget): decline lands as consent_declined, deliberate() is never invoked", async () => {
    const ids = await seedCase();
    let calls = 0;
    const result = await submitDurableAttemptConsentEscalation(
      escalationCmd({ branchId: ids.branchId, actorId: ids.ana, targetActorId: ids.ben, expectedVersion: 0 }),
      {
        playerControlledActorIds: [],
        modelBudgetRemaining: 0, // fails admission closed (no_model_budget)
        deliberate: async () => {
          calls += 1;
          return { chosenCandidateId: "grant" };
        },
      },
    );
    expect(result.status).toBe("accepted");
    expect(calls).toBe(0);

    const projection = await loadRelationshipLedgerProjection(ids.branchId);
    const declined = projection.find((entry) => entry.kind === "consent_declined");
    expect(declined).toMatchObject({ fromActorId: ids.ben, toActorId: ids.ana, payload: { kind: "consent", scopeKey: "kiss" } });
  });

  it("ruling-16 regression: admitted, grant legitimately outscores decline, but deliberate() throws — the outcome is STILL decline, never the generic highest-score fallback", async () => {
    const ids = await seedCase();

    // Give Ben (the target) enough reason to trust Ana (the actor) that
    // `grant`'s deterministic score clears the base-reluctance constant but
    // stays inside the admission score-gap threshold (400) — the exact
    // "well-liked NPC" shape ruling 16 exists to guard.
    const prior = await submitDurableRecordRelationshipEntry(
      recordEntryCmd({
        branchId: ids.branchId,
        fromActorId: ids.ana,
        toActorId: ids.ben,
        kind: "authored_prior",
        weightOverride: { trustFixedPoint: 700, attractionFixedPoint: 0, resentmentFixedPoint: 0 },
        expectedVersion: 0,
      }),
    );
    expect(prior.status).toBe("accepted");

    let calls = 0;
    const result = await submitDurableAttemptConsentEscalation(
      escalationCmd({ branchId: ids.branchId, actorId: ids.ana, targetActorId: ids.ben, expectedVersion: 1 }),
      {
        playerControlledActorIds: [],
        modelBudgetRemaining: 10,
        deliberate: async () => {
          calls += 1;
          throw new Error("simulated deliberator failure");
        },
      },
    );
    expect(result.status).toBe("accepted");
    expect(calls).toBe(1); // proves admission actually admitted (grant's score beat decline's, inside the gap)

    const projection = await loadRelationshipLedgerProjection(ids.branchId);
    expect(projection.some((entry) => entry.kind === "permission_granted")).toBe(false);
    const declined = projection.find((entry) => entry.kind === "consent_declined");
    expect(declined).toMatchObject({ fromActorId: ids.ben, toActorId: ids.ana });

    const [eventRow] = await db()
      .select()
      .from(simEvents)
      .where(and(eq(simEvents.branchId, ids.branchId), eq(simEvents.type, "consent_escalation_resolved")))
      .orderBy(asc(simEvents.sequence));
    expect(eventRow?.payload).toMatchObject({
      granted: false,
      outcome: { chosenCandidateId: "decline", usedFallback: true },
    });
  });

  it("ruling-16 regression: admitted, grant legitimately outscores decline, but deliberate() returns an UNPARSEABLE response — the outcome is STILL decline", async () => {
    const ids = await seedCase();

    const prior = await submitDurableRecordRelationshipEntry(
      recordEntryCmd({
        branchId: ids.branchId,
        fromActorId: ids.ana,
        toActorId: ids.ben,
        kind: "authored_prior",
        weightOverride: { trustFixedPoint: 700, attractionFixedPoint: 0, resentmentFixedPoint: 0 },
        expectedVersion: 0,
      }),
    );
    expect(prior.status).toBe("accepted");

    let calls = 0;
    const result = await submitDurableAttemptConsentEscalation(
      escalationCmd({ branchId: ids.branchId, actorId: ids.ana, targetActorId: ids.ben, expectedVersion: 1 }),
      {
        playerControlledActorIds: [],
        modelBudgetRemaining: 10,
        deliberate: async () => {
          calls += 1;
          return { garbage: true };
        },
      },
    );
    expect(result.status).toBe("accepted");
    expect(calls).toBe(1);

    const projection = await loadRelationshipLedgerProjection(ids.branchId);
    expect(projection.some((entry) => entry.kind === "permission_granted")).toBe(false);
    const declined = projection.find((entry) => entry.kind === "consent_declined");
    expect(declined).toMatchObject({ fromActorId: ids.ben, toActorId: ids.ana });

    const [eventRow] = await db()
      .select()
      .from(simEvents)
      .where(and(eq(simEvents.branchId, ids.branchId), eq(simEvents.type, "consent_escalation_resolved")))
      .orderBy(asc(simEvents.sequence));
    expect(eventRow?.payload).toMatchObject({
      granted: false,
      outcome: { chosenCandidateId: "decline", usedFallback: true },
    });
  });

  it("ruling-16 regression: admitted, grant legitimately outscores decline, but deliberate() names an UNKNOWN candidate id — the outcome is STILL decline", async () => {
    const ids = await seedCase();

    const prior = await submitDurableRecordRelationshipEntry(
      recordEntryCmd({
        branchId: ids.branchId,
        fromActorId: ids.ana,
        toActorId: ids.ben,
        kind: "authored_prior",
        weightOverride: { trustFixedPoint: 700, attractionFixedPoint: 0, resentmentFixedPoint: 0 },
        expectedVersion: 0,
      }),
    );
    expect(prior.status).toBe("accepted");

    let calls = 0;
    const result = await submitDurableAttemptConsentEscalation(
      escalationCmd({ branchId: ids.branchId, actorId: ids.ana, targetActorId: ids.ben, expectedVersion: 1 }),
      {
        playerControlledActorIds: [],
        modelBudgetRemaining: 10,
        deliberate: async () => {
          calls += 1;
          return { chosenCandidateId: "maybe" };
        },
      },
    );
    expect(result.status).toBe("accepted");
    expect(calls).toBe(1);

    const projection = await loadRelationshipLedgerProjection(ids.branchId);
    expect(projection.some((entry) => entry.kind === "permission_granted")).toBe(false);
    const declined = projection.find((entry) => entry.kind === "consent_declined");
    expect(declined).toMatchObject({ fromActorId: ids.ben, toActorId: ids.ana });

    const [eventRow] = await db()
      .select()
      .from(simEvents)
      .where(and(eq(simEvents.branchId, ids.branchId), eq(simEvents.type, "consent_escalation_resolved")))
      .orderBy(asc(simEvents.sequence));
    expect(eventRow?.payload).toMatchObject({
      granted: false,
      outcome: { chosenCandidateId: "decline", usedFallback: true },
    });
  });

  it("admitted and grants: a resolved deliberate() response records permission_granted, and a subsequent start_activity for that scope now succeeds", async () => {
    const ids = await seedCase();
    const kissActionId = `${ids.branchId}-action-escalation-kiss`;
    await seedDurableActionDefinitions({
      branchId: ids.branchId,
      definitions: [
        {
          id: kissActionId,
          version: 1,
          controllerKinds: ["player", "npc_policy"],
          duration: { kind: "fixed", seconds: 60 },
          preconditions: [{ kind: "consent_covered", scopeKey: "kiss" }],
          requiredClaims: [],
          interruptibility: "pausable",
          noticeability: "obvious",
        },
      ],
    });

    // A net-neutral dyad always scores grant below decline by the base
    // reluctance constant (-500) — a gap decisively past the admission
    // threshold, so admission would refuse outright without ever asking the
    // deliberator. Some real trust evidence is needed for admission to
    // actually ADMIT (not just fall back) before a "grant" response means
    // anything.
    const prior = await submitDurableRecordRelationshipEntry(
      recordEntryCmd({
        branchId: ids.branchId,
        fromActorId: ids.ana,
        toActorId: ids.ben,
        kind: "authored_prior",
        weightOverride: { trustFixedPoint: 250, attractionFixedPoint: 0, resentmentFixedPoint: 0 },
        expectedVersion: 0,
      }),
    );
    expect(prior.status).toBe("accepted");

    let calls = 0;
    const result = await submitDurableAttemptConsentEscalation(
      escalationCmd({ branchId: ids.branchId, actorId: ids.ana, targetActorId: ids.ben, expectedVersion: 1 }),
      {
        playerControlledActorIds: [],
        modelBudgetRemaining: 10,
        deliberate: async () => {
          calls += 1;
          return { chosenCandidateId: "grant" };
        },
      },
    );
    expect(result.status).toBe("accepted");
    expect(calls).toBe(1); // proves this ran through a real admitted deliberation, not a fallback

    const projection = await loadRelationshipLedgerProjection(ids.branchId);
    expect(projection.find((entry) => entry.kind === "permission_granted")).toMatchObject({
      fromActorId: ids.ben,
      toActorId: ids.ana,
      payload: { kind: "consent", scopeKey: "kiss" },
    });

    const started = await submitDurableStartActivity(
      {
        id: `cmd-kiss-after-escalation-${ids.branchId}`,
        branchId: ids.branchId,
        expectedVersion: 1,
        idempotencyKey: `kiss-after-escalation-key-${ids.branchId}`,
        principal: playerPrincipal(ids.ana),
        submittedAtWallClock: "2026-07-20T12:00:00.000Z",
        correlationId: newId(),
        type: "start_activity",
        schemaVersion: 1,
        payload: { actionDefinitionId: kissActionId, actorId: ids.ana, targetActorId: ids.ben },
      },
      { admitAtLockedVersion: true },
    );
    expect(started.status).toBe("accepted");
  });

  it("rejects a player-controlled target before any deliberation call", async () => {
    const ids = await seedCase();
    let calls = 0;
    const result = await submitDurableAttemptConsentEscalation(
      escalationCmd({ branchId: ids.branchId, actorId: ids.ana, targetActorId: ids.ben, expectedVersion: 0 }),
      {
        playerControlledActorIds: [ids.ben],
        modelBudgetRemaining: 10,
        deliberate: async () => {
          calls += 1;
          return { chosenCandidateId: "grant" };
        },
      },
    );
    expect(result).toMatchObject({ status: "rejected", code: "target_is_player_controlled" });
    expect(calls).toBe(0);
    expect(await loadRelationshipLedgerProjection(ids.branchId)).toHaveLength(0);
  });

  it("authoredPriorWeights wiring: the store actually loads and applies an authored_prior override, not a silent zero — a decisive gap refuses admission before the override exists, then admits once it's recorded", async () => {
    const ids = await seedCase();

    // No ledger evidence yet: a net-neutral dyad scores grant -500 below
    // decline, a gap of 500 — decisively past the 400 admission threshold —
    // so admission refuses closed and deliberate() is never called.
    let baselineCalls = 0;
    const baseline = await submitDurableAttemptConsentEscalation(
      escalationCmd({ branchId: ids.branchId, actorId: ids.ana, targetActorId: ids.ben, expectedVersion: 0 }),
      {
        playerControlledActorIds: [],
        modelBudgetRemaining: 10,
        deliberate: async () => {
          baselineCalls += 1;
          return { chosenCandidateId: "grant" };
        },
      },
    );
    expect(baseline.status).toBe("accepted");
    expect(baselineCalls).toBe(0);
    const [baselineEventRow] = await db()
      .select()
      .from(simEvents)
      .where(and(eq(simEvents.branchId, ids.branchId), eq(simEvents.type, "consent_escalation_resolved")))
      .orderBy(asc(simEvents.sequence));
    expect(baselineEventRow?.payload).toMatchObject({ outcome: { admissionReasonCode: "score_gap_decisive" } });

    // Now record an authored_prior override that swings the dyad's read
    // decisively toward grant (trust 700 → gap 200, inside the threshold) —
    // ana's conduct toward ben, the direction the escalation read requires
    // ("how much ben trusts ana" reads entries fromActorId=ana,
    // toActorId=ben).
    const prior = await submitDurableRecordRelationshipEntry(
      recordEntryCmd({
        branchId: ids.branchId,
        fromActorId: ids.ana,
        toActorId: ids.ben,
        kind: "authored_prior",
        weightOverride: { trustFixedPoint: 700, attractionFixedPoint: 0, resentmentFixedPoint: 0 },
        expectedVersion: 1,
      }),
    );
    expect(prior.status).toBe("accepted");

    // If the store failed to load/pass authoredPriorWeights (the "silently
    // zero" regression the review flagged — authored_prior has NO registry
    // weight, so an unloaded override contributes exactly zero, not a
    // partial value), this second call would refuse identically to the
    // baseline above. Instead it must now admit and call deliberate().
    let overrideCalls = 0;
    const withOverride = await submitDurableAttemptConsentEscalation(
      escalationCmd({ branchId: ids.branchId, actorId: ids.ana, targetActorId: ids.ben, expectedVersion: 2 }),
      {
        playerControlledActorIds: [],
        modelBudgetRemaining: 10,
        deliberate: async () => {
          overrideCalls += 1;
          return { chosenCandidateId: "grant" };
        },
      },
    );
    expect(withOverride.status).toBe("accepted");
    expect(overrideCalls).toBe(1);
    // Two consent_escalation_resolved events now exist for this branch (the
    // baseline refusal, then this one) — order DESCENDING and take the
    // first row to inspect the LATEST one, not the baseline again.
    const [overrideEventRow] = await db()
      .select()
      .from(simEvents)
      .where(and(eq(simEvents.branchId, ids.branchId), eq(simEvents.type, "consent_escalation_resolved")))
      .orderBy(desc(simEvents.sequence));
    expect(overrideEventRow?.payload).toMatchObject({
      granted: true,
      outcome: { admissionReasonCode: "admitted", chosenCandidateId: "grant" },
    });
  });

  it("recovers atomically from an injected crash at each checkpoint, retrying the SAME idempotency key to exactly one ledger row (attempt_consent_escalation)", async () => {
    const crashPoints = ["after_event_append", "after_branch_advance"] as const;
    for (const crashAt of crashPoints) {
      const ids = await seedCase();
      const command = escalationCmd({ branchId: ids.branchId, actorId: ids.ana, targetActorId: ids.ben, expectedVersion: 0 });
      let calls = 0;
      const options = {
        playerControlledActorIds: [],
        modelBudgetRemaining: 0, // deterministic: admission refuses, no live model dependency to race against the crash
        deliberate: async () => {
          calls += 1;
          return { chosenCandidateId: "grant" };
        },
      };

      let threw: unknown;
      try {
        await submitDurableAttemptConsentEscalation(command, { ...options, crashAt });
      } catch (error) {
        threw = error;
      }
      expect(threw).toBeInstanceOf(InjectedSimulationCrash);
      expect(await loadRelationshipLedgerProjection(ids.branchId)).toHaveLength(0);

      const retry = await submitDurableAttemptConsentEscalation(command, options);
      expect(retry.status).toBe("accepted");
      expect(calls).toBe(0);
      const projection = await loadRelationshipLedgerProjection(ids.branchId);
      expect(projection.filter((entry) => entry.kind === "consent_declined")).toHaveLength(1);
    }
  });

  it("acknowledge_pressure: prepareEngagementTurn marks an open pressure looked-at for a non-departing participant, and the NEXT cut omits it at unchanged severity", async () => {
    const ids = await seedCase();
    const create = await submitDurableCreateCommitment(
      {
        id: `cmd-promise-ack-${ids.branchId}`,
        branchId: ids.branchId,
        expectedVersion: 0,
        idempotencyKey: `promise-ack-key-${ids.branchId}`,
        principal: playerPrincipal(ids.ana),
        submittedAtWallClock: "2026-07-20T12:00:00.000Z",
        correlationId: newId(),
        type: "create_commitment",
        schemaVersion: 1,
        payload: {
          actorId: ids.ana,
          kind: "promise",
          promisedToActorId: ids.ben,
          window: { latestArrival: SEED_SECOND + 10_000 },
          priority: 0,
          flexibility: "soft",
          preparationSeconds: 0,
          reliabilityBufferSeconds: 0,
          // A destinationless commitment's latestDeparture equals
          // latestArrival (no route to subtract) — noticeAt = latestDeparture
          // - noticeLeadSeconds. Set the lead so notice is due well before
          // the advance below reaches it.
          noticeLeadSeconds: 9_950,
          knowledgeSource: { kind: "authored" },
        },
      },
      { admitAtLockedVersion: true },
    );
    expect(create.status).toBe("accepted");

    // Force the pressure to notice (due at SEED_SECOND + 50) so it's live for this turn.
    await advanceBranchStoryTime(ids.branchId, SEED_SECOND + 100, { workerId: "w-ack-notice" });

    const opened = await submitDurableOpenEngagement(
      {
        id: `cmd-open-ack-${ids.branchId}`,
        branchId: ids.branchId,
        expectedVersion: 0,
        idempotencyKey: `open-ack-key-${ids.branchId}`,
        principal: playerPrincipal(ids.ana),
        submittedAtWallClock: "2026-07-20T12:00:00.000Z",
        correlationId: newId(),
        type: "open_engagement",
        schemaVersion: 1,
        payload: { participantIds: [ids.ana, ids.ben].sort(), channel: "co_present" },
      },
      { admitAtLockedVersion: true },
    );
    expect(opened.status).toBe("accepted");
    const engagementId = deriveEngagementId(ids.branchId, `cmd-open-ack-${ids.branchId}`);

    const firstTurn = await prepareEngagementTurn({
      branchId: ids.branchId,
      engagementId,
      viewpointActorId: ids.ana,
      spanSeconds: 60,
      horizonSeconds: 900,
      workerId: "w-ack-1",
    });
    // Ana's own destinationless-commitment pressure is not departure-eligible
    // (no destination) but is still surfaced this turn and acknowledged.
    expect(firstTurn.cut.relevantPressures.length).toBeGreaterThan(0);
    expect(firstTurn.acknowledgments.some((ack) => ack.actorId === ids.ana && ack.result === "accepted")).toBe(true);

    const secondTurn = await prepareEngagementTurn({
      branchId: ids.branchId,
      engagementId,
      viewpointActorId: ids.ana,
      spanSeconds: 60,
      horizonSeconds: 900,
      workerId: "w-ack-2",
    });
    expect(secondTurn.cut.relevantPressures).toHaveLength(0);
    // Re-acknowledging at the unchanged severity is an expected, harmless no-op.
    expect(secondTurn.acknowledgments.some((ack) => ack.actorId === ids.ana && ack.result === "already_acknowledged")).toBe(
      true,
    );

    // §9.4: a severity change SINCE acknowledgment re-surfaces the pressure —
    // simulate the escalation directly on the row (the blueprint's own
    // sanctioned shortcut, §9.6, since nothing in this slice's domain
    // re-raises severity on a live pressure yet).
    const acked = firstTurn.acknowledgments.find((ack) => ack.actorId === ids.ana && ack.result === "accepted");
    if (!acked) throw new Error("expected ana's first-turn pressure to have been acknowledged");
    await db()
      .update(simTemporalPressures)
      .set({ severity: "urgent" })
      .where(and(eq(simTemporalPressures.branchId, ids.branchId), eq(simTemporalPressures.pressureId, acked.pressureId)));

    const thirdTurn = await prepareEngagementTurn({
      branchId: ids.branchId,
      engagementId,
      viewpointActorId: ids.ana,
      spanSeconds: 60,
      horizonSeconds: 900,
      workerId: "w-ack-3",
    });
    expect(thirdTurn.cut.relevantPressures.some((pressure) => pressure.severity === "urgent")).toBe(true);
    expect(thirdTurn.acknowledgments.some((ack) => ack.actorId === ids.ana && ack.pressureId === acked.pressureId && ack.result === "accepted")).toBe(
      true,
    );
  });

  it("submitDurableAcknowledgePressure rejects a non-system principal as unauthorized_principal", async () => {
    const ids = await seedCase();
    const opened = await submitDurableOpenEngagement(
      {
        id: `cmd-open-unauth-${ids.branchId}`,
        branchId: ids.branchId,
        expectedVersion: 0,
        idempotencyKey: `open-unauth-key-${ids.branchId}`,
        principal: playerPrincipal(ids.ana),
        submittedAtWallClock: "2026-07-20T12:00:00.000Z",
        correlationId: newId(),
        type: "open_engagement",
        schemaVersion: 1,
        payload: { participantIds: [ids.ana, ids.ben].sort(), channel: "co_present" },
      },
      { admitAtLockedVersion: true },
    );
    expect(opened.status).toBe("accepted");
    const engagementId = deriveEngagementId(ids.branchId, `cmd-open-unauth-${ids.branchId}`);

    const result = await submitDurableAcknowledgePressure(
      {
        id: newId(),
        branchId: ids.branchId,
        expectedVersion: 1,
        idempotencyKey: newId(),
        principal: playerPrincipal(ids.ana),
        submittedAtWallClock: "2026-07-20T12:00:00.000Z",
        correlationId: newId(),
        type: "acknowledge_pressure",
        schemaVersion: 1,
        payload: { engagementId, pressureId: "pressure-does-not-exist" },
      },
      { admitAtLockedVersion: true },
    );
    expect(result).toMatchObject({ status: "rejected", code: "unauthorized_principal" });
  });

  it("full-corpus fork-hash parity: authored entries, a change, derived speech-act entries, a kept commitment, a consentGrant-gated activity, and consent_escalation_resolved together — child ledger rows exactly match a replaySocialLedgerHistory rebuild across every ledger-producing E5.5 event type (slices 1–3; pressure_acknowledged is excluded by design, §1.7 — it produces no ledger row, and its own fork/replay safety is proven separately by engagements.ts's replay tests)", async () => {
    const ids = await seedCase();

    // Slice 1 — authored entries + a change. The authored_prior entry is
    // deliberately directed cy→ana, NOT ana→ben — it must stay clear of the
    // ana→ben dyad the escalation below reads, or its weight would stack
    // with confidence_shared's and push the admission gap past the
    // threshold (see the comment at the escalation call below).
    await submitDurableRecordRelationshipEntry(
      recordEntryCmd({ branchId: ids.branchId, fromActorId: ids.ana, toActorId: ids.cy, kind: "help_given", expectedVersion: 0 }),
      { admitAtLockedVersion: true },
    );
    await submitDurableRecordRelationshipEntry(
      recordEntryCmd({
        branchId: ids.branchId,
        fromActorId: ids.cy,
        toActorId: ids.ana,
        kind: "authored_prior",
        weightOverride: { trustFixedPoint: 300, attractionFixedPoint: 0, resentmentFixedPoint: 0 },
        expectedVersion: 0,
      }),
      { admitAtLockedVersion: true },
    );
    await submitDurableRecordRelationshipChange(
      recordChangeCmd({ branchId: ids.branchId, fromActorId: ids.ana, toActorId: ids.cy, changeKey: "became_lovers", expectedVersion: 0 }),
      { admitAtLockedVersion: true },
    );

    // Slice 1 — derived boundary_stated/confidence_shared from a REAL confirm_narrator_result.
    const opened = await submitDurableOpenEngagement(
      {
        id: `cmd-open-corpus-${ids.branchId}`,
        branchId: ids.branchId,
        expectedVersion: 0,
        idempotencyKey: `open-corpus-key-${ids.branchId}`,
        principal: playerPrincipal(ids.ana),
        submittedAtWallClock: "2026-07-20T12:00:00.000Z",
        correlationId: newId(),
        type: "open_engagement",
        schemaVersion: 1,
        payload: { participantIds: [ids.ana, ids.ben].sort(), channel: "co_present" },
      },
      { admitAtLockedVersion: true },
    );
    expect(opened.status).toBe("accepted");
    const engagementId = deriveEngagementId(ids.branchId, `cmd-open-corpus-${ids.branchId}`);

    const turn = await prepareEngagementTurn({
      branchId: ids.branchId,
      engagementId,
      viewpointActorId: ids.ana,
      spanSeconds: 300,
      horizonSeconds: 900,
      workerId: "w-corpus",
      proposedArmedEffects: [
        armedEffect({
          effectType: "boundary_expressed",
          actorId: ids.ben,
          targetActorIds: [ids.ana],
          detail: "Ben says he's fine with kissing but nothing further.",
          consentScopeKey: "kiss",
        }),
        armedEffect({
          effectType: "disclosure_made",
          actorId: ids.ana,
          targetActorIds: [ids.ben],
          detail: "Ana admits she's nervous.",
          disclosureContent: { kind: "claim", propositionKey: "is_nervous", subjectIds: [ids.ana], claimedValue: true },
        }),
      ],
    });
    expect(turn.cut.armedEffects).toHaveLength(2);
    const confirmed = await submitDurableConfirmNarratorResult(
      {
        id: `cmd-confirm-corpus-${ids.branchId}`,
        branchId: ids.branchId,
        expectedVersion: 0,
        idempotencyKey: `confirm-corpus-key-${ids.branchId}`,
        principal: { kind: "system", principalId: "system-1", controlledActorIds: [] },
        submittedAtWallClock: "2026-07-20T12:00:00.000Z",
        correlationId: newId(),
        type: "confirm_narrator_result",
        schemaVersion: 2,
        payload: {
          engagementId,
          cutId: turn.cut.id,
          enactedArmedEffectIds: turn.cut.armedEffects.map((effect) => effect.id),
          softCanonProposals: [],
        },
      },
      { admitAtLockedVersion: true },
    );
    expect(confirmed.status).toBe("accepted");

    // Slice 2 — a kept destinationless promise (promise_kept).
    const create = await submitDurableCreateCommitment(
      {
        id: `cmd-promise-corpus-${ids.branchId}`,
        branchId: ids.branchId,
        expectedVersion: 0,
        idempotencyKey: `promise-corpus-key-${ids.branchId}`,
        principal: playerPrincipal(ids.ana),
        submittedAtWallClock: "2026-07-20T12:00:00.000Z",
        correlationId: newId(),
        type: "create_commitment",
        schemaVersion: 1,
        payload: {
          actorId: ids.ana,
          kind: "promise",
          // Deliberately promised to Cy, not Ben — the escalation below reads
          // the ana→ben dyad, and promise_kept's registry weight (+1500
          // trust) would otherwise stack with the authored_prior override
          // and push the gap back past the admission threshold (decisively
          // "obviously grant" refuses admission just like "obviously
          // decline" does — admission only fires for an AMBIGUOUS gap).
          promisedToActorId: ids.cy,
          window: { latestArrival: SEED_SECOND + 2_000 },
          priority: 0,
          flexibility: "soft",
          preparationSeconds: 0,
          reliabilityBufferSeconds: 0,
          noticeLeadSeconds: 0,
          knowledgeSource: { kind: "authored" },
        },
      },
      { admitAtLockedVersion: true },
    );
    expect(create.status).toBe("accepted");
    const commitmentId = deriveCommitmentId(ids.branchId, `cmd-promise-corpus-${ids.branchId}`);
    const fulfilled = await submitDurableFulfillCommitment(
      {
        id: `cmd-fulfill-corpus-${ids.branchId}`,
        branchId: ids.branchId,
        expectedVersion: 0,
        idempotencyKey: `fulfill-corpus-key-${ids.branchId}`,
        principal: playerPrincipal(ids.ana),
        submittedAtWallClock: "2026-07-20T12:05:00.000Z",
        correlationId: newId(),
        type: "fulfill_commitment",
        schemaVersion: 1,
        payload: { commitmentId },
      },
      { admitAtLockedVersion: true },
    );
    expect(fulfilled.status).toBe("accepted");

    // Slice 3 — an admitted-and-granted escalation (permission_granted),
    // which also opens the consent_covered gate for the activity below. No
    // authored_prior override is added here on purpose: the disclosure_made
    // above already left a confidence_shared entry in the ana→ben direction
    // (trust +250, attraction +100), which alone lands the gap inside the
    // 400-point admission threshold (grant score -150 vs decline 0, gap
    // 150) — adding more evidence on top would push the gap past the
    // threshold and refuse admission as "too decisive" instead (the same
    // failure mode this comment's sibling test, "authoredPriorWeights
    // wiring", exists to pin down).
    const escalation = await submitDurableAttemptConsentEscalation(
      escalationCmd({ branchId: ids.branchId, actorId: ids.ana, targetActorId: ids.ben, expectedVersion: 0 }),
      { playerControlledActorIds: [], modelBudgetRemaining: 10, deliberate: async () => ({ chosenCandidateId: "grant" }), admitAtLockedVersion: true },
    );
    expect(escalation.status).toBe("accepted");

    // Slice 2 — activity_started/consentGrant (boundary_respected), gated by
    // the permission_granted entry just recorded.
    const kissActionId = `${ids.branchId}-action-corpus-kiss`;
    await seedDurableActionDefinitions({
      branchId: ids.branchId,
      definitions: [
        {
          id: kissActionId,
          version: 1,
          controllerKinds: ["player", "npc_policy"],
          duration: { kind: "fixed", seconds: 60 },
          preconditions: [{ kind: "consent_covered", scopeKey: "kiss" }],
          requiredClaims: [],
          interruptibility: "pausable",
          noticeability: "obvious",
        },
      ],
    });
    const started = await submitDurableStartActivity(
      {
        id: `cmd-kiss-corpus-${ids.branchId}`,
        branchId: ids.branchId,
        expectedVersion: 0,
        idempotencyKey: `kiss-corpus-key-${ids.branchId}`,
        principal: playerPrincipal(ids.ana),
        submittedAtWallClock: "2026-07-20T12:00:00.000Z",
        correlationId: newId(),
        type: "start_activity",
        schemaVersion: 1,
        payload: { actionDefinitionId: kissActionId, actorId: ids.ana, targetActorId: ids.ben },
      },
      { admitAtLockedVersion: true },
    );
    expect(started.status).toBe("accepted");

    const projectionBeforeFork = await loadRelationshipLedgerProjection(ids.branchId);
    expect(new Set(projectionBeforeFork.map((entry) => entry.kind))).toEqual(
      new Set([
        "help_given",
        "relationship_change_recorded",
        "boundary_stated",
        "confidence_shared",
        "promise_kept",
        "authored_prior",
        "permission_granted",
        "boundary_respected",
      ]),
    );

    const [parentBranchRow] = await db().select().from(simBranches).where(eq(simBranches.id, ids.branchId));
    if (!parentBranchRow) throw new Error("parent branch row missing");
    const childBranchId = newId();
    await forkBranch({
      parentBranchId: ids.branchId,
      childBranchId,
      atSequence: parentBranchRow.headSequence,
      principal: { kind: "storyteller", principalId: "gm-1" },
      reason: "E5.5 slice 3 full-corpus fork parity",
    });

    const parentEventRows = await db()
      .select()
      .from(simEvents)
      .where(eq(simEvents.branchId, ids.branchId))
      .orderBy(asc(simEvents.sequence));
    const parentEvents = parentEventRows.map(branchEventFromRow);
    const commitmentById = (id: string) => (id === commitmentId ? { kind: "promise" as const, promisedToActorId: ids.cy } : undefined);
    const expected = replaySocialLedgerHistory({ events: parentEvents, commitmentById });
    const childProjection = await loadRelationshipLedgerProjection(childBranchId);

    const byId = (entries: typeof expected) =>
      [...entries].map((entry) => ({ ...entry, branchId: childBranchId })).sort((a, b) => a.id.localeCompare(b.id));
    expect(simulationHash(byId(childProjection))).toBe(simulationHash(byId(expected)));
    expect(childProjection).toHaveLength(projectionBeforeFork.length);
  });
});
