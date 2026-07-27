import { and, eq, inArray, sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import type { SimulationBranchEvent } from "@/contracts/simulation/branching";
import { materialBranchSeedSchema, type MaterialBranchSeed } from "@/contracts/simulation/materials";
import { proposedArmedEffectSchema } from "@/contracts/simulation/narrative";
import { newId } from "@/lib/ids";
import {
  compileNarrativeCut,
  deriveCommitmentId,
  deriveEngagementId,
  journeyArrivalUniquenessKey,
} from "@/lib/simulation";
import { db, simTriggers, simWorlds } from "@/server/db";
import {
  seedDurableAccessGrants,
  submitDurableAttemptEntry,
  submitDurableStorytellerRelocation,
} from "./access-store";
import { seedDurableActionDefinitions, submitDurableStartActivity } from "./activity-store";
import { prepareEngagementTurn, submitDurableConfirmNarratorResult } from "./arbiter-store";
import { loadPersistedCut } from "./narrative-cut-store";
import { loadBranchAncestry, readBranchAncestryEvents } from "./branch-store";
import { readDurableCommitments, submitDurableCreateCommitment } from "./commitment-store";
import { readDurableEngagements, submitDurableOpenEngagement } from "./engagement-store";
import { seedDurableMaterialBranch } from "./material-store";
import { loadViewpointObservations } from "./observation-store";
import { advanceBranchStoryTime } from "./scheduler-store";
import {
  readDurableSpaceBranch,
  seedDurableSpaceTopology,
  submitDurableMoveActor,
} from "./space-store";
import { requireLegacyUnanchoredEngineTestMode } from "@/server/test-support";

/**
 * The Gate 3 exit corpus (engine.plan §"Gate 3 scenario corpus"): every
 * scenario runs against the durable stores with zero model calls, and each
 * asserts the exit invariants — one body, one physical locus, causal
 * movement, access separation, actor control, perspective safety, and
 * deadline consequences.
 */

const SEED_SECOND = 100_000;
/** Cafe → shop is the shift commute; cafe → doorstep is the walk home. */
const SHOP_WALK = 300;
const DOORSTEP_WALK = 600;
const LATEST_ARRIVAL = 101_500;
const NOTICE_LEAD = 900;
// latestDeparture/actBy = 101_500 - 300 - 0 prep = 101_200; noticeAt = 100_300.
const ACT_BY = LATEST_ARRIVAL - SHOP_WALK;
const NOTICE_AT = ACT_BY - NOTICE_LEAD;
/** Turn ends at 100_400 ≥ noticeAt, and 100_400 + 1_000 ≥ actBy ⇒ departure. */
const TURN_SPAN = 400;
const HORIZON = 1_000;

async function probe(): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      db().execute(sql`select 1 from sim_access_grants limit 1`),
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
      `[gate3-corpus.int.test] skipping: database unreachable or unmigrated: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
    return false;
  } finally {
    clearTimeout(timer);
  }
}

const ready = await probe();
if (ready) requireLegacyUnanchoredEngineTestMode("gate3-corpus.int.test");
const seededWorldIds: string[] = [];

afterAll(async () => {
  if (!ready || seededWorldIds.length === 0) return;
  await db().delete(simWorlds).where(inArray(simWorlds.id, seededWorldIds));
});

interface CorpusCase {
  worldId: string;
  branchId: string;
  player: string;
  mara: string;
  iris: string;
  locCafe: string;
  locHome: string;
  zoneCafe: string;
  zoneShop: string;
  zoneDoorstep: string;
  zoneParlor: string;
  frontDoor: string;
  showerActionId: string;
}

interface CorpusSeedOptions {
  permitsTrespass?: boolean;
  playerZone?: "cafe" | "doorstep";
  maraZone?: "cafe" | "doorstep";
  irisZone?: "parlor" | "cafe";
}

function branchSeed(ids: CorpusCase, permitsTrespass: boolean): MaterialBranchSeed {
  return materialBranchSeedSchema.parse({
    worldId: ids.worldId,
    worldTypeId: "gate3-corpus",
    worldSeed: `seed-${ids.worldId}`,
    permitsTrespass,
    branchId: ids.branchId,
    rulesetVersion: "gate3-corpus-v1",
    originStorySecond: SEED_SECOND,
    actors: [
      { id: ids.player, name: "Pia" },
      { id: ids.mara, name: "Mara" },
      { id: ids.iris, name: "Iris" },
    ],
    items: [],
  });
}

/**
 * The corpus stage: a public cafe location (cafe, the shift-work shop, and
 * Mara's doorstep) and a private home whose parlor sits behind a private
 * front-door link — the one hop routes refuse and `attempt_entry` governs.
 * Mara holds a resident grant for the home; Iris is inside as a witness.
 */
async function seedCorpusCase(options: CorpusSeedOptions = {}): Promise<CorpusCase> {
  const worldId = newId();
  const branchId = newId();
  const ids: CorpusCase = {
    worldId,
    branchId,
    player: newId(),
    mara: newId(),
    iris: newId(),
    locCafe: `${worldId}-loc-cafe`,
    locHome: `${worldId}-loc-home`,
    zoneCafe: `${branchId}-zone-cafe`,
    zoneShop: `${branchId}-zone-shop`,
    zoneDoorstep: `${branchId}-zone-doorstep`,
    zoneParlor: `${branchId}-zone-parlor`,
    frontDoor: `${branchId}-front-door`,
    showerActionId: `${branchId}-action-shower`,
  };
  const zoneOf = { cafe: ids.zoneCafe, doorstep: ids.zoneDoorstep, parlor: ids.zoneParlor };
  const locOf = { cafe: ids.locCafe, doorstep: ids.locCafe, parlor: ids.locHome };
  const playerZone = options.playerZone ?? "cafe";
  const maraZone = options.maraZone ?? "cafe";
  const irisZone = options.irisZone ?? "parlor";
  await seedDurableMaterialBranch(branchSeed(ids, options.permitsTrespass ?? false));
  await seedDurableSpaceTopology({
    branchId,
    locations: [
      { id: ids.locCafe, worldId, kind: "town", defaultAccessPolicy: "public" },
      { id: ids.locHome, worldId, kind: "home", defaultAccessPolicy: "private" },
    ],
    zones: [
      { id: ids.zoneCafe, locationId: ids.locCafe, kind: "cafe", privacyPolicy: "public" },
      { id: ids.zoneShop, locationId: ids.locCafe, kind: "shop", privacyPolicy: "public" },
      { id: ids.zoneDoorstep, locationId: ids.locCafe, kind: "doorstep", privacyPolicy: "public" },
      { id: ids.zoneParlor, locationId: ids.locHome, kind: "parlor", privacyPolicy: "private" },
    ],
    links: [
      {
        id: `${branchId}-link-cafe-shop`,
        fromZoneId: ids.zoneCafe,
        toZoneId: ids.zoneShop,
        modes: ["walk"],
        minimumDurationSeconds: SHOP_WALK,
        accessPolicy: "public",
        state: "open",
      },
      {
        id: `${branchId}-link-cafe-doorstep`,
        fromZoneId: ids.zoneCafe,
        toZoneId: ids.zoneDoorstep,
        modes: ["walk"],
        minimumDurationSeconds: DOORSTEP_WALK,
        accessPolicy: "public",
        state: "open",
      },
      {
        id: ids.frontDoor,
        fromZoneId: ids.zoneDoorstep,
        toZoneId: ids.zoneParlor,
        modes: ["walk"],
        minimumDurationSeconds: 30,
        accessPolicy: "private",
        state: "open",
      },
    ],
    loci: [
      {
        kind: "at",
        actorId: ids.player,
        locationId: locOf[playerZone],
        zoneId: zoneOf[playerZone],
        since: SEED_SECOND,
      },
      {
        kind: "at",
        actorId: ids.mara,
        locationId: locOf[maraZone],
        zoneId: zoneOf[maraZone],
        since: SEED_SECOND,
      },
      {
        kind: "at",
        actorId: ids.iris,
        locationId: locOf[irisZone],
        zoneId: zoneOf[irisZone],
        since: SEED_SECOND,
      },
    ],
  });
  await seedDurableAccessGrants({
    branchId,
    grants: [
      {
        id: `${branchId}-grant-mara-home`,
        granteeActorId: ids.mara,
        locationId: ids.locHome,
        basis: "resident",
        validFrom: 0,
      },
    ],
  });
  await seedDurableActionDefinitions({
    branchId,
    definitions: [
      {
        id: ids.showerActionId,
        version: 1,
        controllerKinds: ["player"],
        duration: { kind: "fixed", seconds: 900 },
        preconditions: [],
        requiredClaims: [{ kind: "body" }, { kind: "attention", weight: "full" }],
        interruptibility: "pausable",
        noticeability: "private",
      },
    ],
  });
  seededWorldIds.push(worldId);
  return ids;
}

interface CorpusPrincipal {
  kind: "player" | "npc_policy" | "storyteller" | "system";
  principalId: string;
  controlledActorIds: string[];
}

function principalFor(kind: CorpusPrincipal["kind"], controlledActorIds: string[]): CorpusPrincipal {
  return { kind, principalId: `${kind}-1`, controlledActorIds };
}

function command(
  ids: CorpusCase,
  name: string,
  type: string,
  principal: CorpusPrincipal,
  payload: Record<string, unknown>,
) {
  return {
    id: `cmd-${name}-${ids.branchId}`,
    branchId: ids.branchId,
    expectedVersion: 0,
    idempotencyKey: `${name}-key-${ids.branchId}`,
    principal,
    submittedAtWallClock: "2026-07-18T12:00:00.000Z",
    correlationId: `corr-${ids.branchId}`,
    type,
    schemaVersion: type === "confirm_narrator_result" ? 2 : 1,
    payload,
  };
}

const admit = { admitAtLockedVersion: true };

function shiftCommand(ids: CorpusCase) {
  return command(ids, "shift", "create_commitment", principalFor("npc_policy", [ids.mara]), {
    actorId: ids.mara,
    kind: "shift",
    destinationZoneId: ids.zoneShop,
    window: { latestArrival: LATEST_ARRIVAL },
    priority: 10,
    flexibility: "firm",
    preparationSeconds: 0,
    reliabilityBufferSeconds: 0,
    noticeLeadSeconds: NOTICE_LEAD,
    knowledgeSource: { kind: "authored" },
  });
}

function chatCommand(ids: CorpusCase) {
  return command(ids, "chat", "open_engagement", principalFor("player", [ids.player]), {
    participantIds: [ids.player, ids.mara].sort(),
    channel: "co_present",
  });
}

function chatEngagementId(ids: CorpusCase): string {
  return deriveEngagementId(ids.branchId, `cmd-chat-${ids.branchId}`);
}

async function branchEvents(
  branchId: string,
  types?: readonly string[],
): Promise<SimulationBranchEvent[]> {
  const ancestry = await loadBranchAncestry(db(), branchId);
  return readBranchAncestryEvents(db(), ancestry, types === undefined ? {} : { types });
}

async function seedShiftConversation(ids: CorpusCase): Promise<void> {
  const commitment = await submitDurableCreateCommitment(shiftCommand(ids), admit);
  expect(commitment.status).toBe("accepted");
  const chat = await submitDurableOpenEngagement(chatCommand(ids), admit);
  expect(chat.status).toBe("accepted");
}

describe.runIf(ready)("Gate 3 scenario corpus", () => {
  it("departs Mara for her shift mid-conversation, redacts the cause, and survives rerender + confirm", async () => {
    const ids = await seedCorpusCase();
    await seedShiftConversation(ids);
    const apology = proposedArmedEffectSchema.parse({
      effectType: "apology_delivered",
      actorId: ids.mara,
      targetActorIds: [ids.player],
      detail: "Mara apologizes for having to leave so suddenly.",
    });
    const strayEffect = proposedArmedEffectSchema.parse({
      effectType: "disclosure_made",
      actorId: ids.mara,
      targetActorIds: [ids.iris],
      detail: "A secret told to someone who is not in the scene.",
    });

    const turn = await prepareEngagementTurn({
      branchId: ids.branchId,
      engagementId: chatEngagementId(ids),
      viewpointActorId: ids.player,
      spanSeconds: TURN_SPAN,
      horizonSeconds: HORIZON,
      proposedArmedEffects: [apology, strayEffect],
      workerId: "w-corpus-shift",
    });

    // The turn drained the notice (100_300 ≤ 100_400), the look-ahead saw
    // actBy 101_200 ≤ 101_400, and deterministic policy departed Mara.
    expect(turn.advance).toMatchObject({ status: "advanced", storySecond: SEED_SECOND + TURN_SPAN });
    const commitmentId = deriveCommitmentId(ids.branchId, `cmd-shift-${ids.branchId}`);
    expect(turn.departures).toEqual([
      {
        actorId: ids.mara,
        commitmentId,
        destinationZoneId: ids.zoneShop,
        actBy: ACT_BY,
        result: "accepted",
      },
    ]);
    const engagements = await readDurableEngagements(ids.branchId);
    expect(engagements.engagements[0]?.state).toBe("interrupted");
    const space = await readDurableSpaceBranch(ids.branchId);
    expect(space.loci.find((locus) => locus.actorId === ids.mara)?.kind).toBe("in_transit");

    // Perspective safety: the player sees observable behavior, never the
    // private cause — Mara's pressure id, her destination, and any stated
    // reason stay out of the cut; beat summaries are neutral world truth.
    expect(turn.cut.mustEnact.map((beat) => beat.kind)).toEqual([
      "actor_departed",
      "engagement_interrupted",
    ]);
    for (const beat of turn.cut.mustEnact) {
      expect(beat.summary).not.toMatch(/shift|work|commitment|late/iu);
    }
    expect(turn.cut.relevantPressures).toEqual([]);
    const serialized = JSON.stringify(turn.cut);
    expect(serialized).not.toContain(ids.zoneShop);
    const maraPressures = (await readDurableCommitments(ids.branchId)).pressures;
    expect(maraPressures).toHaveLength(1);
    expect(maraPressures[0]?.noticeAt).toBe(NOTICE_AT);
    expect(serialized).not.toContain(maraPressures[0]?.id ?? "pressure-missing");
    expect(turn.cut.forbiddenClaims.map((claim) => claim.claim).join(" ")).toContain("committed movement");
    // Only the proposed effect naming scene participants was armed.
    expect(turn.cut.armedEffects.map((effect) => effect.effectType)).toEqual(["apology_delivered"]);

    // Ruling 8: a failed narrator render re-reads the same cut mid-journey —
    // recompiling from re-read durable state reproduces id and hash exactly.
    const engagement = engagements.engagements[0];
    if (!engagement) throw new Error("Engagement vanished");
    const reread = compileNarrativeCut({
      branchVersion: space.version,
      engagement,
      viewpointActorId: ids.player,
      events: await branchEvents(ids.branchId),
      fromSequence: turn.cut.fromSequence,
      throughSequence: turn.cut.throughSequence,
      fromStorySecond: turn.cut.fromStorySecond,
      throughStorySecond: turn.cut.throughStorySecond,
      space,
      activities: [],
      viewpointObservations: await loadViewpointObservations({
        branchId: ids.branchId,
        witnessActorId: ids.player,
        fromSequence: turn.cut.fromSequence,
        throughSequence: turn.cut.throughSequence,
      }),
      viewpointBeliefs: [],
      viewpointPressures: [],
      failurePresentations: [],
      softCanonEntries: [],
      proposedArmedEffects: [apology, strayEffect],
    });
    expect(reread).toEqual(turn.cut);
    // §22.3 on the durable row: the persisted cut re-reads bit-identical.
    expect(await loadPersistedCut(ids.branchId, turn.cut.id)).toEqual(turn.cut);
    expect(space.headSequence).toBe(turn.cut.throughSequence);

    // Ruling 9 / §23.3: confirmation names armed-effect IDS, revalidated
    // against the persisted cut — an id the cut never armed is ignored.
    const apologyEffectId = turn.cut.armedEffects[0]?.id ?? "armed-missing";
    const confirmCommand = command(ids, "confirm", "confirm_narrator_result", principalFor("system", []), {
      engagementId: chatEngagementId(ids),
      cutId: turn.cut.id,
      enactedArmedEffectIds: [apologyEffectId, "armed-invented-by-the-model"],
      softCanonProposals: [],
    });
    const confirmed = await submitDurableConfirmNarratorResult(confirmCommand, admit);
    expect(confirmed.status).toBe("accepted");
    if (confirmed.status === "accepted") expect(confirmed.eventIds).toHaveLength(1);
    const speech = (await branchEvents(ids.branchId, ["speech_act_delivered"]))[0];
    if (speech?.type !== "speech_act_delivered") throw new Error("Speech act event missing");
    expect(speech.payload).toMatchObject({
      cutId: turn.cut.id,
      effectType: "apology_delivered",
      actorId: ids.mara,
      targetActorIds: [ids.player],
    });
    // Idempotency: replaying the same confirmation returns the cached result
    // without a second emission; reusing the command id under a new key is
    // rejected outright.
    const replay = await submitDurableConfirmNarratorResult(confirmCommand, admit);
    expect(replay).toEqual(confirmed);
    const reuse = await submitDurableConfirmNarratorResult(
      { ...confirmCommand, idempotencyKey: `confirm-reuse-key-${ids.branchId}` },
      admit,
    );
    expect(reuse.status).toBe("rejected");
    if (reuse.status === "rejected") expect(reuse.code).toBe("duplicate_command_id");
    expect(await branchEvents(ids.branchId, ["speech_act_delivered"])).toHaveLength(1);

    // The departure causally satisfies the shift: arrival then kept — the
    // deadline evaluated Mara's actual locus, never a teleport.
    const drained = await advanceBranchStoryTime(ids.branchId, LATEST_ARRIVAL + 100, {
      workerId: "w-corpus-shift-drain",
    });
    expect(drained).toMatchObject({ status: "advanced", drained: 2 });
    expect((await readDurableCommitments(ids.branchId)).commitments[0]?.status).toBe("kept");
    expect(
      (await readDurableSpaceBranch(ids.branchId)).loci.find((locus) => locus.actorId === ids.mara),
    ).toMatchObject({ kind: "at", zoneId: ids.zoneShop });
  });

  it("defers departure on a stay request, then resolves the missed shift without moving anyone", async () => {
    const ids = await seedCorpusCase();
    await seedShiftConversation(ids);
    const turn = await prepareEngagementTurn({
      branchId: ids.branchId,
      engagementId: chatEngagementId(ids),
      viewpointActorId: ids.player,
      spanSeconds: TURN_SPAN,
      horizonSeconds: HORIZON,
      stayRequestedActorIds: [ids.mara],
      workerId: "w-corpus-stay",
    });

    // §15.3: the stay request defers to the last moment — actBy 101_200 is
    // outside the bare turn (100_400), so Mara stays and nothing is enacted.
    expect(turn.departures).toEqual([]);
    expect(turn.cut.mustEnact).toEqual([]);
    expect(JSON.stringify(turn.cut)).not.toContain(
      deriveCommitmentId(ids.branchId, `cmd-shift-${ids.branchId}`),
    );
    expect((await readDurableEngagements(ids.branchId)).engagements[0]?.state).toBe("active");

    // Staying has the consequence: past the deadline the shift is missed,
    // and Mara is still at the cafe (§3.1 invariant 5 — no teleport).
    const outcome = await advanceBranchStoryTime(ids.branchId, LATEST_ARRIVAL + 100, {
      workerId: "w-corpus-stay-drain",
    });
    expect(outcome).toMatchObject({ status: "advanced", drained: 1 });
    const projection = await readDurableCommitments(ids.branchId);
    expect(projection.commitments[0]?.status).toBe("missed");
    expect(projection.pressures[0]?.resolvedAt).toBe(LATEST_ARRIVAL);
    expect(
      (await readDurableSpaceBranch(ids.branchId)).loci.find((locus) => locus.actorId === ids.mara),
    ).toMatchObject({ kind: "at", zoneId: ids.zoneCafe });
  });

  it("refuses summons by uncontrolled movement and player relocation; storyteller relocation is audited", async () => {
    const ids = await seedCorpusCase();
    const summon = await submitDurableMoveActor(
      command(ids, "summon", "move_actor", principalFor("player", [ids.player]), {
        actorId: ids.mara,
        destinationZoneId: ids.zoneDoorstep,
        travelMode: "walk",
      }),
      admit,
    );
    expect(summon.status).toBe("rejected");
    if (summon.status === "rejected") expect(summon.code).toBe("unauthorized_actor");

    const playerRelocate = await submitDurableStorytellerRelocation(
      command(ids, "player-relocate", "storyteller_relocate_actor", principalFor("player", [ids.player]), {
        actorId: ids.mara,
        destinationZoneId: ids.zoneParlor,
        reason: "Player asks the world to summon Mara.",
      }),
      admit,
    );
    expect(playerRelocate.status).toBe("rejected");
    if (playerRelocate.status === "rejected") expect(playerRelocate.code).toBe("unauthorized_principal");

    // Put Mara mid-journey, then relocate: the journey is abandoned first,
    // its arrival trigger is retired, and the bypass is a distinct event.
    const walk = await submitDurableMoveActor(
      command(ids, "npc-walk", "move_actor", principalFor("npc_policy", [ids.mara]), {
        actorId: ids.mara,
        destinationZoneId: ids.zoneShop,
        travelMode: "walk",
      }),
      admit,
    );
    expect(walk.status).toBe("accepted");
    const journeyId = (await readDurableSpaceBranch(ids.branchId)).journeys[0]?.id;
    if (!journeyId) throw new Error("Journey missing after accepted move");

    const relocation = await submitDurableStorytellerRelocation(
      command(ids, "relocate", "storyteller_relocate_actor", principalFor("storyteller", []), {
        actorId: ids.mara,
        destinationZoneId: ids.zoneParlor,
        reason: "Scene direction: Mara is needed at home.",
      }),
      admit,
    );
    expect(relocation.status).toBe("accepted");
    if (relocation.status === "accepted") expect(relocation.eventIds).toHaveLength(2);
    const [abandoned, relocated] = await branchEvents(ids.branchId, [
      "journey_abandoned",
      "storyteller_relocation",
    ]);
    expect(abandoned?.type).toBe("journey_abandoned");
    if (relocated?.type !== "storyteller_relocation") throw new Error("Relocation event missing");
    expect(relocated.payload).toMatchObject({
      actorId: ids.mara,
      abandonedJourneyId: journeyId,
      toZoneId: ids.zoneParlor,
      reason: "Scene direction: Mara is needed at home.",
    });

    // The retired arrival never fires: draining past it moves no one.
    const [arrivalTrigger] = await db()
      .select()
      .from(simTriggers)
      .where(
        and(
          eq(simTriggers.branchId, ids.branchId),
          eq(simTriggers.uniquenessKey, journeyArrivalUniquenessKey(journeyId)),
        ),
      );
    expect(arrivalTrigger?.state).toBe("completed");
    const outcome = await advanceBranchStoryTime(ids.branchId, SEED_SECOND + 2_000, {
      workerId: "w-corpus-summon",
    });
    expect(outcome).toMatchObject({ status: "advanced", drained: 0 });
    const space = await readDurableSpaceBranch(ids.branchId);
    expect(space.loci.find((locus) => locus.actorId === ids.mara)).toMatchObject({
      kind: "at",
      zoneId: ids.zoneParlor,
    });
    expect(space.journeys[0]?.status).toBe("abandoned");
  });

  it("keeps the uninvited out of the home, redacts the cause, and models trespass by world rule", async () => {
    const ids = await seedCorpusCase({ playerZone: "doorstep", maraZone: "doorstep" });
    // Iris is showering behind the private door while everyone knocks.
    const shower = await submitDurableStartActivity(
      command(ids, "shower", "start_activity", principalFor("player", [ids.iris]), {
        actionDefinitionId: ids.showerActionId,
        actorId: ids.iris,
      }),
      admit,
    );
    expect(shower.status).toBe("accepted");

    // Routes refuse to plan through the private front door at all.
    const walkIn = await submitDurableMoveActor(
      command(ids, "walk-in", "move_actor", principalFor("player", [ids.player]), {
        actorId: ids.player,
        destinationZoneId: ids.zoneParlor,
        travelMode: "walk",
      }),
      admit,
    );
    expect(walkIn.status).toBe("rejected");
    if (walkIn.status === "rejected") expect(walkIn.code).toBe("route_access_denied");

    // The unforced threshold attempt is denied with playable alternatives.
    const knock = await submitDurableAttemptEntry(
      command(ids, "knock", "attempt_entry", principalFor("player", [ids.player]), {
        actorId: ids.player,
        linkId: ids.frontDoor,
        forced: false,
      }),
      admit,
    );
    expect(knock.status).toBe("rejected");
    if (knock.status === "rejected") {
      expect(knock.code).toBe("entry_denied");
      expect(knock.legalAlternativeCommandTypes).toEqual([
        "attempt_entry",
        "move_actor",
        "open_engagement",
      ]);
    }

    // Forced entry in a non-permitting world is a stated rule (§14.3), not a
    // disguised physical impossibility.
    const shoulder = await submitDurableAttemptEntry(
      command(ids, "shoulder", "attempt_entry", principalFor("player", [ids.player]), {
        actorId: ids.player,
        linkId: ids.frontDoor,
        forced: true,
      }),
      admit,
    );
    expect(shoulder.status).toBe("rejected");
    if (shoulder.status === "rejected") expect(shoulder.code).toBe("trespass_not_permitted");

    // §14.4 redaction: no refusal names the shower or the person behind the door.
    for (const refusal of [walkIn, knock, shoulder]) {
      if (refusal.status !== "rejected") continue;
      expect(refusal.publicReason).not.toMatch(/shower/iu);
      expect(refusal.publicReason).not.toContain(ids.iris);
    }

    // Mara's resident grant admits her through the same door, witnessed.
    const homecoming = await submitDurableAttemptEntry(
      command(ids, "homecoming", "attempt_entry", principalFor("npc_policy", [ids.mara]), {
        actorId: ids.mara,
        linkId: ids.frontDoor,
        forced: false,
      }),
      admit,
    );
    expect(homecoming.status).toBe("accepted");
    const granted = (await branchEvents(ids.branchId, ["zone_entered"]))[0];
    if (granted?.type !== "zone_entered") throw new Error("Entry event missing");
    expect(granted.payload).toMatchObject({ actorId: ids.mara, basis: "granted", toZoneId: ids.zoneParlor });
    expect(granted.payload.observerActorIds).toEqual([ids.iris, ids.mara, ids.player].sort());
    expect(
      (await readDurableSpaceBranch(ids.branchId)).loci.find((locus) => locus.actorId === ids.mara),
    ).toMatchObject({ kind: "at", zoneId: ids.zoneParlor });

    // Where the world type permits it, forced entry is explicit, consequential,
    // and witnessed — basis `forced`, never silently upgraded to permission.
    const permissive = await seedCorpusCase({ permitsTrespass: true, playerZone: "doorstep" });
    const bargeIn = await submitDurableAttemptEntry(
      command(permissive, "barge-in", "attempt_entry", principalFor("player", [permissive.player]), {
        actorId: permissive.player,
        linkId: permissive.frontDoor,
        forced: true,
      }),
      admit,
    );
    expect(bargeIn.status).toBe("accepted");
    const forcedEntry = (await branchEvents(permissive.branchId, ["zone_entered"]))[0];
    if (forcedEntry?.type !== "zone_entered") throw new Error("Forced entry event missing");
    expect(forcedEntry.payload).toMatchObject({ basis: "forced", toZoneId: permissive.zoneParlor });
    expect(forcedEntry.payload.observerActorIds).toContain(permissive.iris);
    expect(
      (await readDurableSpaceBranch(permissive.branchId)).loci.find(
        (locus) => locus.actorId === permissive.player,
      ),
    ).toMatchObject({ kind: "at", zoneId: permissive.zoneParlor });
  });

  it("refuses a second co-present scene competing for one body", async () => {
    const ids = await seedCorpusCase({ irisZone: "cafe" });
    const first = await submitDurableOpenEngagement(chatCommand(ids), admit);
    expect(first.status).toBe("accepted");
    const rival = await submitDurableOpenEngagement(
      command(ids, "rival-chat", "open_engagement", principalFor("npc_policy", [ids.iris]), {
        participantIds: [ids.iris, ids.mara].sort(),
        channel: "co_present",
      }),
      admit,
    );
    expect(rival.status).toBe("rejected");
    if (rival.status === "rejected") expect(rival.code).toBe("participant_already_engaged");
  });

  // command-integrity.plan.md slice 2 (A2). Ruling A2-1 — the world's clock wins.
  it("lands a co-present turn overtaken by a concurrent drain instead of crashing (A2)", async () => {
    const ids = await seedCorpusCase();
    const opened = await submitDurableOpenEngagement(chatCommand(ids), admit);
    expect(opened.status).toBe("accepted");

    // The race A2 fixes: a skip/travel drain advances the branch clock FAR past where this
    // co-present turn's span (SEED_SECOND + TURN_SPAN) would land, at the same time the turn
    // prepares. Before A2-1 the turn's own advance read the drained clock and threw "Story
    // time cannot move backwards" — which `runCoPresentTurn` surfaces as a reply-less
    // `lastReplyFailure`. Now the turn's advance is tolerant (`at_least`): whatever the
    // interleave, the turn clamps to the drained clock and LANDS with a real cut.
    const farTarget = SEED_SECOND + 86_400;
    const [drain, turn] = await Promise.all([
      advanceBranchStoryTime(ids.branchId, farTarget, { workerId: "w-a2-drain" }),
      prepareEngagementTurn({
        branchId: ids.branchId,
        engagementId: chatEngagementId(ids),
        viewpointActorId: ids.player,
        spanSeconds: TURN_SPAN,
        workerId: "w-a2-turn",
      }),
    ]);

    // Neither side threw: the drain moved forward (exact guard intact) and the turn landed.
    expect(drain.status).toBe("advanced");
    expect(turn.advance.status).toBe("advanced");
    if (turn.advance.status === "advanced") {
      // The world's clock won — the turn never lands BELOW its own span target, and in the
      // raced interleave lands at the far-drained clock. Both are a legal `advanced` outcome.
      expect(turn.advance.storySecond).toBeGreaterThanOrEqual(SEED_SECOND + TURN_SPAN);
    }
    expect(turn.cut.id.length).toBeGreaterThan(0);
  });
});
