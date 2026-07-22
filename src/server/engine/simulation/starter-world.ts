import { newId } from "@/lib/ids";
import { db, type Db } from "@/server/db";
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
 */

export const STARTER_WORLD_TYPE_ID = "starter-world-v1";
export const STARTER_RULESET_VERSION = "starter-rules-v1";
/** Day 1 · 8:00am — mornings read naturally for a first scene. */
export const STARTER_ORIGIN_STORY_SECOND = 8 * 3_600;
export const STARTER_REST_ACTION_SUFFIX = "action-rest";

export interface StarterWorldResult {
  worldId: string;
  branchId: string;
  playerActorId: string;
  primaryActorId: string;
  neighborActorId: string;
  keepsakeItemId: string;
}

/** Provision one fresh starter world. Names label prose — they must differ. */
export async function provisionStarterWorld(
  input: { playerName: string; primaryName: string },
  database: Db = db(),
): Promise<StarterWorldResult> {
  const stamp = newId();
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
      ],
    },
    { database },
  );
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
  await seedDurableActionDefinitions(
    {
      branchId,
      definitions: [
        {
          id: `stw-${stamp}-${STARTER_REST_ACTION_SUFFIX}`,
          version: 1,
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

  return {
    worldId,
    branchId,
    playerActorId: actors.player,
    primaryActorId: actors.primary,
    neighborActorId: actors.neighbor,
    keepsakeItemId,
  };
}
