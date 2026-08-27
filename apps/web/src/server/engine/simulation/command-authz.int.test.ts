import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { newId } from "@/lib/ids";
import { characterChats, db, simBranches, users } from "@/server/db";
import { log } from "@/server/log";
import {
  branchFootprint,
  expectAccepted,
  expectRejected,
  footprintDelta,
  seedSimBranch,
  simCommand,
  simulationSuiteHarness,
  type SimTestPrincipal,
} from "@/server/test-support";
import { SIM_COMMAND_DENIED } from "./command-authz";
import { submitDurableCreateCohort } from "./cohort-store";
import { submitDurableMoveActor } from "./space-store";

/**
 * The durable command layer proves ownership itself.
 *
 * The seam is exercised DIRECTLY (no route, no `requireSimChat`): a player
 * principal must resolve exactly one chat anchor and match its owner. Unanchored
 * branches remain usable by engine-internal principals, never by a player claim.
 * Both command shells are covered: the shared `runSimulationCommand` (via
 * `submitDurableCreateCohort`) and space-store's older inlined copy (via
 * `submitDurableMoveActor`).
 *
 * `legacyPlayerMode: false` is load-bearing: every denial below must hold with
 * or without the aggregate-run opt-in, so this suite must never require it.
 * The real-user + chat-anchor fixtures stay hand-written — they ARE the subject.
 */

const SEED_SECOND = 10_000;
const WALK_AB = 600;

const harness = await simulationSuiteHarness({
  suite: "command-authz.int.test",
  table: "sim_physical_loci",
  legacyPlayerMode: false,
});
const ready = harness.ready;
const seededUserIds: string[] = [];

let ownerA = "";
let ownerB = "";

interface AuthzCase {
  worldId: string;
  branchId: string;
  actorId: string;
  zoneA: string;
  zoneB: string;
}

async function seedUnanchoredCase(): Promise<AuthzCase> {
  const actorId = newId();
  const branchId = newId();
  const zoneA = `${branchId}-zone-a`;
  const zoneB = `${branchId}-zone-b`;
  const worldId = newId();
  const locHome = `${worldId}-loc-home`;
  const locCafe = `${worldId}-loc-cafe`;
  await seedSimBranch({
    worldId,
    branchId,
    worldTypeId: "command-authz-tests",
    rulesetVersion: "command-authz-v1",
    originStorySecond: SEED_SECOND,
    actors: [{ id: actorId, name: "Mara" }],
    locations: [
      { id: locHome, worldId, kind: "home", defaultAccessPolicy: "private" },
      { id: locCafe, worldId, kind: "cafe", defaultAccessPolicy: "public" },
    ],
    zones: [
      { id: zoneA, locationId: locHome, kind: "room", privacyPolicy: "private" },
      { id: zoneB, locationId: locCafe, kind: "hall", privacyPolicy: "public" },
    ],
    links: [
      {
        id: `${branchId}-link-ab`,
        fromZoneId: zoneA,
        toZoneId: zoneB,
        modes: ["walk"],
        minimumDurationSeconds: WALK_AB,
        accessPolicy: "public",
        state: "open",
      },
    ],
    placements: [{ actorId, locationId: locHome, zoneId: zoneA }],
  });
  harness.trackWorld(worldId);
  return { worldId, branchId, actorId, zoneA, zoneB };
}

async function seedAnchoredCase(ownerId: string): Promise<AuthzCase> {
  const ids = await seedUnanchoredCase();
  await anchorChat(ids.branchId, ownerId);
  return ids;
}

async function anchorChat(branchId: string, ownerId: string): Promise<void> {
  await db().insert(characterChats).values({
    ownerId,
    title: "command-authz anchor",
    engineAuthority: "successor_narrative_view",
    simBranchId: branchId,
  });
}

/**
 * A claimed player principal. The id is deliberately a PARAMETER — the whole
 * subject here is which account id a command claims, so this never routes
 * through the shared `playerPrincipal` helper (which pins the legacy fixture id).
 */
function claimedPlayer(ids: AuthzCase, principalId: string): SimTestPrincipal {
  return { kind: "player", principalId, controlledActorIds: [ids.actorId] };
}

function moveCommand(ids: AuthzCase, principalId: string, key: string) {
  return simCommand({
    branchId: ids.branchId,
    name: `move-${key}`,
    type: "move_actor",
    principal: claimedPlayer(ids, principalId),
    payload: { actorId: ids.actorId, destinationZoneId: ids.zoneB, travelMode: "walk" },
  });
}

function systemMoveCommand(ids: AuthzCase, key: string) {
  return {
    ...moveCommand(ids, "sim-provisioner", key),
    principal: { kind: "system" as const, principalId: "sim-provisioner", controlledActorIds: [ids.actorId] },
  };
}

function cohortCommand(ids: AuthzCase, principalId: string, key: string) {
  return simCommand({
    branchId: ids.branchId,
    name: `cohort-${key}`,
    type: "create_cohort",
    principal: claimedPlayer(ids, principalId),
    payload: {
      cohort: {
        id: newId(),
        name: "cafe regulars",
        population: 40,
        presenceWindows: [
          { zoneId: ids.zoneB, startMinuteOfDay: 480, endMinuteOfDay: 1_080, shareFixedPoint: 8_000 },
        ],
        registryVersion: "cohort-v1",
      },
    },
  });
}

/**
 * The branch row's own counters. `branchFootprint` covers every branch-scoped
 * `sim_` TABLE, but `sim_branches` is keyed by `id` (not `branch_id`) and so is
 * out of its scope — and "the version never moved" is half of what the
 * writes-nothing proofs assert, so it is read alongside.
 */
async function branchCounters(branchId: string): Promise<{ version?: number; headSequence?: number }> {
  const [row] = await db()
    .select({ version: simBranches.version, headSequence: simBranches.headSequence })
    .from(simBranches)
    .where(eq(simBranches.id, branchId))
    .limit(1);
  return { version: row?.version, headSequence: row?.headSequence };
}

interface BranchState {
  footprint: Record<string, number>;
  counters: { version?: number; headSequence?: number };
}

/** Snapshot everything a refused command must leave untouched. */
async function wroteNothingBaseline(branchId: string): Promise<BranchState> {
  return { footprint: await branchFootprint(branchId), counters: await branchCounters(branchId) };
}

/**
 * The writes-NOTHING proof. `branchFootprint` widens the old hand-listed four
 * tables (commands/events/triggers/journeys) to EVERY branch-scoped `sim_`
 * table, so a refusal that leaked a row into any newer store now fails here too.
 */
async function expectWroteNothing(branchId: string, before: BranchState): Promise<void> {
  expect(footprintDelta(before.footprint, await branchFootprint(branchId))).toEqual({});
  expect(await branchCounters(branchId)).toEqual(before.counters);
}

async function warnScopes(body: () => Promise<void>): Promise<string[]> {
  const spy = vi.spyOn(log, "warn").mockImplementation(() => undefined);
  try {
    await body();
    return spy.mock.calls.map((call) => call[0]);
  } finally {
    spy.mockRestore();
  }
}

beforeAll(async () => {
  if (!ready) return;
  const stamp = Date.now();
  const [a] = await db()
    .insert(users)
    .values({ email: `cmd-authz-a-${stamp}@test.local`, name: "Authz Owner" })
    .returning({ id: users.id });
  const [b] = await db()
    .insert(users)
    .values({ email: `cmd-authz-b-${stamp}@test.local`, name: "Authz Stranger" })
    .returning({ id: users.id });
  if (!a || !b) throw new Error("user insert failed");
  ownerA = a.id;
  ownerB = b.id;
  seededUserIds.push(a.id, b.id);
});

// The chat anchors must go before the harness's own world sweep (its afterAll is
// registered first, so it runs LAST under vitest's stacked hook order), and the
// users after their chats.
afterAll(async () => {
  if (!ready || seededUserIds.length === 0) return;
  await db().delete(characterChats).where(inArray(characterChats.ownerId, seededUserIds));
  await db().delete(users).where(inArray(users.id, seededUserIds));
});

describe.runIf(ready)("durable command ownership", () => {
  it("admits the owning account's player principal", async () => {
    const ids = await seedAnchoredCase(ownerA);
    const result = await submitDurableMoveActor(moveCommand(ids, ownerA, "owner"));
    expectAccepted(result, "the owning account's move on its own anchored branch");
    expect(await branchFootprint(ids.branchId)).toMatchObject({ sim_commands: 1 });
    expect(await branchCounters(ids.branchId)).toMatchObject({ version: 1 });
  });

  it("refuses another account's player principal, and writes NOTHING", async () => {
    const ids = await seedAnchoredCase(ownerA);
    const before = await wroteNothingBaseline(ids.branchId);
    let result: Awaited<ReturnType<typeof submitDurableMoveActor>> | undefined;
    const scopes = await warnScopes(async () => {
      result = await submitDurableMoveActor(moveCommand(ids, ownerB, "stranger"));
    });
    expect(result).toMatchObject({ status: "rejected", code: "branch_mismatch" });
    expect(scopes).toContain(SIM_COMMAND_DENIED);
    await expectWroteNothing(ids.branchId, before);
  });

  it("refuses a principal id that belongs to no account at all", async () => {
    const ids = await seedAnchoredCase(ownerA);
    const before = await wroteNothingBaseline(ids.branchId);
    let result: Awaited<ReturnType<typeof submitDurableMoveActor>> | undefined;
    const scopes = await warnScopes(async () => {
      result = await submitDurableMoveActor(moveCommand(ids, `ghost-${newId()}`, "ghost"));
    });
    expect(result).toMatchObject({ status: "rejected", code: "branch_mismatch" });
    expect(scopes).toContain(SIM_COMMAND_DENIED);
    await expectWroteNothing(ids.branchId, before);
  });

  it("fails closed when two accounts' chats cross-link the same branch", async () => {
    const ids = await seedAnchoredCase(ownerA);
    await anchorChat(ids.branchId, ownerB);
    const before = await wroteNothingBaseline(ids.branchId);
    let result: Awaited<ReturnType<typeof submitDurableMoveActor>> | undefined;
    const scopes = await warnScopes(async () => {
      result = await submitDurableMoveActor(moveCommand(ids, ownerA, "ambiguous"));
    });
    expect(result).toMatchObject({ status: "rejected", code: "branch_mismatch" });
    expect(scopes).toContain(SIM_COMMAND_DENIED);
    await expectWroteNothing(ids.branchId, before);
  });

  it("refuses a PLAYER principal on an unanchored branch, and writes NOTHING", async () => {
    const ids = await seedUnanchoredCase();
    const before = await wroteNothingBaseline(ids.branchId);
    let result: Awaited<ReturnType<typeof submitDurableMoveActor>> | undefined;
    const scopes = await warnScopes(async () => {
      result = await submitDurableMoveActor(moveCommand(ids, ownerA, "unanchored-player"));
    });
    expect(result).toMatchObject({ status: "rejected", code: "branch_mismatch" });
    expect(scopes).toContain(SIM_COMMAND_DENIED);
    await expectWroteNothing(ids.branchId, before);
  });

  it("still admits an unanchored branch for an engine-internal principal", async () => {
    const ids = await seedUnanchoredCase();
    const result = await submitDurableMoveActor(systemMoveCommand(ids, "unanchored-system"));
    expectAccepted(result, "an engine-internal system move on an unanchored branch");
  });

  it("guards the SHARED runner too, above its command-ledger insert", async () => {
    const ids = await seedAnchoredCase(ownerA);
    const owned = await submitDurableCreateCohort(cohortCommand(ids, ownerA, "owner"));
    expectRejected(owned, "unauthorized_principal", "a player principal authoring a cohort");
    const afterOwner = await wroteNothingBaseline(ids.branchId);
    expect(afterOwner.footprint).toMatchObject({ sim_commands: 1 });

    let stranger: Awaited<ReturnType<typeof submitDurableCreateCohort>> | undefined;
    const scopes = await warnScopes(async () => {
      stranger = await submitDurableCreateCohort(cohortCommand(ids, ownerB, "stranger"));
    });
    expect(stranger).toMatchObject({ status: "rejected", code: "branch_mismatch" });
    expect(scopes).toContain(SIM_COMMAND_DENIED);
    await expectWroteNothing(ids.branchId, afterOwner);
  });
});
