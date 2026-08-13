import { eq } from "drizzle-orm";
import { z } from "zod";
import { jsonError, jsonOk, readBody, withOwnerAdmin } from "@/server/api";
import { db, simWorlds } from "@/server/db";
import {
  seedDurableActionDefinitions,
  seedDurableBodyRhythms,
  seedDurableMaterialBranch,
  seedDurableSpaceTopology,
  submitDurableAssignActorLod,
  submitDurableCreateCohort,
  submitDurableInitializeActorBody,
} from "@/server/engine";

const bodySchema = z
  .object({
    world: z.record(z.string(), z.unknown()),
    topology: z.record(z.string(), z.unknown()),
    rhythms: z.array(z.record(z.string(), z.unknown())).max(64).optional(),
    actionDefinitions: z.array(z.record(z.string(), z.unknown())).max(64).optional(),
    embodyActorIds: z.array(z.string().min(1).max(256)).max(64).optional(),
    lods: z
      .array(
        z
          .object({
            actorId: z.string().min(1).max(256),
            simulationLod: z.string().min(1).max(32),
            inferenceLod: z.string().min(1).max(32),
          })
          .strict(),
      )
      .max(64)
      .optional(),
    cohorts: z.array(z.record(z.string(), z.unknown())).max(32).optional(),
  })
  .strict();

/** Provision a development world through the explicit owner-admin namespace. */
export const POST = withOwnerAdmin(async (user, req) => {
  const body = await readBody(req, bodySchema);
  if (!body.ok) return body.response;
  const seed = body.value;
  const worldId = typeof seed.world.worldId === "string" ? seed.world.worldId : "";
  const branchId = typeof seed.world.branchId === "string" ? seed.world.branchId : "";
  if (!worldId || !branchId) return jsonError("invalid_seed", "world.worldId and world.branchId are required", 400);
  const [existing] = await db().select({ id: simWorlds.id }).from(simWorlds).where(eq(simWorlds.id, worldId)).limit(1);
  if (existing) return jsonError("world_exists", "that sim world already exists", 409);

  const envelope = (name: string, payload: Record<string, unknown>) => ({
    id: `sim-provision-${name}-${branchId}`,
    branchId,
    expectedVersion: 0,
    idempotencyKey: `sim-provision-${name}-${branchId}`,
    principal: { kind: "storyteller" as const, principalId: user.id, controlledActorIds: [] },
    submittedAtWallClock: new Date().toISOString(),
    correlationId: `sim-provision-${branchId}`,
    schemaVersion: 1,
    ...payload,
  });

  try {
    await seedDurableMaterialBranch(seed.world);
    await seedDurableSpaceTopology({ ...seed.topology, branchId } as unknown as Parameters<typeof seedDurableSpaceTopology>[0]);
    if (seed.rhythms && seed.rhythms.length > 0) {
      await seedDurableBodyRhythms({ branchId, rows: seed.rhythms } as unknown as Parameters<typeof seedDurableBodyRhythms>[0]);
    }
    if (seed.actionDefinitions && seed.actionDefinitions.length > 0) {
      await seedDurableActionDefinitions({ branchId, definitions: seed.actionDefinitions } as unknown as Parameters<typeof seedDurableActionDefinitions>[0]);
    }
    for (const [index, actorId] of (seed.embodyActorIds ?? []).entries()) {
      const outcome = await submitDurableInitializeActorBody(
        envelope(`embody-${index}`, {
          type: "initialize_actor_body",
          payload: { actorId, registryVersion: "body-v1", baselineOverrides: {} },
        }),
        { admitAtLockedVersion: true },
      );
      if (outcome.status !== "accepted") {
        return jsonError("seed_step_rejected", `embody ${actorId}: ${"code" in outcome ? outcome.code : outcome.status}`, 400);
      }
    }
    for (const [index, lod] of (seed.lods ?? []).entries()) {
      const outcome = await submitDurableAssignActorLod(
        envelope(`lod-${index}`, { type: "assign_actor_lod", payload: lod }),
        { admitAtLockedVersion: true },
      );
      if (outcome.status !== "accepted") {
        return jsonError("seed_step_rejected", `lod ${lod.actorId}: ${"code" in outcome ? outcome.code : outcome.status}`, 400);
      }
    }
    for (const [index, cohort] of (seed.cohorts ?? []).entries()) {
      const outcome = await submitDurableCreateCohort(
        envelope(`cohort-${index}`, { type: "create_cohort", payload: { cohort } }),
        { admitAtLockedVersion: true },
      );
      if (outcome.status !== "accepted") {
        return jsonError("seed_step_rejected", `cohort ${index}: ${"code" in outcome ? outcome.code : outcome.status}`, 400);
      }
    }
  } catch (err) {
    return jsonError("invalid_seed", err instanceof Error ? err.message : "seed rejected", 400);
  }
  return jsonOk({ worldId, branchId }, 201);
});
