import { and, eq } from "drizzle-orm";
import { jsonError, jsonOk } from "@/server/api";
import {
  db,
  simActorLods,
  simBranches,
  simCharacters,
  simCohorts,
  simPhysicalLoci,
  simTriggers,
} from "@/server/db";
import { withSelfOwnedBranch } from "../owned";

type Params = { branchId: string };

/** Self-scoped simulation status for a branch linked to the administrator's own chat. */
export const GET = withSelfOwnedBranch<Params>(async (_user, owned) => {
  const branchId = owned.branchId;
  const [branch] = await db()
    .select({ storySecond: simBranches.storySecond, headSequence: simBranches.headSequence, version: simBranches.version })
    .from(simBranches)
    .where(eq(simBranches.id, branchId))
    .limit(1);
  if (!branch) return jsonError("not_found", "branch not found", 404);

  const [actors, loci, lods, cohorts, pending] = await Promise.all([
    db().select({ characterId: simCharacters.characterId, name: simCharacters.name }).from(simCharacters).where(eq(simCharacters.branchId, branchId)),
    db().select({ actorId: simPhysicalLoci.actorId, kind: simPhysicalLoci.kind, zoneId: simPhysicalLoci.zoneId }).from(simPhysicalLoci).where(eq(simPhysicalLoci.branchId, branchId)),
    db().select({ actorId: simActorLods.actorId, simulationLod: simActorLods.simulationLod, inferenceLod: simActorLods.inferenceLod }).from(simActorLods).where(eq(simActorLods.branchId, branchId)),
    db().select({ cohortId: simCohorts.cohortId, name: simCohorts.name, population: simCohorts.population }).from(simCohorts).where(eq(simCohorts.branchId, branchId)),
    db().select({ id: simTriggers.id }).from(simTriggers).where(and(eq(simTriggers.branchId, branchId), eq(simTriggers.state, "pending"))),
  ]);
  const locusByActor = new Map(loci.map((row) => [row.actorId, row]));
  const lodByActor = new Map(lods.map((row) => [row.actorId, row]));
  return jsonOk({
    branchId,
    storySecond: branch.storySecond,
    headSequence: branch.headSequence,
    version: branch.version,
    pendingTriggers: pending.length,
    actors: actors.map((actor) => ({
      id: actor.characterId,
      name: actor.name,
      locus: locusByActor.get(actor.characterId) ?? null,
      lod: lodByActor.get(actor.characterId) ?? null,
    })),
    cohorts,
  });
});
