import { asc, eq, inArray, sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { materialBranchSeedSchema, type MaterialBranchSeed } from "@/contracts/simulation/materials";
import { proposedArmedEffectSchema, type ProposedArmedEffect } from "@/contracts/simulation/narrative";
import {
  recordRelationshipChangeCommandSchema,
  recordRelationshipEntryCommandSchema,
  type RecordRelationshipChangeCommand,
  type RecordRelationshipEntryCommand,
} from "@/contracts/simulation/social";
import { newId } from "@/lib/ids";
import { deriveEngagementId, replaySocialLedgerHistory, simulationHash } from "@/lib/simulation";
import { db, simBranches, simEvents, simRelationshipLedger, simWorlds } from "@/server/db";
import { prepareEngagementTurn, submitDurableConfirmNarratorResult } from "./arbiter-store";
import { forkBranch } from "./branch-store";
import { submitDurableOpenEngagement } from "./engagement-store";
import { InjectedSimulationCrash, seedDurableMaterialBranch } from "./material-store";
import { branchEventFromRow } from "./observation-store";
import { loadRelationshipLedgerProjection } from "./social-recorder";
import { submitDurableRecordRelationshipChange, submitDurableRecordRelationshipEntry } from "./social-store";
import { seedDurableSpaceTopology } from "./space-store";

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
