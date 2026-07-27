import { eq } from "drizzle-orm";
import type { SimCalendarStart } from "@/lib/simulation/clock";
import {
  db,
  simActionDefinitions,
  simBodyRhythms,
  simBranches,
  simWorlds,
  simZones,
  type Db,
} from "@/server/db";
import { seedDurableActionDefinitions } from "./activity-store";
import { seedDurableBodyRhythms, submitDurableInitializeActorBody } from "./body-store";
import { submitDurableAssignActorLod } from "./lod-store";
import { seedDurableMaterialBranch } from "./material-store";
import { seedDurableSpaceTopology } from "./space-store";

/**
 * The successor front door (engine.rollout.plan.md, owner ask 2026-07-22) —
 * one small FRESH world per successor chat, provisioned through the same
 * durable seeders the rollout world and the admin provisioning route use.
 * Isolation is the point: every chat gets its own branch, cast, and clock, so
 * no two chats ever contend for one standing scene (the R3 live-session
 * lesson). The shape mirrors the rollout template: a home and a town square
 * a five-minute walk apart, the player and the chat's character at home, one
 * background neighbor at the square (so witnessed arrivals exist), a keepsake
 * in the player's pocket (so item transfer exists), and a rest action.
 *
 * RE-RUNNABLE since successor-world-lifecycle.plan.md slice 3: the caller
 * supplies a `stamp` derived from its idempotency key
 * (`deriveProvisioningStamp`) instead of this module minting `newId()`, so
 * every id below is stable across retries — and each seed stage is skipped when
 * its rows are already present. Calling this twice with the same stamp
 * COMPLETES a half-built world rather than raising a duplicate key or building
 * a second one; calling it on a finished world is a handful of cheap existence
 * probes that return the same identities.
 *
 * Stage-level guards (rather than per-row upserts inside the shared seeders)
 * are correct because every seeder is internally transactional: a stage's rows
 * are all present or all absent, never half. The two command stages need no
 * guard at all — their envelopes carry stamp-derived idempotency keys, so the
 * command runner replays the recorded `accepted` result.
 */

export const STARTER_WORLD_TYPE_ID = "starter-world-v1";
export const STARTER_RULESET_VERSION = "starter-rules-v1";
/** Day 1 · 8:00am — mornings read naturally for a first scene. */
export const STARTER_ORIGIN_STORY_SECOND = 8 * 3_600;
/** R5 calendar (ruling 17): fresh worlds open Monday, June 1, 2026 — editable per world. */
export const STARTER_CALENDAR_START: SimCalendarStart = { year: 2026, month: 6, day: 1 };
export const STARTER_REST_ACTION_SUFFIX = "action-rest";

export interface StarterWorldResult {
  worldId: string;
  branchId: string;
  playerActorId: string;
  primaryActorId: string;
  neighborActorId: string;
  keepsakeItemId: string;
}

/**
 * Has this seed stage already committed? Each shared seeder writes its rows in
 * ONE transaction, so a single present row proves the whole stage landed —
 * which is what makes a stage-level skip safe without touching the seeders
 * themselves (they are shared with the rollout world and the admin route).
 */
async function stageAlreadySeeded(rows: Promise<unknown[]>): Promise<boolean> {
  return (await rows).length > 0;
}

/**
 * Provision one starter world, or finish provisioning a half-built one. Names
 * label prose — they must differ.
 *
 * `stamp` is the world's DERIVED identity (see the module doc): the caller
 * passes `deriveProvisioningStamp(ownerId, requestId)` so a retry resumes.
 */
export async function provisionStarterWorld(
  input: {
    /** Key-derived world identity — the same stamp must produce the same world. */
    stamp: string;
    playerName: string;
    primaryName: string;
    /**
     * R5 slice 5: the primary's authored outfit, ported into world truth as
     * WORN items at birth — the outfit chip then reads the sim, not legacy
     * chat state. Slot keys are made unique by the caller's ordering.
     */
    primaryGarments?: readonly { name: string; slotKey: string }[];
  },
  database: Db = db(),
): Promise<StarterWorldResult> {
  const { stamp } = input;
  const worldId = `stw-${stamp}`;
  const branchId = `stw-${stamp}-branch`;
  const primaryName = input.primaryName.trim() || "Companion";
  let playerName = input.playerName.trim() || "Traveler";
  if (playerName.toLowerCase() === primaryName.toLowerCase()) playerName = "Traveler";

  const actors = {
    player: `stw-${stamp}-player`,
    primary: `stw-${stamp}-primary`,
    neighbor: `stw-${stamp}-neighbor`,
  };
  const zones = { home: `stw-${stamp}-zone-home`, square: `stw-${stamp}-zone-square` };
  const locationId = `stw-${stamp}-loc-town`;
  const keepsakeItemId = `stw-${stamp}-item-keepsake`;

  // Stage 1 — world + branch + cast + items. The branch row is created by this
  // seeder's own transaction, so its presence is the stage's completion proof.
  const materialSeeded = await stageAlreadySeeded(
    database.select({ id: simBranches.id }).from(simBranches).where(eq(simBranches.id, branchId)).limit(1),
  );
  if (!materialSeeded) {
    await seedDurableMaterialBranch(
      {
        worldId,
        worldTypeId: STARTER_WORLD_TYPE_ID,
        worldSeed: `stw-seed-${stamp}`,
        branchId,
        rulesetVersion: STARTER_RULESET_VERSION,
        originStorySecond: STARTER_ORIGIN_STORY_SECOND,
        actors: [
          { id: actors.player, name: playerName },
          { id: actors.primary, name: primaryName },
          { id: actors.neighbor, name: "Sable" },
        ],
        items: [
          {
            id: keepsakeItemId,
            name: "a small keepsake",
            ownerActorId: null,
            locus: { kind: "held", actorId: actors.player },
          },
          ...(input.primaryGarments ?? []).map((garment, index) => ({
            id: `stw-${stamp}-garment-${index}`,
            name: garment.name.slice(0, 200),
            ownerActorId: actors.primary,
            locus: { kind: "worn" as const, actorId: actors.primary, slotKey: garment.slotKey },
          })),
        ],
      },
      { database },
    );
  }

  // Stage 2 — topology. `seedDurableSpaceTopology` refuses a branch whose head
  // has moved, and the command stages below are the only thing that moves it, so
  // a resume that still needs this stage always finds the branch at sequence 0.
  const spaceSeeded = await stageAlreadySeeded(
    database.select({ id: simZones.zoneId }).from(simZones).where(eq(simZones.branchId, branchId)).limit(1),
  );
  if (!spaceSeeded) {
    await seedDurableSpaceTopology(
      {
        branchId,
        locations: [{ id: locationId, worldId, kind: "town", defaultAccessPolicy: "public" }],
        zones: [
          { id: zones.home, locationId, kind: "home", privacyPolicy: "public" },
          { id: zones.square, locationId, kind: "plaza", privacyPolicy: "public" },
        ],
        links: [
          {
            id: `stw-${stamp}-link-home-square`,
            fromZoneId: zones.home,
            toZoneId: zones.square,
            modes: ["walk"],
            minimumDurationSeconds: 300,
            accessPolicy: "public",
            state: "open",
          },
        ],
        loci: [
          { kind: "at", actorId: actors.player, locationId, zoneId: zones.home, since: STARTER_ORIGIN_STORY_SECOND },
          { kind: "at", actorId: actors.primary, locationId, zoneId: zones.home, since: STARTER_ORIGIN_STORY_SECOND },
          { kind: "at", actorId: actors.neighbor, locationId, zoneId: zones.square, since: STARTER_ORIGIN_STORY_SECOND },
        ],
      },
      { database },
    );
  }

  // Stage 3 — rhythms.
  const rhythmsSeeded = await stageAlreadySeeded(
    database
      .select({ id: simBodyRhythms.actorId })
      .from(simBodyRhythms)
      .where(eq(simBodyRhythms.branchId, branchId))
      .limit(1),
  );
  if (!rhythmsSeeded) {
    await seedDurableBodyRhythms(
      {
        branchId,
        rows: [
          { actorId: actors.primary, kind: "sleep", startMinuteOfDay: 1_380, endMinuteOfDay: 420 },
          { actorId: actors.primary, kind: "meal", startMinuteOfDay: 720, endMinuteOfDay: 780 },
          { actorId: actors.neighbor, kind: "sleep", startMinuteOfDay: 1_380, endMinuteOfDay: 420 },
        ],
      },
      { database },
    );
  }

  // Stage 4 — the rest action.
  const actionsSeeded = await stageAlreadySeeded(
    database
      .select({ id: simActionDefinitions.actionDefinitionId })
      .from(simActionDefinitions)
      .where(eq(simActionDefinitions.branchId, branchId))
      .limit(1),
  );
  if (!actionsSeeded) {
    await seedDurableActionDefinitions(
      {
        branchId,
        definitions: [
          {
            id: `stw-${stamp}-${STARTER_REST_ACTION_SUFFIX}`,
            version: 1,
            label: "Rest",
            controllerKinds: ["player", "npc_policy"],
            duration: { kind: "fixed", seconds: 600 },
            preconditions: [{ kind: "at_zone_kind", zoneKind: "home" }],
            requiredClaims: [{ kind: "body" }, { kind: "attention", weight: "full" }],
            interruptibility: "pausable",
            noticeability: "obvious",
          },
        ],
      },
      { database },
    );
  }

  // Stages 5–6 — the durable commands. No existence guard needed: their
  // `idempotencyKey` is stamp-derived, so `runSimulationCommand` replays the
  // recorded `accepted` result for one already committed (which is exactly the
  // dedupe the old `newId()` stamp made unreachable).
  const admit = { database, admitAtLockedVersion: true };
  const envelope = (name: string, payload: Record<string, unknown>) => ({
    id: `stw-${stamp}-cmd-${name}`,
    branchId,
    expectedVersion: 0,
    idempotencyKey: `stw-${stamp}-${name}`,
    principal: { kind: "system" as const, principalId: "starter-world-seeder", controlledActorIds: [] },
    submittedAtWallClock: new Date().toISOString(),
    correlationId: `stw-seed-${stamp}`,
    schemaVersion: 1,
    ...payload,
  });
  for (const [name, actorId] of [
    ["init-player", actors.player],
    ["init-primary", actors.primary],
    ["init-neighbor", actors.neighbor],
  ] as const) {
    const result = await submitDurableInitializeActorBody(
      envelope(name, { type: "initialize_actor_body", payload: { actorId, registryVersion: "body-v1", baselineOverrides: {} } }),
      admit,
    );
    if (result.status !== "accepted") {
      throw new Error(`starter world seed step "${name}" was not accepted: ${JSON.stringify(result)}`);
    }
  }
  const lod = await submitDurableAssignActorLod(
    envelope("lod-neighbor", {
      type: "assign_actor_lod",
      payload: { actorId: actors.neighbor, simulationLod: "event", inferenceLod: "no_model" },
    }),
    admit,
  );
  if (lod.status !== "accepted") {
    throw new Error(`starter world seed step "lod-neighbor" was not accepted: ${JSON.stringify(lod)}`);
  }
  // The calendar anchor (R5 time domain): presentation config on the world
  // row, set after the causal seeding — it labels history, never writes it.
  // Naturally idempotent (an UPDATE to a constant), so a resume just re-writes it.
  await database.update(simWorlds).set({ calendarStart: STARTER_CALENDAR_START }).where(eq(simWorlds.id, worldId));

  return {
    worldId,
    branchId,
    playerActorId: actors.player,
    primaryActorId: actors.primary,
    neighborActorId: actors.neighbor,
    keepsakeItemId,
  };
}
