import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, vi } from "vitest";
import { newId } from "@/lib/ids";
import { characterChats, db, simBranches } from "@/server/db";
import { log } from "@/server/log";
import { purgeOwnerRows, seedTestUser } from "./db-fixtures";
import { branchFootprint, footprintDelta } from "./sim-assertions";
import { simCommand, type SimCommandEnvelope, type SimSuiteHarness, type SimTestPrincipal } from "./sim-harness";
import { seedSimBranch } from "./sim-seed";

/**
 * The fixture behind the durable command-ownership suites: the strict
 * `command-authz.int.test` and its legacy-mode companion
 * `command-authz-legacy.int.test`. Both prove what `authorizeSimulationCommand`
 * admits against the SAME seeded shapes, so the shapes live here once.
 *
 * The claimed principal id is always a PARAMETER. The subject of these suites is
 * which account id a command claims, so nothing here routes through the shared
 * `playerPrincipal` helper (which pins the legacy fixture id). The real accounts
 * and the chat anchors are real rows: they ARE what the seam reads.
 *
 * Call `commandAuthzFixture` once at module scope, right AFTER the awaited
 * `simulationSuiteHarness`. Its `afterAll` (anchoring chats, then the accounts)
 * must run BEFORE the harness's world sweep, and vitest runs `after*` hooks in
 * reverse registration order, so registering second is what makes it run first.
 */

const SEED_SECOND = 10_000;
const WALK_AB = 600;

/** One actor at home in zone A, one open walking link to the public zone B. */
export interface CommandAuthzCase {
  worldId: string;
  branchId: string;
  actorId: string;
  zoneA: string;
  zoneB: string;
}

/** Two real accounts: `ownerA` anchors branches, `ownerB` is the stranger. Read them inside a test. */
export interface CommandAuthzAccounts {
  ownerA: string;
  ownerB: string;
}

/** Everything a refused command must leave untouched on its branch. */
export interface CommandAuthzBranchState {
  footprint: Record<string, number>;
  counters: { version?: number; headSequence?: number };
}

export interface CommandAuthzFixture {
  /** Filled by the fixture's `beforeAll`; empty strings until then. */
  accounts: Readonly<CommandAuthzAccounts>;
  /** A branch NO chat anchors: only engine-internal principals may write it. */
  seedUnanchoredCase: () => Promise<CommandAuthzCase>;
  /** A branch anchored by one chat owned by `ownerId`. */
  seedAnchoredCase: (ownerId: string) => Promise<CommandAuthzCase>;
  /** Point one more `ownerId` chat at `branchId` (two owners ⇒ an ambiguous anchor). */
  anchorChat: (branchId: string, ownerId: string) => Promise<void>;
  /** A `player` principal claiming `principalId` and controlling the case's actor. */
  claimedPlayer: (ids: CommandAuthzCase, principalId: string) => SimTestPrincipal;
  /** Move the case's actor A → B as a player claiming `principalId`. */
  moveCommand: (ids: CommandAuthzCase, principalId: string, key: string) => SimCommandEnvelope;
  /**
   * The branch row's own counters. `branchFootprint` covers every branch-scoped
   * `sim_` TABLE, but `sim_branches` is keyed by `id` (not `branch_id`) and so is
   * out of its scope — and "the version never moved" is half of what the
   * writes-nothing proofs assert, so it is read alongside.
   */
  branchCounters: (branchId: string) => Promise<{ version?: number; headSequence?: number }>;
  /** Snapshot everything a refused command must leave untouched. */
  wroteNothingBaseline: (branchId: string) => Promise<CommandAuthzBranchState>;
  /**
   * The writes-NOTHING proof: no row moved in ANY branch-scoped `sim_` table
   * (so a refusal that leaked a row into a newer store fails here too), and the
   * branch version and head sequence are unchanged.
   */
  expectWroteNothing: (branchId: string, before: CommandAuthzBranchState) => Promise<void>;
  /** Run `body` with `log.warn` captured; returns the warned scopes in order. */
  warnScopes: (body: () => Promise<void>) => Promise<string[]>;
}

/**
 * Seed the two accounts (`beforeAll`), register their teardown (`afterAll`),
 * and hand back the case builders. `label` prefixes the seeded addresses, so two
 * suites never collide on `users.email`.
 */
export function commandAuthzFixture(harness: SimSuiteHarness, label: string): CommandAuthzFixture {
  const accounts: CommandAuthzAccounts = { ownerA: "", ownerB: "" };

  beforeAll(async () => {
    if (!harness.ready) return;
    accounts.ownerA = (await seedTestUser(`${label}-a`, { name: "Authz Owner" })).id;
    accounts.ownerB = (await seedTestUser(`${label}-b`, { name: "Authz Stranger" })).id;
  });

  // The anchoring chats go with their owners, before the harness's world sweep
  // (see the module comment for why registration order guarantees that).
  afterAll(async () => {
    if (!harness.ready) return;
    await purgeOwnerRows([accounts.ownerA, accounts.ownerB]);
  });

  const seedUnanchoredCase = async (): Promise<CommandAuthzCase> => {
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
  };

  const anchorChat = async (branchId: string, ownerId: string): Promise<void> => {
    await db().insert(characterChats).values({
      ownerId,
      title: "command-authz anchor",
      engineAuthority: "successor_narrative_view",
      simBranchId: branchId,
    });
  };

  const seedAnchoredCase = async (ownerId: string): Promise<CommandAuthzCase> => {
    const ids = await seedUnanchoredCase();
    await anchorChat(ids.branchId, ownerId);
    return ids;
  };

  const claimedPlayer = (ids: CommandAuthzCase, principalId: string): SimTestPrincipal => ({
    kind: "player",
    principalId,
    controlledActorIds: [ids.actorId],
  });

  const moveCommand = (ids: CommandAuthzCase, principalId: string, key: string): SimCommandEnvelope =>
    simCommand({
      branchId: ids.branchId,
      name: `move-${key}`,
      type: "move_actor",
      principal: claimedPlayer(ids, principalId),
      payload: { actorId: ids.actorId, destinationZoneId: ids.zoneB, travelMode: "walk" },
    });

  const branchCounters = async (branchId: string): Promise<{ version?: number; headSequence?: number }> => {
    const [row] = await db()
      .select({ version: simBranches.version, headSequence: simBranches.headSequence })
      .from(simBranches)
      .where(eq(simBranches.id, branchId))
      .limit(1);
    return { version: row?.version, headSequence: row?.headSequence };
  };

  const wroteNothingBaseline = async (branchId: string): Promise<CommandAuthzBranchState> => ({
    footprint: await branchFootprint(branchId),
    counters: await branchCounters(branchId),
  });

  const expectWroteNothing = async (branchId: string, before: CommandAuthzBranchState): Promise<void> => {
    expect(footprintDelta(before.footprint, await branchFootprint(branchId))).toEqual({});
    expect(await branchCounters(branchId)).toEqual(before.counters);
  };

  const warnScopes = async (body: () => Promise<void>): Promise<string[]> => {
    const spy = vi.spyOn(log, "warn").mockImplementation(() => undefined);
    try {
      await body();
      return spy.mock.calls.map((call) => call[0]);
    } finally {
      spy.mockRestore();
    }
  };

  return {
    accounts,
    seedUnanchoredCase,
    seedAnchoredCase,
    anchorChat,
    claimedPlayer,
    moveCommand,
    branchCounters,
    wroteNothingBaseline,
    expectWroteNothing,
    warnScopes,
  };
}
