import { z } from "zod";
import { newId } from "@/lib/ids";
import { jsonError, jsonOk, readBody, withUser } from "@/server/api";
import { db, simBranches } from "@/server/db";
import { eq } from "drizzle-orm";
import {
  advanceBranchStoryTime,
  submitDurableAdjustCohort,
  submitDurableAssignActorLod,
  submitDurablePromoteActorFromCohort,
  submitDurableStorytellerRelocation,
} from "@/server/engine";

type Params = { branchId: string };

/**
 * R3 slice 3 — the storyteller tool palette as ONE discriminated admin route:
 * audited relocation (ruling 4), §27.2 promote-from-cohort, the E6.1 LOD
 * dial, conserved cohort adjustment, and the bounded story-clock advance.
 * Every world change is the ordinary durable command under the storyteller
 * principal; refusals return the public face. Admin-only, 404-hidden.
 */

const bodySchema = z.discriminatedUnion("kind", [
  z
    .object({ kind: z.literal("relocate"), actorId: z.string().min(1), destinationZoneId: z.string().min(1), reason: z.string().trim().min(1).max(500) })
    .strict(),
  z
    .object({
      kind: z.literal("promote"),
      cohortId: z.string().min(1),
      zoneId: z.string().min(1),
      name: z.string().trim().min(1).max(200).optional(),
      landing: z.object({ simulationLod: z.string().min(1), inferenceLod: z.string().min(1) }).strict(),
    })
    .strict(),
  z
    .object({ kind: z.literal("assign_lod"), actorId: z.string().min(1), simulationLod: z.string().min(1), inferenceLod: z.string().min(1) })
    .strict(),
  z
    .object({ kind: z.literal("adjust_cohort"), cohortId: z.string().min(1), deltaCount: z.number().int(), reason: z.string().min(1) })
    .strict(),
  z
    .object({ kind: z.literal("advance"), days: z.number().positive().max(30).optional(), toStorySecond: z.number().int().positive().optional() })
    .strict()
    .refine((body) => body.days !== undefined || body.toStorySecond !== undefined, { message: "days or toStorySecond required" }),
]);

interface CommandOutcome {
  status: string;
  code?: string;
  publicReason?: string;
}

function respond(outcome: CommandOutcome) {
  if (outcome.status === "accepted") return jsonOk({ status: "accepted" });
  if (outcome.status === "rejected") {
    return jsonOk({ status: "rejected", code: outcome.code, publicReason: outcome.publicReason }, 409);
  }
  return jsonError("sim_conflict", "the world moved; try again", 409);
}

export const POST = withUser<Params>(async (user, req, ctx) => {
  if (user.role !== "admin") return jsonError("not_found", "not found", 404);
  const { branchId } = await ctx.params;
  const body = await readBody(req, bodySchema);
  if (!body.ok) return body.response;
  const command = body.value;
  const envelope = {
    id: newId(),
    branchId,
    expectedVersion: 0,
    idempotencyKey: newId(),
    principal: { kind: "storyteller" as const, principalId: user.id, controlledActorIds: [] },
    submittedAtWallClock: new Date().toISOString(),
    correlationId: `sim-admin-${branchId}`,
    schemaVersion: 1,
  };

  switch (command.kind) {
    case "relocate":
      return respond(
        await submitDurableStorytellerRelocation(
          {
            ...envelope,
            type: "storyteller_relocate_actor",
            payload: { actorId: command.actorId, destinationZoneId: command.destinationZoneId, reason: command.reason },
          },
          { admitAtLockedVersion: true },
        ),
      );
    case "promote":
      return respond(
        await submitDurablePromoteActorFromCohort(
          {
            ...envelope,
            type: "promote_actor_from_cohort",
            payload: {
              cohortId: command.cohortId,
              zoneId: command.zoneId,
              ...(command.name === undefined ? {} : { name: command.name }),
              landing: command.landing,
            },
          },
          { admitAtLockedVersion: true },
        ),
      );
    case "assign_lod":
      return respond(
        await submitDurableAssignActorLod(
          {
            ...envelope,
            type: "assign_actor_lod",
            payload: { actorId: command.actorId, simulationLod: command.simulationLod, inferenceLod: command.inferenceLod },
          },
          { admitAtLockedVersion: true },
        ),
      );
    case "adjust_cohort":
      return respond(
        await submitDurableAdjustCohort(
          {
            ...envelope,
            type: "adjust_cohort",
            payload: { cohortId: command.cohortId, deltaCount: command.deltaCount, reason: command.reason },
          },
          { admitAtLockedVersion: true },
        ),
      );
    case "advance": {
      const [branch] = await db()
        .select({ storySecond: simBranches.storySecond })
        .from(simBranches)
        .where(eq(simBranches.id, branchId))
        .limit(1);
      if (!branch) return jsonError("not_found", "branch not found", 404);
      const target =
        command.toStorySecond ?? branch.storySecond + Math.round((command.days ?? 0) * 86_400);
      if (target < branch.storySecond) return jsonError("invalid_target", "story time cannot move backwards", 400);
      let drained = 0;
      for (let calls = 0; ; calls += 1) {
        if (calls > 1_000) return jsonError("drain_diverged", "the drain did not converge", 500);
        const outcome = await advanceBranchStoryTime(branchId, target, { workerId: `sim-admin-${newId()}` });
        drained += outcome.drained;
        if (outcome.status === "advanced") break;
      }
      return jsonOk({ status: "advanced", toStorySecond: target, drained });
    }
  }
});
