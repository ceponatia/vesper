import { asc, eq, inArray, sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { materialBranchSeedSchema, type MaterialBranchSeed } from "@/contracts/simulation/materials";
import { narrativeCutSchema } from "@/contracts/simulation/narrative";
import { newId } from "@/lib/ids";
import { deriveCommitmentId, deriveEngagementId } from "@/lib/simulation";
import {
  db,
  simBeliefs,
  simEvents,
  simNarrativeCuts,
  simTemporalPressures,
  simWorlds,
} from "@/server/db";
import { prepareEngagementTurn, submitDurableConfirmNarratorResult } from "./arbiter-store";
import { forkBranch } from "./branch-store";
import { submitDurableCreateCommitment } from "./commitment-store";
import { submitDurableAssignActorLod } from "./lod-store";
import { submitDurableOpenEngagement } from "./engagement-store";
import { seedDurableMaterialBranch } from "./material-store";
import { loadPersistedCut, NarrativeCutVersionError, persistNarrativeCut } from "./narrative-cut-store";
import { loadSoftCanonProjection } from "./soft-canon-recorder";
import { submitDurableDemoteSoftCanon } from "./soft-canon-store";
import { seedDurableSpaceTopology } from "./space-store";
import { requireLegacyUnanchoredEngineTestMode } from "@/server/test-support";

/**
 * E4.3 integration: persisted cuts (immutable, addressable, retryable),
 * narrator confirmation against the persisted row, the armed-disclosure
 * knowledge bridge, ruling-14 soft canon (record → reuse → audited
 * auto-promotion → storyteller demotion), fork replay parity, and the §19.3
 * deliberator seam driven by stubs — zero model calls anywhere.
 */

const SEED_SECOND = 100_000;
const TURN_SPAN = 400;
const HORIZON = 1_000;
const WALK = 300;

async function probe(): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      db().execute(sql`select 1 from sim_narrative_cuts limit 1`),
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
      `[narrative-store.int.test] skipping: database unreachable or unmigrated: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
    return false;
  } finally {
    clearTimeout(timer);
  }
}

const ready = await probe();
if (ready) requireLegacyUnanchoredEngineTestMode("narrative-store.int.test");
const seededWorldIds: string[] = [];

afterAll(async () => {
  if (!ready || seededWorldIds.length === 0) return;
  await db().delete(simWorlds).where(inArray(simWorlds.id, seededWorldIds));
});

/** One cafe with three zones; player and Mara share the hall, Iris shelves stock. */
interface NarrativeCase {
  worldId: string;
  branchId: string;
  player: string;
  mara: string;
  iris: string;
  locCafe: string;
  zoneCafe: string;
  zoneShop: string;
  zoneAnnex: string;
}

function branchSeed(ids: NarrativeCase): MaterialBranchSeed {
  return materialBranchSeedSchema.parse({
    worldId: ids.worldId,
    worldTypeId: "e4-3-tests",
    worldSeed: `seed-${ids.worldId}`,
    branchId: ids.branchId,
    rulesetVersion: "e4-3-test-v1",
    originStorySecond: SEED_SECOND,
    actors: [
      { id: ids.player, name: "Pia" },
      { id: ids.mara, name: "Mara" },
      { id: ids.iris, name: "Iris" },
    ],
    items: [],
  });
}

async function seedNarrativeCase(): Promise<NarrativeCase> {
  const worldId = newId();
  const branchId = newId();
  const ids: NarrativeCase = {
    worldId,
    branchId,
    player: newId(),
    mara: newId(),
    iris: newId(),
    locCafe: `${worldId}-loc-cafe`,
    zoneCafe: `${branchId}-zone-cafe`,
    zoneShop: `${branchId}-zone-shop`,
    zoneAnnex: `${branchId}-zone-annex`,
  };
  await seedDurableMaterialBranch(branchSeed(ids));
  await seedDurableSpaceTopology({
    branchId,
    locations: [{ id: ids.locCafe, worldId, kind: "town", defaultAccessPolicy: "public" }],
    zones: [
      { id: ids.zoneCafe, locationId: ids.locCafe, kind: "cafe", privacyPolicy: "public" },
      { id: ids.zoneShop, locationId: ids.locCafe, kind: "shop", privacyPolicy: "public" },
      { id: ids.zoneAnnex, locationId: ids.locCafe, kind: "annex", privacyPolicy: "public" },
    ],
    links: [
      {
        id: `${branchId}-link-cafe-shop`,
        fromZoneId: ids.zoneCafe,
        toZoneId: ids.zoneShop,
        modes: ["walk"],
        minimumDurationSeconds: WALK,
        accessPolicy: "public",
        state: "open",
      },
      {
        id: `${branchId}-link-cafe-annex`,
        fromZoneId: ids.zoneCafe,
        toZoneId: ids.zoneAnnex,
        modes: ["walk"],
        minimumDurationSeconds: WALK,
        accessPolicy: "public",
        state: "open",
      },
    ],
    loci: [
      { kind: "at", actorId: ids.player, locationId: ids.locCafe, zoneId: ids.zoneCafe, since: SEED_SECOND },
      { kind: "at", actorId: ids.mara, locationId: ids.locCafe, zoneId: ids.zoneCafe, since: SEED_SECOND },
      { kind: "at", actorId: ids.iris, locationId: ids.locCafe, zoneId: ids.zoneShop, since: SEED_SECOND },
    ],
  });
  seededWorldIds.push(worldId);
  return ids;
}

const admit = { admitAtLockedVersion: true };

function command(
  ids: NarrativeCase,
  name: string,
  type: string,
  principal: { kind: string; principalId: string; controlledActorIds: string[] },
  payload: Record<string, unknown>,
) {
  return {
    id: `cmd-${name}-${ids.branchId}`,
    branchId: ids.branchId,
    expectedVersion: 0,
    idempotencyKey: `${name}-key-${ids.branchId}`,
    principal,
    submittedAtWallClock: "2026-07-19T12:00:00.000Z",
    correlationId: `corr-${ids.branchId}`,
    type,
    schemaVersion: type === "confirm_narrator_result" ? 2 : 1,
    payload,
  };
}

async function openChat(ids: NarrativeCase): Promise<string> {
  const opened = await submitDurableOpenEngagement(
    command(
      ids,
      "chat",
      "open_engagement",
      { kind: "player", principalId: "player-1", controlledActorIds: [ids.player] },
      { participantIds: [ids.player, ids.mara].sort(), channel: "co_present" },
    ),
    admit,
  );
  expect(opened.status).toBe("accepted");
  return deriveEngagementId(ids.branchId, `cmd-chat-${ids.branchId}`);
}

function prepare(ids: NarrativeCase, engagementId: string, overrides: Record<string, unknown> = {}) {
  return prepareEngagementTurn({
    branchId: ids.branchId,
    engagementId,
    viewpointActorId: ids.player,
    spanSeconds: TURN_SPAN,
    horizonSeconds: HORIZON,
    workerId: "w-e4-3",
    ...overrides,
  });
}

function confirm(
  ids: NarrativeCase,
  name: string,
  engagementId: string,
  cutId: string,
  payload: Record<string, unknown>,
) {
  return submitDurableConfirmNarratorResult(
    command(
      ids,
      name,
      "confirm_narrator_result",
      { kind: "system", principalId: "system-1", controlledActorIds: [] },
      { engagementId, cutId, enactedArmedEffectIds: [], softCanonProposals: [], ...payload },
    ),
    admit,
  );
}

function nicknameProposal(ids: NarrativeCase, sourceCutId: string) {
  return {
    key: "nickname_for_player",
    value: "stray",
    scope: "relationship",
    subjectIds: [ids.mara, ids.player].sort(),
    confidenceFixedPoint: 9_000,
    sourceCutId,
  };
}

async function tableCounts(branchId: string): Promise<{ events: number; cuts: number }> {
  const events = await db().select().from(simEvents).where(eq(simEvents.branchId, branchId));
  const cuts = await db().select().from(simNarrativeCuts).where(eq(simNarrativeCuts.branchId, branchId));
  return { events: events.length, cuts: cuts.length };
}

describe.runIf(ready)("E4.3 persisted cuts and narrator integration", () => {
  it("persists cuts immutably: retry re-reads the row, rerender creates nothing, tampering fails loudly (§22.3, ruling 8)", async () => {
    const ids = await seedNarrativeCase();
    const engagementId = await openChat(ids);

    const first = await prepare(ids, engagementId);
    expect(first.cutCreated).toBe(true);
    expect(first.deliberations).toEqual([]);

    // Retry-from-cut: the persisted row IS the render input, bit for bit —
    // and re-reading it twice appends no events, no cuts, no anything.
    const before = await tableCounts(ids.branchId);
    expect(await loadPersistedCut(ids.branchId, first.cut.id)).toEqual(first.cut);
    expect(await loadPersistedCut(ids.branchId, first.cut.id)).toEqual(first.cut);
    expect(await tableCounts(ids.branchId)).toEqual(before);

    // A quiet second turn shares the sequence range but not the story span:
    // it must mint its OWN addressable cut, never collide with the first.
    const second = await prepare(ids, engagementId);
    expect(second.cut.id).not.toBe(first.cut.id);
    expect(second.cutCreated).toBe(true);
    expect(second.cut.fromStorySecond).toBe(first.cut.throughStorySecond);

    // Re-persisting the identical cut is idempotent; a same-id different-hash
    // write is a §22.3 violation and throws a version diagnostic.
    await expect(persistNarrativeCut(second.cut)).resolves.toEqual({ created: false });
    const tampered = narrativeCutSchema.parse({ ...second.cut, semanticHash: "deadbeef" });
    await expect(persistNarrativeCut(tampered)).rejects.toBeInstanceOf(NarrativeCutVersionError);
  });

  it("confirms by id against the persisted cut, bridges armed disclosures into beliefs, and expires superseded cuts (§23.3, ruling 9)", async () => {
    const ids = await seedNarrativeCase();
    const engagementId = await openChat(ids);
    const turn = await prepare(ids, engagementId, {
      proposedArmedEffects: [
        {
          effectType: "disclosure_made",
          actorId: ids.mara,
          targetActorIds: [ids.player],
          detail: "Mara admits she is quitting her job.",
          disclosureContent: {
            kind: "claim",
            propositionKey: "quitting_job",
            subjectIds: [ids.mara],
            claimedValue: { quitting: true },
          },
        },
        {
          effectType: "apology_delivered",
          actorId: ids.mara,
          targetActorIds: [ids.player],
          detail: "An apology the render never delivered.",
        },
      ],
    });
    expect(turn.cut.armedEffects).toHaveLength(2);
    const disclosureEffect = turn.cut.armedEffects.find((effect) => effect.effectType === "disclosure_made");
    if (!disclosureEffect) throw new Error("Disclosure effect missing from cut");

    const confirmed = await confirm(ids, "confirm1", engagementId, turn.cut.id, {
      enactedArmedEffectIds: [disclosureEffect.id, "armed-invented-by-the-model"],
    });
    expect(confirmed.status).toBe("accepted");
    if (confirmed.status === "accepted") expect(confirmed.eventIds).toHaveLength(2);

    // The unknown id was ignored; the unenacted apology expired with its cut.
    const speechRows = await db()
      .select()
      .from(simEvents)
      .where(eq(simEvents.branchId, ids.branchId))
      .orderBy(asc(simEvents.sequence));
    expect(speechRows.filter((row) => row.type === "speech_act_delivered")).toHaveLength(1);
    expect(speechRows.filter((row) => row.type === "disclosure_made")).toHaveLength(1);

    // The bridge landed in the knowledge substrate: the co-present listener
    // now believes what Mara said, at the §20 reported-co-present grade.
    const beliefs = await db()
      .select()
      .from(simBeliefs)
      .where(eq(simBeliefs.branchId, ids.branchId))
      .orderBy(asc(simBeliefs.beliefId));
    expect(beliefs).toHaveLength(1);
    expect(beliefs[0]).toMatchObject({
      holderActorId: ids.player,
      status: "active",
      confidenceFixedPoint: 9_000,
    });

    // The next turn's cut voices that belief back to the speaker (§22.1) —
    // while the confirm's own events, being already-presented material from
    // the previous render, never re-enter a later cut as beats.
    const nextTurn = await prepare(ids, engagementId);
    expect(nextTurn.cut.speakerBeliefs).toHaveLength(1);
    expect(nextTurn.cut.speakerBeliefs[0]).toMatchObject({ propositionKey: "quitting_job" });
    expect(nextTurn.cut.mustEnact).toEqual([]);
    expect(nextTurn.cut.allowedTransitions).toEqual([]);

    // Only the newest cut of an engagement is confirmable (§23.3 expiry).
    const stale = await confirm(ids, "confirm-stale", engagementId, turn.cut.id, {
      enactedArmedEffectIds: [disclosureEffect.id],
    });
    expect(stale.status).toBe("rejected");
    if (stale.status === "rejected") expect(stale.code).toBe("cut_superseded");
    const unknown = await confirm(ids, "confirm-unknown", engagementId, "cut-that-never-was", {
      enactedArmedEffectIds: [disclosureEffect.id],
    });
    expect(unknown.status).toBe("rejected");
    if (unknown.status === "rejected") expect(unknown.code).toBe("cut_not_found");
  });

  it("records soft canon, auto-promotes on the ruled third distinct cut, licenses it, and demotes only for a storyteller (ruling 14)", async () => {
    const ids = await seedNarrativeCase();
    const engagementId = await openChat(ids);

    const cutIds: string[] = [];
    for (let round = 1; round <= 3; round += 1) {
      const turn = await prepare(ids, engagementId);
      cutIds.push(turn.cut.id);
      const confirmed = await confirm(ids, `canon${round}`, engagementId, turn.cut.id, {
        softCanonProposals: [nicknameProposal(ids, turn.cut.id)],
      });
      expect(confirmed.status).toBe("accepted");
    }

    const projection = await loadSoftCanonProjection(ids.branchId);
    expect(projection.entries).toHaveLength(1);
    const entry = projection.entries[0];
    if (!entry) throw new Error("Soft canon entry missing");
    // Ruling 14: three distinct committed cuts promoted it, audibly.
    expect(entry.status).toBe("promoted");
    expect(entry.sourceCutIds).toEqual(cutIds);
    const eventRows = await db()
      .select()
      .from(simEvents)
      .where(eq(simEvents.branchId, ids.branchId))
      .orderBy(asc(simEvents.sequence));
    const promoted = eventRows.filter((row) => row.type === "soft_canon_promoted");
    expect(promoted).toHaveLength(1);
    expect(eventRows.filter((row) => row.type === "soft_canon_recorded")).toHaveLength(3);

    // The promoted detail is licensed to the next render as established fact.
    const licensedTurn = await prepare(ids, engagementId);
    const licenses = licensedTurn.cut.creativeLicenses.filter(
      (license) => license.kind === "established_detail",
    );
    expect(licenses).toHaveLength(1);
    expect(licenses[0]?.softCanon).toMatchObject({ entryId: entry.id, value: "stray" });

    // Re-proposing promoted canon records nothing new.
    const duplicate = await confirm(ids, "canon-dup", engagementId, licensedTurn.cut.id, {
      softCanonProposals: [nicknameProposal(ids, licensedTurn.cut.id)],
    });
    expect(duplicate.status).toBe("rejected");
    if (duplicate.status === "rejected") expect(duplicate.code).toBe("nothing_to_record");

    // Fork parity: the child's bounded store rebuilds row for row.
    const childBranchId = newId();
    await forkBranch({
      parentBranchId: ids.branchId,
      childBranchId,
      atSequence: (await tableCounts(ids.branchId)).events,
      principal: { kind: "player", principalId: "player-1" },
      reason: "after the nickname stuck",
    });
    const childProjection = await loadSoftCanonProjection(childBranchId);
    expect(childProjection.entries).toEqual(
      projection.entries.map((parentEntry) => ({ ...parentEntry, branchId: childBranchId })),
    );

    // Demotion is storyteller-only (ruling 4) and never touches history.
    const unauthorized = await submitDurableDemoteSoftCanon(
      command(
        ids,
        "demote-nope",
        "demote_soft_canon",
        { kind: "system", principalId: "system-1", controlledActorIds: [] },
        { entryId: entry.id, reason: "not yours to retract" },
      ),
      admit,
    );
    expect(unauthorized.status).toBe("rejected");
    if (unauthorized.status === "rejected") expect(unauthorized.code).toBe("unauthorized_principal");

    const demoted = await submitDurableDemoteSoftCanon(
      command(
        ids,
        "demote",
        "demote_soft_canon",
        { kind: "storyteller", principalId: "storyteller-1", controlledActorIds: [] },
        { entryId: entry.id, reason: "the nickname reads as demeaning" },
      ),
      admit,
    );
    expect(demoted.status).toBe("accepted");
    const after = await loadSoftCanonProjection(ids.branchId);
    expect(after.entries[0]?.status).toBe("demoted");
    expect(
      (await db().select().from(simEvents).where(eq(simEvents.branchId, ids.branchId))).filter(
        (row) => row.type === "soft_canon_demoted",
      ),
    ).toHaveLength(1);
  });

  it("lets an admitted stub deliberator pick among departure candidates, falling back deterministically when refused (§19.3)", async () => {
    const seedCommitment = async (
      ids: NarrativeCase,
      name: string,
      destinationZoneId: string,
      latestArrival: number,
      noticeLeadSeconds: number,
    ) => {
      const created = await submitDurableCreateCommitment(
        command(
          ids,
          name,
          "create_commitment",
          { kind: "npc_policy", principalId: "npc-1", controlledActorIds: [ids.mara] },
          {
            actorId: ids.mara,
            kind: "shift",
            destinationZoneId,
            window: { latestArrival },
            priority: 10,
            flexibility: "firm",
            preparationSeconds: 0,
            reliabilityBufferSeconds: 0,
            noticeLeadSeconds,
            knowledgeSource: { kind: "authored" },
          },
        ),
        admit,
      );
      expect(created.status).toBe("accepted");
    };

    // Case one: an admitted deliberator overrides the earliest-boundary rule.
    const ids = await seedNarrativeCase();
    await seedCommitment(ids, "shift-a", ids.zoneShop, SEED_SECOND + 1_500, 900);
    await seedCommitment(ids, "shift-b", ids.zoneAnnex, SEED_SECOND + 1_600, 1_000);
    const engagementId = await openChat(ids);
    const annexCommitmentId = deriveCommitmentId(ids.branchId, `cmd-shift-b-${ids.branchId}`);
    const chooseAnnex = async () => {
      const rows = await db()
        .select()
        .from(simTemporalPressures)
        .where(eq(simTemporalPressures.branchId, ids.branchId));
      const annex = rows.find((row) => row.sourceCommitmentId === annexCommitmentId);
      return { chosenCandidateId: annex?.pressureId ?? "missing", rationaleSummary: "annex pays double" };
    };
    // E6.1: no caller-supplied LOD — an unassigned actor reads the registry
    // default (deliberator), so admission proceeds without a ledger row.
    const turn = await prepare(ids, engagementId, {
      deliberation: {
        scoreGapThresholdFixedPoint: 10_000,
        modelBudgetRemaining: 1,
        deliberate: chooseAnnex,
      },
    });
    expect(turn.deliberations).toHaveLength(1);
    expect(turn.deliberations[0]?.outcome).toMatchObject({
      usedFallback: false,
      rationaleSummary: "annex pays double",
    });
    expect(turn.departures).toHaveLength(1);
    expect(turn.departures[0]?.destinationZoneId).toBe(ids.zoneAnnex);
    expect(turn.departures[0]?.result).toBe("accepted");

    // Case two: a too-low inference LOD never calls the model and the
    // deterministic earliest-boundary policy stands. E6.1: the LOD now comes
    // from the actor's real ledger row — assign small_model through the
    // command, then prepare the turn.
    const fallbackIds = await seedNarrativeCase();
    await seedCommitment(fallbackIds, "shift-a", fallbackIds.zoneShop, SEED_SECOND + 1_500, 900);
    await seedCommitment(fallbackIds, "shift-b", fallbackIds.zoneAnnex, SEED_SECOND + 1_600, 1_000);
    const assigned = await submitDurableAssignActorLod(
      command(
        fallbackIds,
        "lod-small",
        "assign_actor_lod",
        { kind: "storyteller", principalId: "storyteller-1", controlledActorIds: [] },
        { actorId: fallbackIds.mara, simulationLod: "exact", inferenceLod: "small_model" },
      ),
      admit,
    );
    expect(assigned.status).toBe("accepted");
    const fallbackEngagementId = await openChat(fallbackIds);
    let asked = 0;
    const fallbackTurn = await prepare(fallbackIds, fallbackEngagementId, {
      deliberation: {
        scoreGapThresholdFixedPoint: 10_000,
        modelBudgetRemaining: 1,
        deliberate: () => {
          asked += 1;
          return Promise.resolve({ chosenCandidateId: "never-used" });
        },
      },
    });
    expect(asked).toBe(0);
    expect(fallbackTurn.deliberations[0]?.outcome).toMatchObject({
      usedFallback: true,
      admissionReasonCode: "lod_too_low",
    });
    expect(fallbackTurn.departures[0]?.destinationZoneId).toBe(fallbackIds.zoneShop);
  });
});
