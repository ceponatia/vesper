import { inArray } from "drizzle-orm";
import { afterAll, afterEach } from "vitest";
import { z } from "zod";
import { commandPrincipalSchema, wallClockInstantSchema, type PrincipalKind } from "@/contracts/simulation/envelopes";
import {
  branchVersionSchema,
  commandIdSchema,
  correlationIdSchema,
  idempotencyKeySchema,
  schemaVersionSchema,
  worldBranchIdSchema,
} from "@/contracts/simulation/identity";
import { db, simHouseholdMembers, simWorlds } from "@/server/db";
import { endTestPool } from "./db-fixtures";
import { probeIntegrationDb } from "./int-db";
import {
  legacyEngineTestPlayerPrincipal,
  requireLegacyUnanchoredEngineTestMode,
  type LegacyEngineTestPlayerPrincipal,
} from "./simulation-fixtures";

/**
 * The per-suite scaffold every durable-simulation `.int.test.ts` opens with.
 *
 * Before this module each of the ~28 store suites hand-copied the same four
 * things: a `probe()` racing a 4s timeout, the `requireLegacyUnanchoredEngineTestMode`
 * opt-in guard, a `seededWorldIds` array, and an `afterAll` that deletes those
 * worlds. The copies drifted — some honored only `CI`/`VESPER_REQUIRE_TEST_DB`
 * and never the canonical strict flag, some forgot the legacy-mode guard, some
 * ended the shared pool and some did not — so a suite's skip/fail behavior
 * depended on which file it was copied from. `simulationSuiteHarness` is the one
 * implementation; `probeIntegrationDb` (int-db.ts) supplies the probe semantics.
 *
 * Call it ONCE at module scope, awaited, before the first `describe`:
 *
 * ```ts
 * const harness = await simulationSuiteHarness({ suite: "cohort-store.int.test", table: "sim_cohorts" });
 * describe.runIf(harness.ready)("…", () => { … });
 * ```
 *
 * The hook registration (`afterAll`/`afterEach`) happens during collection, which
 * is why the call must be top-level and awaited: a harness created inside a
 * `describe`/`it` body would attach its teardown to the wrong scope, or to none.
 */

/** The teardown handles a suite feeds its seeded ids into. */
export interface SimSuiteHarness {
  /** False ⇒ the database was unreachable/unmigrated; gate with `describe.runIf`. */
  ready: boolean;
  /** Record a seeded world so teardown deletes it (and everything cascading from it). */
  trackWorld(id: string): void;
  /** Record a seeded branch — only needed with `trackBranchMembers`. */
  trackBranch(id: string): void;
}

export interface SimulationSuiteHarnessOptions {
  /** Suite label used in probe/guard diagnostics, e.g. "cohort-store.int.test". */
  suite: string;
  /** The table the probe reads, so an unmigrated database fails like an absent one. */
  table: string;
  /**
   * Whether this suite submits the legacy synthetic player against directly
   * seeded (unanchored) branches. Default true — that is what the durable store
   * suites do. The authorization suites (command-authz.int.test) MUST pass
   * `false`: their denial coverage may not depend on the opt-in flag.
   */
  legacyPlayerMode?: boolean;
  /**
   * `"afterAll"` (default) deletes every tracked world once, at the end of the
   * file. `"afterEach"` deletes after every test — the material-store idiom, for
   * suites whose cases would otherwise pile up hundreds of rows.
   */
  cleanup?: "afterAll" | "afterEach";
  /**
   * Also delete `sim_household_members` for the tracked branches, ahead of the
   * world delete. That table carries no cascading `branch_id -> sim_branches` FK
   * (only deferred, non-cascading FKs to `sim_households`/`sim_characters`), so a
   * world delete that leaves membership rows behind fails at commit. Suites that
   * create households must set this AND call `trackBranch`.
   */
  trackBranchMembers?: boolean;
}

export async function simulationSuiteHarness(
  options: SimulationSuiteHarnessOptions,
): Promise<SimSuiteHarness> {
  const {
    suite,
    table,
    legacyPlayerMode = true,
    cleanup = "afterAll",
    trackBranchMembers = false,
  } = options;

  const ready = await probeIntegrationDb(suite, table);
  if (ready && legacyPlayerMode) requireLegacyUnanchoredEngineTestMode(suite);

  const worldIds: string[] = [];
  const branchIds: string[] = [];

  // `splice(0)` drains as it reads, so the afterAll sweep below is a no-op after
  // an afterEach run instead of re-issuing deletes for already-gone worlds.
  const purge = async (): Promise<void> => {
    if (!ready) return;
    if (trackBranchMembers && branchIds.length > 0) {
      await db().delete(simHouseholdMembers).where(inArray(simHouseholdMembers.branchId, branchIds.splice(0)));
    }
    if (worldIds.length > 0) {
      await db().delete(simWorlds).where(inArray(simWorlds.id, worldIds.splice(0)));
    }
  };

  if (cleanup === "afterEach") afterEach(purge);

  // ONE afterAll doing purge-then-close: vitest runs `after*` hooks in reverse
  // registration order (`sequence.hooks: "stack"`), so two separate hooks would
  // close the pool BEFORE the delete ran and the teardown would throw.
  afterAll(async () => {
    await purge();
    await endTestPool();
  });

  return {
    ready,
    trackWorld: (id: string): void => {
      worldIds.push(id);
    },
    trackBranch: (id: string): void => {
      branchIds.push(id);
    },
  };
}

// ---------------------------------------------------------------------------
// Principals
// ---------------------------------------------------------------------------

/**
 * The command principal as the durable suites write it: plain strings, because
 * every submit entry point takes `unknown` and re-parses through its own typed
 * envelope. `CommandPrincipal` (contracts) carries branded ids, which would force
 * a cast at every literal.
 */
export interface SimTestPrincipal {
  kind: PrincipalKind;
  principalId: string;
  controlledActorIds: string[];
}

/** The storyteller/GM authority the durable store suites author world state with. */
export const gmPrincipal: SimTestPrincipal = {
  kind: "storyteller",
  principalId: "gm-1",
  controlledActorIds: [],
};

/** The scheduler/system authority behind trigger- and clock-originated commands. */
export const systemPrincipal: SimTestPrincipal = {
  kind: "system",
  principalId: "sim-scheduler",
  controlledActorIds: [],
};

/**
 * The legacy synthetic player, controlling exactly one actor. Its id comes from
 * `LEGACY_ENGINE_TEST_PLAYER_ID` (simulation-fixtures) — the authorization seam
 * matches on that exact value, so a hand-written "principal-1" here would drift
 * out from under the opt-in the moment the fixture id changes.
 */
export function playerPrincipal(actorId: string): LegacyEngineTestPlayerPrincipal {
  return legacyEngineTestPlayerPrincipal([actorId]);
}

/** An NPC policy principal driving one actor. */
export function npcPrincipal(actorId: string): SimTestPrincipal {
  return { kind: "npc_policy", principalId: "npc-1", controlledActorIds: [actorId] };
}

// ---------------------------------------------------------------------------
// Command envelopes
// ---------------------------------------------------------------------------

/**
 * Submit options for every durable store: admit the command at whatever version
 * the locked branch actually holds, so a fixed `expectedVersion: 0` keeps working
 * as a suite appends commands. Copied verbatim in ten files before this.
 */
export const ADMIT_AT_LOCKED_VERSION = { admitAtLockedVersion: true } as const;

/**
 * Command types whose envelope is schema version 2. Derived by hand rather than
 * from a registry because contracts has none: each type builds its own envelope
 * through `createCommandEnvelopeSchema(type, version, payload)` with the version
 * as a literal, so there is no type→version map to read. These two are the only
 * `2`s in `src/contracts/simulation` (`materials.ts` transfer_item, `narrative.ts`
 * confirm_narrator_result); a third would fail its store's own strict envelope
 * parse loudly, which is the backstop.
 */
export const SCHEMA_VERSION_BY_TYPE: Readonly<Record<string, number>> = {
  transfer_item: 2,
  confirm_narrator_result: 2,
};

/**
 * Operational metadata only — it must never affect resolution, which is exactly
 * why one frozen instant serves every suite.
 */
export const DEFAULT_SUBMITTED_AT_WALL_CLOCK = "2026-07-21T12:00:00.000Z";

/**
 * The type-agnostic envelope every `simCommand` result is validated against.
 *
 * There is no single command-envelope schema in contracts to reuse: every type
 * gets its own via `createCommandEnvelopeSchema`, pinned to a literal `type` and
 * `schemaVersion`. This composes the SAME production field schemas that factory
 * composes and leaves `type`/`schemaVersion` open, which is all a type-agnostic
 * builder can promise. The payload stays opaque here — the store re-parses the
 * whole envelope through the real per-type schema, so a bad payload still fails
 * where it should.
 */
const simCommandEnvelopeSchema = z
  .object({
    id: commandIdSchema,
    branchId: worldBranchIdSchema,
    expectedVersion: branchVersionSchema,
    idempotencyKey: idempotencyKeySchema,
    principal: commandPrincipalSchema,
    submittedAtWallClock: wallClockInstantSchema,
    correlationId: correlationIdSchema,
    type: z.string().min(1),
    schemaVersion: schemaVersionSchema,
    payload: z.record(z.string(), z.unknown()),
  })
  .strict();

export type SimCommandEnvelope = z.infer<typeof simCommandEnvelopeSchema>;

export interface SimCommandInput {
  branchId: string;
  /** Per-command label; the id/idempotency key/correlation id are derived from it. */
  name: string;
  type: string;
  payload: Record<string, unknown>;
  /** Defaults to `gmPrincipal` — the storyteller authority most fixtures author with. */
  principal?: SimTestPrincipal;
  /** Defaults to 0; pair with `ADMIT_AT_LOCKED_VERSION` unless the test is about conflict. */
  expectedVersion?: number;
  /** Overrides the `SCHEMA_VERSION_BY_TYPE` lookup (default 1). */
  schemaVersion?: number;
  submittedAtWallClock?: string;
}

/**
 * Build one command envelope. The derived identities are deterministic per
 * (name, branch) — `cmd-<name>-<branch>` / `<name>-key-<branch>` — so replaying
 * the same `name` inside a test exercises idempotency, and two different names
 * never collide across the parallel branches a suite seeds.
 *
 * The result is PARSED, unlike the per-file builders it replaces. For a valid
 * envelope that changes nothing (the store parses the same fields anyway), but a
 * test that deliberately submits a MALFORMED envelope to prove an
 * `invalid_command` rejection must keep building its object by hand — otherwise
 * the throw lands here instead of the rejection landing in the store.
 */
export function simCommand(input: SimCommandInput): SimCommandEnvelope {
  const schemaVersion = input.schemaVersion ?? SCHEMA_VERSION_BY_TYPE[input.type] ?? 1;
  return simCommandEnvelopeSchema.parse({
    id: `cmd-${input.name}-${input.branchId}`,
    branchId: input.branchId,
    expectedVersion: input.expectedVersion ?? 0,
    idempotencyKey: `${input.name}-key-${input.branchId}`,
    principal: input.principal ?? gmPrincipal,
    submittedAtWallClock: input.submittedAtWallClock ?? DEFAULT_SUBMITTED_AT_WALL_CLOCK,
    correlationId: `corr-${input.branchId}`,
    type: input.type,
    schemaVersion,
    payload: input.payload,
  });
}
