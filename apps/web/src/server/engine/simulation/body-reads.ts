import { and, asc, eq } from "drizzle-orm";
import {
  bodyMeterRegistryByVersion,
  bodyRegistryVersionSchema,
} from "@vesper/simulation-core/contracts/bodies";
import { worldBranchIdSchema } from "@vesper/simulation-core/contracts/identity";
import {
  buildMeterView,
  integrateMeterValue,
  lastSleepEndedAtOf,
} from "@vesper/simulation-core/bodies";
import {
  deriveCircadianPressure,
  deriveEnergyRead,
  deriveIntimacyRead,
  deriveVisibleBodySigns,
  type EnergyRead,
} from "@vesper/simulation-core/body-reads";
import { cutBodilyReadsSchema, type CutBodilyReads } from "@vesper/simulation-core/contracts/narrative";
import {
  db,
  simBodyConditions,
  simBodyMeters,
  simBodyModifiers,
  simBodyRhythms,
  simBranches,
  type Db,
} from "@/server/db";
import {
  bodyMeterFromRow,
  bodyModifierFromRow,
  bodyRhythmFromRow,
  loadActorBody,
  type DbExecutor,
} from "./body-rows";

// ---------------------------------------------------------------------------
// E5.2 — the durable read surface
// ---------------------------------------------------------------------------

export interface DurableEnergyRead {
  actorId: string;
  reserveFixedPoint: number;
  pressureFixedPoint: number;
  read: EnergyRead;
}

/**
 * Per-actor energy reads at the branch's current story second: reserve
 * integrated purely (nothing persists), circadian pressure derived from the
 * actor's own rhythm and last real sleep, the signed axis clamped at its
 * saturating poles. Layer-3 only — the raw meters never leave this seam.
 */
export async function readDurableBodyReads(
  rawBranchId: string,
  database: Db = db(),
): Promise<{ branchId: string; storySecond: number; energy: DurableEnergyRead[] }> {
  const branchId = worldBranchIdSchema.parse(rawBranchId);
  const [branch] = await database
    .select({ storySecond: simBranches.storySecond })
    .from(simBranches)
    .where(eq(simBranches.id, branchId))
    .limit(1);
  if (!branch) throw new Error("Simulation branch not found");
  const [meterRows, modifierRows, rhythmRows, conditionRows] = await Promise.all([
    database
      .select()
      .from(simBodyMeters)
      .where(and(eq(simBodyMeters.branchId, branchId), eq(simBodyMeters.meterKey, "energy")))
      .orderBy(asc(simBodyMeters.actorId)),
    database
      .select()
      .from(simBodyModifiers)
      .where(and(eq(simBodyModifiers.branchId, branchId), eq(simBodyModifiers.meterKey, "energy"))),
    database.select().from(simBodyRhythms).where(eq(simBodyRhythms.branchId, branchId)),
    database
      .select()
      .from(simBodyConditions)
      .where(and(eq(simBodyConditions.branchId, branchId), eq(simBodyConditions.key, "asleep"))),
  ]);
  const energy: DurableEnergyRead[] = [];
  for (const meterRow of meterRows) {
    const state = bodyMeterFromRow(meterRow);
    const parsedVersion = bodyRegistryVersionSchema.safeParse(state.registryVersion);
    if (!parsedVersion.success) continue;
    const definition = bodyMeterRegistryByVersion[parsedVersion.data].find(
      (candidate) => candidate.key === "energy",
    );
    if (!definition) continue;
    const reserveFixedPoint = integrateMeterValue(
      {
        definition,
        state,
        modifiers: modifierRows
          .filter((row) => row.actorId === state.actorId)
          .map(bodyModifierFromRow),
      },
      branch.storySecond,
    );
    const lastSleepEndedAt = conditionRows
      .filter((row) => row.actorId === state.actorId && row.status === "ended" && row.endedAt !== null)
      .reduce<number | undefined>(
        (latest, row) => (latest === undefined || (row.endedAt ?? 0) > latest ? (row.endedAt ?? 0) : latest),
        undefined,
      );
    const pressureFixedPoint = deriveCircadianPressure({
      atStorySecond: branch.storySecond,
      rhythmRows: rhythmRows.filter((row) => row.actorId === state.actorId).map(bodyRhythmFromRow),
      ...(lastSleepEndedAt === undefined ? {} : { lastSleepEndedAtStorySecond: lastSleepEndedAt }),
    });
    energy.push({
      actorId: state.actorId,
      reserveFixedPoint,
      pressureFixedPoint,
      read: deriveEnergyRead({ reserveFixedPoint, pressureFixedPoint }),
    });
  }
  return { branchId, storySecond: branch.storySecond, energy };
}

/**
 * E5.2 — the cut's body surface (`bodilyReads`): the viewpoint's own
 * energy read and intimacy pulse, plus each co-present actor's perceivable
 * signs at engaged-attention tier. Pure over loaded rows; empty when bodies
 * are uninitialized, so pre-Gate-5 worlds compile identical cuts.
 */
export async function computeEngagementBodilyReads(
  executor: DbExecutor,
  input: {
    branchId: string;
    storySecond: number;
    viewpointActorId: string;
    coPresentActorIds: readonly string[];
  },
): Promise<CutBodilyReads> {
  const actorIds = [...new Set([input.viewpointActorId, ...input.coPresentActorIds])];
  const bodies = new Map(
    await Promise.all(
      actorIds.map(
        async (actorId) => [actorId, await loadActorBody(executor, input.branchId, actorId)] as const,
      ),
    ),
  );

  const readOf = (actorId: string) => {
    const body = bodies.get(actorId);
    if (!body) return undefined;
    const energyView = buildMeterView(body, "energy", input.storySecond);
    if (!energyView) return undefined;
    const reserveFixedPoint = integrateMeterValue(energyView, input.storySecond);
    const lastSleepEndedAt = lastSleepEndedAtOf(body.conditions);
    const pressureFixedPoint = deriveCircadianPressure({
      atStorySecond: input.storySecond,
      rhythmRows: body.rhythms,
      ...(lastSleepEndedAt === undefined ? {} : { lastSleepEndedAtStorySecond: lastSleepEndedAt }),
    });
    const arousalView = buildMeterView(body, "arousal", input.storySecond);
    return {
      energyRead: deriveEnergyRead({ reserveFixedPoint, pressureFixedPoint }),
      arousalFixedPoint: arousalView ? integrateMeterValue(arousalView, input.storySecond) : 0,
      afterglowActive: body.conditions.some(
        (condition) => condition.status === "active" && condition.key === "afterglow",
      ),
    };
  };

  const selfRead = readOf(input.viewpointActorId);
  const observed: { actorId: string; signs: ReturnType<typeof deriveVisibleBodySigns> }[] = [];
  for (const actorId of input.coPresentActorIds) {
    if (actorId === input.viewpointActorId) continue;
    const read = readOf(actorId);
    if (!read) continue;
    const signs = deriveVisibleBodySigns({ ...read, detailTier: 3 });
    if (signs.length > 0) observed.push({ actorId, signs });
  }
  return cutBodilyReadsSchema.parse({
    ...(selfRead === undefined
      ? {}
      : {
          self: {
            energySignedFixedPoint: selfRead.energyRead.signedFixedPoint,
            energyBand: selfRead.energyRead.band,
            intimacyPhase: deriveIntimacyRead(selfRead),
          },
        }),
    observed,
  });
}
