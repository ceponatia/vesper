import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { materialBranchSeedSchema, type MaterialBranchSeed } from "@/contracts/simulation/materials";
import { newId } from "@/lib/ids";
import {
  characterChats,
  db,
  simBranches,
  simCommands,
  simEvents,
  simJourneys,
  simTriggers,
  simWorlds,
  users,
} from "@/server/db";
import { log } from "@/server/log";
import { probeIntegrationDb } from "@/server/test-support";
import { SIM_COMMAND_DENIED } from "./command-authz";
import { submitDurableCreateCohort } from "./cohort-store";
import { seedDurableMaterialBranch } from "./material-store";
import { seedDurableSpaceTopology, submitDurableMoveActor, type SpaceTopologySeed } from "./space-store";

/**
 * security-authz.plan.md §Follow-ups item 1 — the durable command layer proves
 * ownership itself.
 *
 * The seam is exercised DIRECTLY (no route, no `requireSimChat`): that is the
 * whole point of the follow-up, since the route gate was previously the only
 * one. A branch's owner is reached through the chat anchor
 * (`character_chats.sim_branch_id` → `owner_id`) because `sim_worlds` /
 * `sim_branches` carry no owner column.
 *
 * Both command shells are covered: the shared `runSimulationCommand` (via
 * `submitDurableCreateCohort`) and space-store's older inlined copy (via
 * `submitDurableMoveActor`).
 */

const SEED_SECOND = 10_000;
const WALK_AB = 600;

// Self-skips when the database is unreachable, and FAILS instead under strict
// integration mode (`pnpm test:int:strict` / CI) — the shared probe carries both
// modes, including the CI / VESPER_REQUIRE_TEST_DB signals this suite honored
// before the helper existed.
const ready = await probeIntegrationDb("command-authz.int.test", "sim_physical_loci");
const seededWorldIds: string[] = [];
const seededUserIds: string[] = [];

/** The branch owner, and a second real account that owns nothing here. */
let ownerA = "";
let ownerB = "";

interface AuthzCase {
  worldId: string;
  branchId: string;
  actorId: string;
  zoneA: string;
  zoneB: string;
}

function branchSeed(ids: AuthzCase): MaterialBranchSeed {
  return materialBranchSeedSchema.parse({
    worldId: ids.worldId,
    worldTypeId: "command-authz-tests",
    worldSeed: `seed-${ids.worldId}`,
    branchId: ids.branchId,
    rulesetVersion: "command-authz-v1",
    originStorySecond: SEED_SECOND,
    actors: [{ id: ids.actorId, name: "Mara" }],
    items: [],
  });
}

function topologySeed(ids: AuthzCase): SpaceTopologySeed {
  const locHome = `${ids.worldId}-loc-home`;
  const locCafe = `${ids.worldId}-loc-cafe`;
  return {
    branchId: ids.branchId,
    locations: [
      { id: locHome, worldId: ids.worldId, kind: "home", defaultAccessPolicy: "private" },
      { id: locCafe, worldId: ids.worldId, kind: "cafe", defaultAccessPolicy: "public" },
    ],
    zones: [
      { id: ids.zoneA, locationId: locHome, kind: "room", privacyPolicy: "private" },
      { id: ids.zoneB, locationId: locCafe, kind: "hall", privacyPolicy: "public" },
    ],
    links: [
      {
        id: `${ids.branchId}-link-ab`,
        fromZoneId: ids.zoneA,
        toZoneId: ids.zoneB,
        modes: ["walk"],
        minimumDurationSeconds: WALK_AB,
        accessPolicy: "public",
        state: "open",
      },
    ],
    loci: [{ kind: "at", actorId: ids.actorId, locationId: locHome, zoneId: ids.zoneA, since: SEED_SECOND }],
  };
}

/** A world + branch with no chat pointing at it — the engine-internal (unanchored) shape. */
async function seedUnanchoredCase(): Promise<AuthzCase> {
  const worldId = newId();
  const branchId = newId();
  const ids: AuthzCase = {
    worldId,
    branchId,
    actorId: newId(),
    zoneA: `${branchId}-zone-a`,
    zoneB: `${branchId}-zone-b`,
  };
  await seedDurableMaterialBranch(branchSeed(ids));
  await seedDurableSpaceTopology(topologySeed(ids));
  seededWorldIds.push(worldId);
  return ids;
}

/** …and the same world with `ownerId`'s chat anchored onto it, the way a successor chat is born. */
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

function moveCommand(ids: AuthzCase, principalId: string, key: string) {
  return {
    id: `cmd-move-${key}-${ids.branchId}`,
    branchId: ids.branchId,
    expectedVersion: 0,
    idempotencyKey: `move-${key}-${ids.branchId}`,
    principal: { kind: "player", principalId, controlledActorIds: [ids.actorId] },
    submittedAtWallClock: "2026-07-26T12:00:00.000Z",
    correlationId: `corr-${ids.branchId}`,
    type: "move_actor",
    schemaVersion: 1,
    payload: { actorId: ids.actorId, destinationZoneId: ids.zoneB, travelMode: "walk" },
  };
}

function cohortCommand(ids: AuthzCase, principalId: string, key: string) {
  return {
    id: `cmd-cohort-${key}-${ids.branchId}`,
    branchId: ids.branchId,
    expectedVersion: 0,
    idempotencyKey: `cohort-${key}-${ids.branchId}`,
    principal: { kind: "player", principalId, controlledActorIds: [ids.actorId] },
    submittedAtWallClock: "2026-07-26T12:00:00.000Z",
    correlationId: `corr-${ids.branchId}`,
    type: "create_cohort",
    schemaVersion: 1,
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
  };
}

/** Everything a command could leave behind on this branch. */
async function footprint(branchId: string) {
  const [commands, events, triggers, journeys, branch] = await Promise.all([
    db().select({ id: simCommands.commandId }).from(simCommands).where(eq(simCommands.branchId, branchId)),
    db().select({ id: simEvents.id }).from(simEvents).where(eq(simEvents.branchId, branchId)),
    db().select({ id: simTriggers.id }).from(simTriggers).where(eq(simTriggers.branchId, branchId)),
    db().select({ id: simJourneys.id }).from(simJourneys).where(eq(simJourneys.branchId, branchId)),
    db()
      .select({ version: simBranches.version, headSequence: simBranches.headSequence })
      .from(simBranches)
      .where(eq(simBranches.id, branchId))
      .limit(1),
  ]);
  return {
    commands: commands.length,
    events: events.length,
    triggers: triggers.length,
    journeys: journeys.length,
    version: branch[0]?.version,
    headSequence: branch[0]?.headSequence,
  };
}

/** Run `body` with `log.warn` captured; returns the scopes it emitted. */
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

afterAll(async () => {
  if (!ready) return;
  // Chats first (they hold the branch anchor), then the worlds (cascading
  // branches/commands/events), then the accounts.
  if (seededUserIds.length > 0) {
    await db().delete(characterChats).where(inArray(characterChats.ownerId, seededUserIds));
  }
  if (seededWorldIds.length > 0) await db().delete(simWorlds).where(inArray(simWorlds.id, seededWorldIds));
  if (seededUserIds.length > 0) await db().delete(users).where(inArray(users.id, seededUserIds));
});

describe.runIf(ready)("durable command ownership (security-authz §Follow-ups 1)", () => {
  it("admits the owning account's player principal", async () => {
    const ids = await seedAnchoredCase(ownerA);
    const result = await submitDurableMoveActor(moveCommand(ids, ownerA, "owner"));
    expect(result.status).toBe("accepted");

    const after = await footprint(ids.branchId);
    expect(after.commands).toBe(1);
    expect(after.version).toBe(1);
  });

  it("refuses another account's player principal, and writes NOTHING", async () => {
    const ids = await seedAnchoredCase(ownerA);
    const before = await footprint(ids.branchId);

    let result: Awaited<ReturnType<typeof submitDurableMoveActor>> | undefined;
    const scopes = await warnScopes(async () => {
      result = await submitDurableMoveActor(moveCommand(ids, ownerB, "stranger"));
    });

    // Fallback: a not-found-shaped refusal — a foreign branch reads like an
    // absent one, so the result is never a branch-existence oracle.
    expect(result).toMatchObject({ status: "rejected", code: "branch_mismatch" });
    // Diagnostic: the coded warning fired (docs/resilience.md §8).
    expect(scopes).toContain(SIM_COMMAND_DENIED);
    // …and the refusal preceded every write: no command/ledger row, no events,
    // no journey, no arrival trigger, no branch advance.
    expect(await footprint(ids.branchId)).toEqual(before);
  });

  it("refuses a principal id that belongs to no account at all", async () => {
    const ids = await seedAnchoredCase(ownerA);
    const before = await footprint(ids.branchId);

    let result: Awaited<ReturnType<typeof submitDurableMoveActor>> | undefined;
    const scopes = await warnScopes(async () => {
      result = await submitDurableMoveActor(moveCommand(ids, `ghost-${newId()}`, "ghost"));
    });

    expect(result).toMatchObject({ status: "rejected", code: "branch_mismatch" });
    expect(scopes).toContain(SIM_COMMAND_DENIED);
    expect(await footprint(ids.branchId)).toEqual(before);
  });

  it("fails closed when two accounts' chats cross-link the same branch", async () => {
    // The schema permits it (no unique index on `sim_branch_id`), so ownership
    // can be genuinely unreadable. Unreadable ⇒ nobody passes, not everybody.
    const ids = await seedAnchoredCase(ownerA);
    await anchorChat(ids.branchId, ownerB);
    const before = await footprint(ids.branchId);

    let result: Awaited<ReturnType<typeof submitDurableMoveActor>> | undefined;
    const scopes = await warnScopes(async () => {
      result = await submitDurableMoveActor(moveCommand(ids, ownerA, "ambiguous"));
    });

    expect(result).toMatchObject({ status: "rejected", code: "branch_mismatch" });
    expect(scopes).toContain(SIM_COMMAND_DENIED);
    expect(await footprint(ids.branchId)).toEqual(before);
  });

  it("still admits an UNANCHORED branch — the engine-internal lane keeps working", async () => {
    // Fixtures, forks, and a world provisioned in the moments before its chat
    // row exists have no account boundary to cross.
    const ids = await seedUnanchoredCase();
    const result = await submitDurableMoveActor(moveCommand(ids, `engine-${newId()}`, "unanchored"));
    expect(result.status).toBe("accepted");
  });

  it("guards the SHARED runner too, above its command-ledger insert", async () => {
    const ids = await seedAnchoredCase(ownerA);

    // The owner clears authorization and is then refused on the DOMAIN rule
    // (§27.6: a player may not people the background) — and that rejection is
    // recorded, which is exactly what makes the next assertion meaningful.
    const owned = await submitDurableCreateCohort(cohortCommand(ids, ownerA, "owner"));
    expect(owned).toMatchObject({ status: "rejected", code: "unauthorized_principal" });
    const afterOwner = await footprint(ids.branchId);
    expect(afterOwner.commands).toBe(1);

    let stranger: Awaited<ReturnType<typeof submitDurableCreateCohort>> | undefined;
    const scopes = await warnScopes(async () => {
      stranger = await submitDurableCreateCohort(cohortCommand(ids, ownerB, "stranger"));
    });
    expect(stranger).toMatchObject({ status: "rejected", code: "branch_mismatch" });
    expect(scopes).toContain(SIM_COMMAND_DENIED);
    // The stranger's rejection left no ledger row: the check runs above the
    // `sim_commands` insert, not alongside it.
    expect(await footprint(ids.branchId)).toEqual(afterOwner);
  });
});
