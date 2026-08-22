import { eq } from "drizzle-orm";
import {
  METER_FIXED_POINT_ONE,
  bodyDerivationVersion,
  bodyMeterRegistryByVersion,
} from "@vesper/simulation-core/contracts/bodies";
import type { MaterialBranchSeedInput } from "@vesper/simulation-core/contracts/materials";
import { newId } from "@/lib/ids";
import type { SimCalendarStart } from "@/lib/simulation/clock";
import { db, simWorlds, type Db } from "@/server/db";
import { submitDurableApplyBodySource, submitDurableInitializeActorBody } from "./body-store";
import { seedDurableMaterialBranch } from "./material-store";
import { seedDurableSpaceTopology, type SpaceTopologySeed } from "./space-store";

/**
 * A deliberately small successor world used only by Engine Comparison.
 *
 * This is NOT the ordinary starter world. A comparison mirror must not invent a
 * town, neighbor, keepsake, commitments, lore, meals, or routines that the
 * legacy chat never had. It starts with only the facts needed by the current
 * comparison domains: actor identity, co-presence, clock, body meters and the
 * primary character's structured worn garments.
 */
export const COMPARISON_WORLD_TYPE_ID = "engine-comparison-v1";
export const COMPARISON_RULESET_VERSION = "engine-comparison-rules-v1";

export interface ComparisonWorldGarment {
  name: string;
  slotKey: string;
}

export interface ComparisonWorldSeedInput {
  playerName: string;
  primaryName: string;
  storySecond: number;
  calendarStart: SimCalendarStart;
  primaryPresent: boolean;
  /** Legacy chat values on the normalized 0..1 scale. */
  primaryMeters: Readonly<Record<string, number>>;
  primaryGarments: readonly ComparisonWorldGarment[];
}

export interface ComparisonWorldResult {
  worldId: string;
  branchId: string;
  playerActorId: string;
  primaryActorId: string;
}

function fixedPoint(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(Math.max(0, Math.min(1, value)) * METER_FIXED_POINT_ONE);
}

/**
 * Provision a fresh, isolated comparison mirror from one legacy chat snapshot.
 * Every causal write goes through the durable simulation seed/command seams.
 */
export async function provisionComparisonWorld(
  input: ComparisonWorldSeedInput,
  database: Db = db(),
): Promise<ComparisonWorldResult> {
  const sessionId = newId();
  const worldId = `cmp-${sessionId}`;
  const branchId = `cmp-${sessionId}-branch`;
  const playerActorId = `cmp-${sessionId}-player`;
  const primaryActorId = `cmp-${sessionId}-primary`;
  const locationId = `cmp-${sessionId}-location`;
  const sceneZoneId = `cmp-${sessionId}-scene`;
  const awayZoneId = `cmp-${sessionId}-elsewhere`;

  const material: MaterialBranchSeedInput = {
    worldId,
    worldTypeId: COMPARISON_WORLD_TYPE_ID,
    worldSeed: `comparison-${sessionId}`,
    branchId,
    rulesetVersion: COMPARISON_RULESET_VERSION,
    originStorySecond: Math.max(0, Math.floor(input.storySecond)),
    actors: [
      { id: playerActorId, name: input.playerName.trim() || "the player" },
      { id: primaryActorId, name: input.primaryName.trim() || "Companion" },
    ],
    items: input.primaryGarments.map((garment, index) => ({
      id: `cmp-${sessionId}-garment-${index}`,
      name: garment.name.trim().slice(0, 200) || `garment ${index + 1}`,
      ownerActorId: primaryActorId,
      locus: {
        kind: "worn" as const,
        actorId: primaryActorId,
        slotKey: garment.slotKey.trim().slice(0, 64) || `worn-${index}`,
      },
    })),
  };
  await seedDurableMaterialBranch(material, { database });

  const topology: SpaceTopologySeed = {
    branchId,
    locations: [{ id: locationId, worldId, kind: "comparison_scene", defaultAccessPolicy: "public" }],
    zones: [
      { id: sceneZoneId, locationId, kind: "room", privacyPolicy: "public" },
      { id: awayZoneId, locationId, kind: "elsewhere", privacyPolicy: "public" },
    ],
    // A real link keeps the topology lawful if later comparison work needs a
    // movement read, but no automatic movement is authored by this seed.
    links: [
      {
        id: `cmp-${sessionId}-link`,
        fromZoneId: sceneZoneId,
        toZoneId: awayZoneId,
        modes: ["walk"],
        minimumDurationSeconds: 300,
        accessPolicy: "public",
        state: "open",
      },
    ],
    loci: [
      {
        kind: "at",
        actorId: playerActorId,
        locationId,
        zoneId: sceneZoneId,
        since: material.originStorySecond,
      },
      {
        kind: "at",
        actorId: primaryActorId,
        locationId,
        zoneId: input.primaryPresent ? sceneZoneId : awayZoneId,
        since: material.originStorySecond,
      },
    ],
  };
  await seedDurableSpaceTopology(topology, { database });

  const envelope = (name: string, payload: Record<string, unknown>) => ({
    id: `cmp-${sessionId}-cmd-${name}`,
    branchId,
    expectedVersion: 0,
    idempotencyKey: `cmp-${sessionId}-${name}`,
    principal: {
      kind: "system" as const,
      principalId: "engine-comparison-seeder",
      controlledActorIds: [] as string[],
    },
    submittedAtWallClock: new Date().toISOString(),
    correlationId: `engine-comparison-${sessionId}`,
    schemaVersion: 1,
    ...payload,
  });
  const admit = { database, admitAtLockedVersion: true };

  for (const [name, actorId] of [
    ["init-player", playerActorId],
    ["init-primary", primaryActorId],
  ] as const) {
    const initialized = await submitDurableInitializeActorBody(
      envelope(name, {
        type: "initialize_actor_body",
        payload: { actorId, registryVersion: bodyDerivationVersion, baselineOverrides: {} },
      }),
      admit,
    );
    if (initialized.status !== "accepted") {
      throw new Error(`comparison world body seed ${name} was not accepted: ${JSON.stringify(initialized)}`);
    }
  }

  // Only set meters the successor body contract actually knows. If the legacy
  // chat tracks an extra key, leaving it absent is intentional: the analyzer
  // will surface that missing contract instead of the initializer inventing it.
  const knownMeterKeys = new Set(bodyMeterRegistryByVersion[bodyDerivationVersion].map((definition) => definition.key));
  for (const [meterKey, value] of Object.entries(input.primaryMeters).sort(([a], [b]) => a.localeCompare(b))) {
    if (!knownMeterKeys.has(meterKey)) continue;
    const adjusted = await submitDurableApplyBodySource(
      envelope(`meter-${meterKey}`, {
        type: "apply_body_source",
        payload: {
          actorId: primaryActorId,
          meterKey,
          sourceKind: "adjustment",
          operation: { kind: "set", valueFixedPoint: fixedPoint(value) },
        },
      }),
      admit,
    );
    if (adjusted.status !== "accepted") {
      throw new Error(`comparison world meter ${meterKey} was not accepted: ${JSON.stringify(adjusted)}`);
    }
  }

  // Calendar start is presentation configuration, not causal world state. The
  // branch's storySecond already encodes the legacy chat's current clock.
  await database.update(simWorlds).set({ calendarStart: input.calendarStart }).where(eq(simWorlds.id, worldId));

  return { worldId, branchId, playerActorId, primaryActorId };
}
