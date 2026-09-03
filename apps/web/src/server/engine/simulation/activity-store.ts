import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import {
  simulationActionDefinitionSchema,
  activitiesProjectionSchema,
  activityInstanceSchema,
  cancelActivityCommandResultSchema,
  cancelActivityCommandSchema,
  claimHoldingActivityPhases,
  completeActivityCommandResultSchema,
  completeActivityCommandSchema,
  startActivityCommandResultSchema,
  startActivityCommandSchema,
  type ActionResourceCost,
  type SimulationActionDefinition,
  type ActivitiesProjection,
  type ActivityInstance,
  type CancelActivityCommandResult,
  resumeActivityCommandSchema,
  resumeActivityCommandResultSchema,
  type ResumeActivityCommandResult,
  type CompleteActivityCommandResult,
  type StartActivityCommandResult,
} from "@vesper/simulation-core/contracts/activities";
import { worldBranchIdSchema } from "@vesper/simulation-core/contracts/identity";
import {
  activityCompletionUniquenessKey,
  resolveResumeActivity,
  heldClaimsForActor,
  resolveCancelActivity,
  resolveCompleteActivity,
  resolveStartActivity,
  type CompleteResolution,
} from "@vesper/simulation-core/activities";
import { engagementClaimsForActor } from "@vesper/simulation-core/engagements";
import { compareStableText } from "@vesper/simulation-core/hash";
import {
  buildItemConditionInitializedEvent,
  initialConditionMetersFor,
  type ItemConditionView,
} from "@vesper/simulation-core/material-condition";
import type { ConsumptionBodyView } from "@vesper/simulation-core/materials";
import {
  claimHoldingEngagementStates,
  engagementSchema,
} from "@vesper/simulation-core/contracts/engagements";
import {
  itemConditionRegistryVersion,
  type ItemConditionInitializedEvent,
} from "@vesper/simulation-core/contracts/material-condition";
import type { SimulationMaterialItem } from "@vesper/simulation-core/contracts/materials";
import { itemConditionThresholdTriggerKind } from "@vesper/simulation-core/contracts/scheduler";
import { resolveConsentCoverage } from "@vesper/simulation-core/social";
import type { RelationshipLedgerEntry } from "@vesper/simulation-core/contracts/social";
import {
  db,
  simActionDefinitions,
  simActivities,
  simBranches,
  simCharacters,
  simEngagements,
  simItemConditionMeters,
  simItemHoldings,
  simItems,
  simPhysicalLoci,
  simRelationshipLedger,
  simTriggers,
  simZones,
  type Db,
} from "@/server/db";
import {
  advanceLockedBranch,
  appendSimulationEvent,
  runSimulationCommand,
  type LockedBranchView,
} from "./command-runner";
import { loadConsumptionBodyView, retirePendingThresholdTriggers, upsertMeterRow } from "./body-rows";
import {
  loadItemConditionViews,
  retirePendingItemConditionThresholdTriggers,
  upsertItemConditionMeterValue,
} from "./item-condition-store";
import {
  materialItemFromRow,
  materialItemSelection,
  publishMaterialFeedObligation,
} from "./material-rows";
import { relationshipLedgerEntryFromRow } from "./social-recorder";
import { locusFromRow } from "./space-store";
import { applyTriggerScheduledEvent, type SimTx } from "./trigger-projector";

/**
 * E3.2 durable activity authority. Action definitions are branch-scoped
 * authored data; activity rows are event-projected state whose claims are
 * derived, never separately stored.
 */

export interface ActivityStoreOptions {
  database?: Db;
  admitAtLockedVersion?: boolean;
}

const actionDefinitionSeedSchema = z
  .object({
    branchId: worldBranchIdSchema,
    definitions: z.array(simulationActionDefinitionSchema).min(1),
  })
  .strict();

export type ActionDefinitionSeed = z.input<typeof actionDefinitionSeedSchema>;

/**
 * Seed or extend one branch's action catalog. Definitions are authored data
 * read only at start-resolution time; started events capture version and
 * claims, so replay never needs the catalog and adding to it mid-history is
 * safe.
 */
export async function seedDurableActionDefinitions(
  rawSeed: ActionDefinitionSeed,
  options: { database?: Db } = {},
): Promise<void> {
  const seed = actionDefinitionSeedSchema.parse(rawSeed);
  const database = options.database ?? db();
  await database.transaction(async (tx) => {
    const [branch] = await tx
      .select({ id: simBranches.id })
      .from(simBranches)
      .where(eq(simBranches.id, seed.branchId))
      .limit(1);
    if (!branch) throw new Error("Cannot seed action definitions onto an unavailable branch");
    await tx.insert(simActionDefinitions).values(
      seed.definitions.map((definition) => ({
        branchId: seed.branchId,
        actionDefinitionId: definition.id,
        version: definition.version,
        payload: definition,
      })),
    );
  });
}

export function activityFromRow(row: typeof simActivities.$inferSelect): ActivityInstance {
  return activityInstanceSchema.parse({
    id: row.activityInstanceId,
    actionDefinitionId: row.actionDefinitionId,
    actionVersion: row.actionVersion,
    actorIds: row.actorIds,
    zoneId: row.zoneId,
    phase: row.phase,
    ...(row.startedAt === null ? {} : { startedAt: row.startedAt }),
    ...(row.expectedCompleteAt === null ? {} : { expectedCompleteAt: row.expectedCompleteAt }),
    progressFixedPoint: row.progressFixedPoint,
    claims: row.claims,
    reservedItemIds: row.reservedItemIds,
    sourceCommandId: row.sourceCommandId,
  });
}

export function activityRowInsert(
  branchId: string,
  activity: ActivityInstance,
  updatedSequence: number,
): typeof simActivities.$inferInsert {
  return {
    branchId,
    activityInstanceId: activity.id,
    actionDefinitionId: activity.actionDefinitionId,
    actionVersion: activity.actionVersion,
    actorIds: [...activity.actorIds],
    zoneId: activity.zoneId,
    phase: activity.phase,
    startedAt: activity.startedAt ?? null,
    expectedCompleteAt: activity.expectedCompleteAt ?? null,
    progressFixedPoint: activity.progressFixedPoint,
    claims: [...activity.claims],
    reservedItemIds: [...activity.reservedItemIds],
    sourceCommandId: activity.sourceCommandId,
    updatedSequence,
  };
}

/** Assemble the typed activities projection inside a caller's transaction. */
export async function loadActivitiesProjection(tx: SimTx, branchId: string): Promise<ActivitiesProjection> {
  const [branch] = await tx
    .select({
      id: simBranches.id,
      headSequence: simBranches.headSequence,
      version: simBranches.version,
      storySecond: simBranches.storySecond,
    })
    .from(simBranches)
    .where(eq(simBranches.id, branchId))
    .limit(1);
  if (!branch) throw new Error("Simulation branch not found");
  const rows = await tx
    .select()
    .from(simActivities)
    .where(eq(simActivities.branchId, branchId))
    .orderBy(asc(simActivities.activityInstanceId));
  return activitiesProjectionSchema.parse({
    branchId,
    headSequence: branch.headSequence,
    version: branch.version,
    storySecond: branch.storySecond,
    activities: rows.map(activityFromRow),
  });
}

/** Load the current typed activities projection without a write lock, from one snapshot. */
export async function readDurableActivities(
  rawBranchId: string,
  database: Db = db(),
): Promise<ActivitiesProjection> {
  const branchId = worldBranchIdSchema.parse(rawBranchId);
  return database.transaction((tx) => loadActivitiesProjection(tx, branchId), {
    isolationLevel: "repeatable read",
    accessMode: "read only",
  });
}

async function loadDefinition(
  tx: SimTx,
  branchId: string,
  actionDefinitionId: string,
): Promise<SimulationActionDefinition | undefined> {
  const [row] = await tx
    .select({ payload: simActionDefinitions.payload })
    .from(simActionDefinitions)
    .where(
      and(
        eq(simActionDefinitions.branchId, branchId),
        eq(simActionDefinitions.actionDefinitionId, actionDefinitionId),
      ),
    )
    .limit(1);
  return row ? simulationActionDefinitionSchema.parse(row.payload) : undefined;
}

export async function loadClaimHoldingActivities(tx: SimTx, branchId: string): Promise<ActivityInstance[]> {
  const rows = await tx
    .select()
    .from(simActivities)
    .where(
      and(
        eq(simActivities.branchId, branchId),
        sql`${simActivities.phase} = ANY(ARRAY[${sql.join(
          claimHoldingActivityPhases.map((phase) => sql`${phase}`),
          sql`, `,
        )}]::text[])`,
      ),
    );
  return rows.map(activityFromRow);
}

/** Actors whose at-locus is the given zone, for witness capture. */
async function loadCoLocatedActorIds(
  tx: SimTx,
  branchId: string,
  zoneId: string,
  excludeActorIds: readonly string[],
): Promise<string[]> {
  const rows = await tx
    .select({ actorId: simPhysicalLoci.actorId })
    .from(simPhysicalLoci)
    .where(
      and(
        eq(simPhysicalLoci.branchId, branchId),
        eq(simPhysicalLoci.kind, "at"),
        eq(simPhysicalLoci.zoneId, zoneId),
      ),
    );
  return rows.map((row) => row.actorId).filter((actorId) => !excludeActorIds.includes(actorId));
}

/**
 * E5.5 slice 2: the (target → actor) directional ledger slice
 * a `consent_covered` precondition reads — narrowed to the three
 * consent-relevant kinds at the SQL layer, never the whole ledger.
 */
async function loadConsentDyadLedgerEntries(
  tx: SimTx,
  branchId: string,
  granterActorId: string,
  granteeActorId: string,
): Promise<RelationshipLedgerEntry[]> {
  const rows = await tx
    .select()
    .from(simRelationshipLedger)
    .where(
      and(
        eq(simRelationshipLedger.branchId, branchId),
        eq(simRelationshipLedger.fromActorId, granterActorId),
        eq(simRelationshipLedger.toActorId, granteeActorId),
        inArray(simRelationshipLedger.kind, ["boundary_stated", "permission_granted", "permission_withdrawn"]),
      ),
    );
  return rows.map(relationshipLedgerEntryFromRow);
}

// ---------------------------------------------------------------------------
// Material facts — loaded here rather than through
// material-store.ts's whole-branch `loadMaterialResolutionView` because both
// call sites already know exactly which items they need (the definition's
// requested kinds at start, the activity's own reservation at completion),
// so a scoped join keeps the load proportional instead of hydrating the
// world. Only the WHERE differs: the join shape and its row->item hydration
// are material-rows.ts's `materialItemSelection`/`materialItemFromRow`, the
// same pair the whole-branch view uses, so the two lanes cannot drift.
// ---------------------------------------------------------------------------

/**
 * Start-time eligibility: extant items whose `materialKindKey` matches
 * one of the definition's requested resource costs, joined to their current
 * holding locus. Scoped to the requested kinds — never the whole branch's
 * item graph — so a start with no `resourceCosts` issues no query at all.
 * Root resolution for a candidate resting in a container is out of this
 * slice's scope: `resolveRootLocus` fails a dangling container hop closed as
 * `cycle` (never selected), which is why start-time selection only ever
 * reaches items directly held/worn by the actor or resting at their zone.
 */
async function loadMaterialItemsByKind(
  tx: SimTx,
  branchId: string,
  materialKindKeys: readonly string[],
): Promise<Map<string, SimulationMaterialItem>> {
  const itemsById = new Map<string, SimulationMaterialItem>();
  if (materialKindKeys.length === 0) return itemsById;
  const rows = await tx
    .select(materialItemSelection)
    .from(simItems)
    .innerJoin(
      simItemHoldings,
      and(eq(simItemHoldings.branchId, simItems.branchId), eq(simItemHoldings.itemId, simItems.itemId)),
    )
    .where(and(eq(simItems.branchId, branchId), inArray(simItems.materialKindKey, [...materialKindKeys])));
  for (const row of rows) itemsById.set(row.itemId, materialItemFromRow(row));
  return itemsById;
}

/**
 * Completion-time re-validation + consumption: exactly the
 * activity's own reserved items (bounded by its resource costs, at most
 * 4 costs × 8 quantity) — never the whole branch.
 */
async function loadMaterialItemsByIds(
  tx: SimTx,
  branchId: string,
  itemIds: readonly string[],
): Promise<Map<string, SimulationMaterialItem>> {
  const itemsById = new Map<string, SimulationMaterialItem>();
  if (itemIds.length === 0) return itemsById;
  const rows = await tx
    .select(materialItemSelection)
    .from(simItems)
    .innerJoin(
      simItemHoldings,
      and(eq(simItemHoldings.branchId, simItems.branchId), eq(simItemHoldings.itemId, simItems.itemId)),
    )
    .where(and(eq(simItems.branchId, branchId), inArray(simItems.itemId, [...itemIds])));
  for (const row of rows) itemsById.set(row.itemId, materialItemFromRow(row));
  return itemsById;
}

/**
 * Mirrors `resolveCompleteActivity`'s own use-cost matching (`lib/simulation/
 * activities.ts`) exactly, so the store can learn — BEFORE calling the pure
 * resolver — precisely which reserved items will receive a use-condition
 * delta this completion. The resolver's own sequence numbering starts fresh
 * at `activity_completed`, so any lazy-init events these items need must be
 * built (and their sequence numbers reserved) ahead of that call; there is no
 * other seam to learn the set without either duplicating this matching or
 * calling the pure resolver twice.
 */
function wearConditionCandidateItemIds(
  resourceCosts: readonly ActionResourceCost[],
  reservedItemIds: readonly string[],
  materialItemById: (itemId: string) => SimulationMaterialItem | undefined,
): string[] {
  const useCosts = [...resourceCosts]
    .filter((cost) => cost.disposition === "use" && cost.useConditionDeltas.length > 0)
    .sort((a, b) => compareStableText(a.materialKindKey, b.materialKindKey));
  if (useCosts.length === 0) return [];
  const reservedIdsSorted = [...reservedItemIds].sort(compareStableText);
  const claimed = new Set<string>();
  const trackedIds: string[] = [];
  for (const cost of useCosts) {
    let taken = 0;
    for (const itemId of reservedIdsSorted) {
      if (taken >= cost.quantity) break;
      if (claimed.has(itemId)) continue;
      const item = materialItemById(itemId);
      if (!item || item.materialKindKey !== cost.materialKindKey) continue;
      claimed.add(itemId);
      taken += 1;
      if (item.conditionTracked) trackedIds.push(itemId);
    }
  }
  return trackedIds;
}

function rejectedResult<TCode extends string>(commandId: string, code: TCode, publicReason: string) {
  return {
    status: "rejected" as const,
    commandId,
    code,
    publicReason,
    legalAlternativeCommandTypes: [],
  };
}

/** Execute one StartActivity: started event + completion trigger + claims, atomically. */
export async function submitDurableStartActivity(
  rawCommand: unknown,
  options: ActivityStoreOptions = {},
): Promise<StartActivityCommandResult> {
  return runSimulationCommand({
    rawCommand,
    commandSchema: startActivityCommandSchema,
    resultSchema: startActivityCommandResultSchema,
    invalidResult: () => rejectedResult("invalid", "invalid_command", "That action request is invalid."),
    branchUnavailableResult: (commandId) =>
      rejectedResult(commandId, "branch_mismatch", "That world branch is unavailable."),
    duplicateCommandIdResult: (commandId) =>
      rejectedResult(commandId, "duplicate_command_id", "That action request has already been submitted."),
    conflictResult: (commandId, currentVersion) =>
      startActivityCommandResultSchema.parse({ status: "conflict", commandId, currentVersion, retryable: true }),
    database: options.database,
    admitAtLockedVersion: options.admitAtLockedVersion,
    execute: async (tx, branch: LockedBranchView, command) => {
      const [actorRow] = await tx
        .select({ characterId: simCharacters.characterId })
        .from(simCharacters)
        .where(
          and(eq(simCharacters.branchId, branch.id), eq(simCharacters.characterId, command.payload.actorId)),
        )
        .limit(1);
      const [locusRow] = await tx
        .select()
        .from(simPhysicalLoci)
        .where(
          and(eq(simPhysicalLoci.branchId, branch.id), eq(simPhysicalLoci.actorId, command.payload.actorId)),
        )
        .limit(1);
      const zoneRow =
        locusRow?.kind === "at" && locusRow.zoneId
          ? (
              await tx
                .select({ zoneId: simZones.zoneId, kind: simZones.kind, locationId: simZones.locationId })
                .from(simZones)
                .where(and(eq(simZones.branchId, branch.id), eq(simZones.zoneId, locusRow.zoneId)))
                .limit(1)
            )[0]
          : undefined;
      const definition = await loadDefinition(tx, branch.id, command.payload.actionDefinitionId);
      const claimHolding = await loadClaimHoldingActivities(tx, branch.id);
      const openEngagementRows = await tx
        .select()
        .from(simEngagements)
        .where(
          and(
            eq(simEngagements.branchId, branch.id),
            inArray(simEngagements.state, [...claimHoldingEngagementStates]),
          ),
        );
      const openEngagements = openEngagementRows.map((row) =>
        engagementSchema.parse({
          id: row.engagementId,
          participantIds: row.participantIds,
          channel: row.channel,
          ...(row.locationId === null ? {} : { locationId: row.locationId }),
          ...(row.zoneId === null ? {} : { zoneId: row.zoneId }),
          state: row.state,
          openedAt: row.openedAt,
          attentionClaim: row.attentionClaim,
          sourceCommandId: row.sourceCommandId,
        }),
      );
      const coLocatedActorIds = zoneRow
        ? await loadCoLocatedActorIds(tx, branch.id, zoneRow.zoneId, [command.payload.actorId])
        : [];

      // E5.5 slice 2: the consent-coverage pre-check — resolved here,
      // BEFORE `resolveStartActivity`, into a plain boolean the pure resolver
      // consumes (mirrors `heldClaims`/`coLocatedActorIds` already being
      // pre-resolved facts, not live queries). Only queried when the
      // definition actually gates on `consent_covered` AND a target was
      // named — an untargeted or unrelated start issues no ledger query.
      // `.find()` is safe here because `simulationActionDefinitionSchema`
      // rejects any definition with more than one `consent_covered`
      // precondition at load time — one scope per action, by construction.
      const consentPrecondition = definition?.preconditions.find(
        (precondition) => precondition.kind === "consent_covered",
      );
      const consentCovered =
        consentPrecondition && command.payload.targetActorId !== undefined
          ? resolveConsentCoverage({
              entries: await loadConsentDyadLedgerEntries(
                tx,
                branch.id,
                command.payload.targetActorId,
                command.payload.actorId,
              ),
              granterActorId: command.payload.targetActorId,
              granteeActorId: command.payload.actorId,
              scopeKey: consentPrecondition.scopeKey,
            })
          : false;

      // Eligibility scoped to the definition's requested material
      // kinds (a no-cost definition issues no query at all), and the live
      // reservation index built from the claim-holding activities already
      // loaded above for the claims check — no second query needed.
      const materialKindKeys = definition
        ? [...new Set(definition.resourceCosts.map((cost) => cost.materialKindKey))]
        : [];
      const materialItemsById = await loadMaterialItemsByKind(tx, branch.id, materialKindKeys);
      const reservingActivityIdByItem = new Map<string, string>();
      for (const holder of claimHolding) {
        for (const itemId of holder.reservedItemIds) reservingActivityIdByItem.set(itemId, holder.id);
      }

      const resolution = resolveStartActivity(
        {
          worldId: branch.worldId,
          branchId: branch.id,
          rulesetVersion: branch.rulesetVersion,
          headSequence: branch.headSequence,
          storySecond: branch.storySecond,
          actorExists: actorRow !== undefined,
          ...(locusRow ? { locus: locusFromRow(locusRow) } : {}),
          ...(zoneRow ? { actorZone: { id: zoneRow.zoneId, kind: zoneRow.kind, locationId: zoneRow.locationId } } : {}),
          ...(definition ? { definition } : {}),
          heldClaims: [
            ...heldClaimsForActor(claimHolding, command.payload.actorId),
            ...engagementClaimsForActor(openEngagements, command.payload.actorId),
          ],
          coLocatedActorIds,
          consentCovered,
          materialItemIds: [...materialItemsById.keys()],
          materialItemById: (itemId) => materialItemsById.get(itemId),
          reservingActivityId: (itemId) => reservingActivityIdByItem.get(itemId) ?? null,
        },
        command,
      );
      if (!resolution.ok) return rejectedResult(command.id, resolution.code, resolution.publicReason);

      const [startedEvent, triggerEvent] = resolution.events;
      await appendSimulationEvent(tx, startedEvent);
      await appendSimulationEvent(tx, triggerEvent);
      await applyTriggerScheduledEvent(tx, triggerEvent, { branchId: branch.id, worldId: branch.worldId });
      await tx.insert(simActivities).values(activityRowInsert(branch.id, resolution.activity, startedEvent.sequence));
      await advanceLockedBranch(tx, branch, triggerEvent.sequence);

      return {
        status: "accepted",
        commandId: command.id,
        branchVersion: branch.version + 1,
        firstSequence: startedEvent.sequence,
        lastSequence: triggerEvent.sequence,
        eventIds: [startedEvent.id, triggerEvent.id],
      };
    },
  });
}

/** Resolve one activity completion at its due second (trigger-dispatched). */
export async function submitDurableCompleteActivity(
  rawCommand: unknown,
  options: ActivityStoreOptions = {},
): Promise<CompleteActivityCommandResult> {
  return runSimulationCommand({
    rawCommand,
    commandSchema: completeActivityCommandSchema,
    resultSchema: completeActivityCommandResultSchema,
    invalidResult: () => rejectedResult("invalid", "invalid_command", "That completion request is invalid."),
    branchUnavailableResult: (commandId) =>
      rejectedResult(commandId, "branch_mismatch", "That world branch is unavailable."),
    duplicateCommandIdResult: (commandId) =>
      rejectedResult(commandId, "duplicate_command_id", "That completion has already been submitted."),
    conflictResult: (commandId, currentVersion) =>
      completeActivityCommandResultSchema.parse({ status: "conflict", commandId, currentVersion, retryable: true }),
    database: options.database,
    admitAtLockedVersion: options.admitAtLockedVersion,
    execute: async (tx, branch: LockedBranchView, command) => {
      const [activityRow] = await tx
        .select()
        .from(simActivities)
        .where(
          and(
            eq(simActivities.branchId, branch.id),
            eq(simActivities.activityInstanceId, command.payload.activityInstanceId),
          ),
        )
        .limit(1);
      const activity = activityRow ? activityFromRow(activityRow) : undefined;
      const definition = activity ? await loadDefinition(tx, branch.id, activity.actionDefinitionId) : undefined;
      const [zoneRow] = activity
        ? await tx
            .select({ locationId: simZones.locationId })
            .from(simZones)
            .where(and(eq(simZones.branchId, branch.id), eq(simZones.zoneId, activity.zoneId)))
            .limit(1)
        : [];
      const coLocatedActorIds = activity
        ? await loadCoLocatedActorIds(tx, branch.id, activity.zoneId, activity.actorIds)
        : [];

      // Fire-time re-validation needs every reserved item (bounded by the
      // activity's own reservation, never the whole branch). The consumption's
      // trailing body effects need the consuming actor's body ONLY when the
      // captured definition still names a consume-disposition cost — and
      // only when that body is actually initialized (an uninitialized body
      // still lets consumption complete, with zero body events).
      const materialItemsById =
        activity && activity.reservedItemIds.length > 0
          ? await loadMaterialItemsByIds(tx, branch.id, activity.reservedItemIds)
          : new Map<string, SimulationMaterialItem>();
      const primaryActorId = activity?.actorIds[0];
      const resourceCosts: readonly ActionResourceCost[] = definition?.resourceCosts ?? [];
      const hasConsumeCosts = resourceCosts.some((cost) => cost.disposition === "consume");
      // An uninitialized body is passed as NO view at all (rather than one
      // reporting `bodyInitialized: false`), so the resolver takes its
      // "consumption completes, zero trailing body events" path unchanged.
      const loadedBodyView =
        hasConsumeCosts && primaryActorId !== undefined
          ? await loadConsumptionBodyView(tx, branch.id, primaryActorId, branch.storySecond)
          : undefined;
      const bodyView: ConsumptionBodyView | undefined = loadedBodyView?.bodyInitialized
        ? loadedBodyView
        : undefined;

      // Learn — BEFORE calling the resolver — exactly which reserved
      // items will receive a use-condition delta this completion, so any
      // never-touched (LAZY init) ones among them get an `item_condition_
      // initialized` event built and sequenced ahead of `activity_completed`
      // itself (the resolver's own numbering starts fresh there and has no
      // room to interleave a lazy-init step; see `wearConditionCandidateItemIds`).
      const useTrackedItemIds = activity
        ? wearConditionCandidateItemIds(resourceCosts, activity.reservedItemIds, (itemId) =>
            materialItemsById.get(itemId),
          )
        : [];
      const existingConditionViews = await loadItemConditionViews(tx, branch.id, useTrackedItemIds);
      const uninitializedItemIds = useTrackedItemIds
        .filter((itemId) => !existingConditionViews.has(itemId))
        .sort(compareStableText);
      const freshMetersByItemId = new Map(
        uninitializedItemIds.map(
          (itemId) => [itemId, initialConditionMetersFor({ itemId, atStorySecond: branch.storySecond })] as const,
        ),
      );
      const conditionInitEvents: ItemConditionInitializedEvent[] = uninitializedItemIds.map((itemId, index) =>
        buildItemConditionInitializedEvent({
          view: {
            worldId: branch.worldId,
            branchId: branch.id,
            rulesetVersion: branch.rulesetVersion,
            headSequence: branch.headSequence,
            storySecond: branch.storySecond,
          },
          command,
          itemId,
          meters: freshMetersByItemId.get(itemId) ?? [],
          sequence: branch.headSequence + index + 1,
        }),
      );
      const itemConditionViewByItemId = (itemId: string): ItemConditionView | undefined => {
        const existing = existingConditionViews.get(itemId);
        if (existing) return existing;
        const fresh = freshMetersByItemId.get(itemId);
        if (!fresh) return undefined;
        return {
          itemId,
          registryVersion: fresh[0]?.registryVersion ?? itemConditionRegistryVersion,
          meters: fresh,
          modifiers: [],
        };
      };

      const resolution = resolveCompleteActivity(
        {
          worldId: branch.worldId,
          branchId: branch.id,
          rulesetVersion: branch.rulesetVersion,
          headSequence: branch.headSequence + conditionInitEvents.length,
          storySecond: branch.storySecond,
          ...(activity ? { activity } : {}),
          ...(zoneRow ? { zoneLocationId: zoneRow.locationId } : {}),
          ...(definition ? { noticeability: definition.noticeability } : {}),
          resourceCosts,
          materialItemById: (itemId) => materialItemsById.get(itemId),
          ...(bodyView ? { bodyView } : {}),
          itemConditionViewByItemId,
          coLocatedActorIds,
        },
        command,
      );
      if (!resolution.ok) return rejectedResult(command.id, resolution.code, resolution.publicReason);

      // Walk the resolved events in order, applying each one's side effect
      // right after appending it — the collapse-store multi-write idiom
      // (body-store.ts's `submitDurableResolveBodyCollapse`).
      // A meter's stale alarm is retired the moment its `body_source_applied`
      // lands, strictly before that same meter's re-arm `trigger_scheduled`
      // (its very next entry in the array) gets applied below. Any
      // item-condition lazy-init events precede everything else — they were
      // sequenced ahead of `activity_completed` itself, above.
      const allEvents: (ItemConditionInitializedEvent | CompleteResolution["events"][number])[] = [
        ...conditionInitEvents,
        ...resolution.events,
      ];
      let meterUpdateIndex = 0;
      let lastSequence = allEvents[0]?.sequence ?? resolution.events[0].sequence;
      for (const event of allEvents) {
        await appendSimulationEvent(tx, event);
        lastSequence = event.sequence;
        switch (event.type) {
          case "item_condition_initialized": {
            await tx.insert(simItemConditionMeters).values(
              event.payload.meters.map((meter) => ({
                branchId: branch.id,
                itemId: event.payload.itemId,
                meterKey: meter.meterKey,
                valueFixedPoint: meter.valueFixedPoint,
                baselineFixedPoint: meter.baselineFixedPoint,
                lastIntegratedAt: event.storySecond,
                registryVersion: event.payload.registryVersion,
                updatedSequence: event.sequence,
              })),
            );
            break;
          }
          case "activity_completed": {
            const [updated] = await tx
              .update(simActivities)
              .set({
                phase: "completed",
                progressFixedPoint: 1_000_000,
                updatedSequence: event.sequence,
              })
              .where(
                and(
                  eq(simActivities.branchId, branch.id),
                  eq(simActivities.activityInstanceId, event.payload.activityInstanceId),
                  eq(simActivities.phase, "active"),
                ),
              )
              .returning({ activityInstanceId: simActivities.activityInstanceId });
            if (!updated) throw new Error("Locked activity changed before its completion update");
            break;
          }
          case "item_consumed": {
            // The one locus this path ever writes — `gone/consumed` — so a
            // literal patch stands in for material-rows.ts's general
            // `holdingRowFieldsForLocus`, whose `updateItemLocus` wrapper
            // would re-derive the same five columns from a locus this case
            // already knows.
            const updatedHolding = await tx
              .update(simItemHoldings)
              .set({
                locusKind: "gone",
                actorId: null,
                slotKey: null,
                containerItemId: null,
                zoneId: null,
                goneBasis: "consumed",
                updatedSequence: event.sequence,
              })
              .where(
                and(eq(simItemHoldings.branchId, branch.id), eq(simItemHoldings.itemId, event.payload.itemId)),
              )
              .returning({ itemId: simItemHoldings.itemId });
            if (updatedHolding.length !== 1) {
              throw new Error("Locked item holding changed before its consumption update");
            }
            await publishMaterialFeedObligation(tx, event);
            break;
          }
          case "body_source_applied": {
            const meter = resolution.meterUpdates[meterUpdateIndex];
            meterUpdateIndex += 1;
            if (!meter) {
              throw new Error("Activity completion produced a body_source_applied event without a meter update");
            }
            await upsertMeterRow(tx, branch.id, meter, event.sequence);
            await retirePendingThresholdTriggers(
              tx,
              branch,
              command.id,
              command.submittedAtWallClock,
              event.payload.actorId,
              event.payload.meterKey,
            );
            break;
          }
          case "item_condition_source_applied": {
            await upsertItemConditionMeterValue(
              tx,
              branch.id,
              event.payload.itemId,
              event.payload.meterKey,
              event.payload.valueAfterFixedPoint,
              event.storySecond,
              event.sequence,
            );
            break;
          }
          case "item_condition_threshold_crossed": {
            // Event only: an instant crossing (the only kind this completion
            // path can ever produce — `wear`'s driftLaw is "none") always
            // immediately follows its own `item_condition_source_applied`
            // with the identical resulting value, so that case already wrote
            // the current meter row.
            break;
          }
          case "trigger_scheduled": {
            if (event.payload.kind === itemConditionThresholdTriggerKind) {
              // Retired here, not at `item_condition_source_applied` (unlike
              // bodies): wear's `driftLaw: "none"` means a delta does not
              // always produce a rearm, so retiring only when one actually
              // lands avoids a needless sweep on every delta.
              await retirePendingItemConditionThresholdTriggers(
                tx,
                branch,
                command.id,
                command.submittedAtWallClock,
                event.payload.command.payload.itemId,
                event.payload.command.payload.meterKey,
              );
            }
            await applyTriggerScheduledEvent(tx, event, { branchId: branch.id, worldId: branch.worldId });
            break;
          }
        }
      }
      await advanceLockedBranch(tx, branch, lastSequence);

      return {
        status: "accepted",
        commandId: command.id,
        branchVersion: branch.version + 1,
        firstSequence: allEvents[0]?.sequence ?? resolution.events[0].sequence,
        lastSequence,
        eventIds: allEvents.map((event) => event.id),
      };
    },
  });
}

/** Cancel one activity, releasing its claims and retiring its completion trigger. */
export async function submitDurableCancelActivity(
  rawCommand: unknown,
  options: ActivityStoreOptions = {},
): Promise<CancelActivityCommandResult> {
  return runSimulationCommand({
    rawCommand,
    commandSchema: cancelActivityCommandSchema,
    resultSchema: cancelActivityCommandResultSchema,
    invalidResult: () => rejectedResult("invalid", "invalid_command", "That cancellation request is invalid."),
    branchUnavailableResult: (commandId) =>
      rejectedResult(commandId, "branch_mismatch", "That world branch is unavailable."),
    duplicateCommandIdResult: (commandId) =>
      rejectedResult(commandId, "duplicate_command_id", "That cancellation has already been submitted."),
    conflictResult: (commandId, currentVersion) =>
      cancelActivityCommandResultSchema.parse({ status: "conflict", commandId, currentVersion, retryable: true }),
    database: options.database,
    admitAtLockedVersion: options.admitAtLockedVersion,
    execute: async (tx, branch: LockedBranchView, command) => {
      const [activityRow] = await tx
        .select()
        .from(simActivities)
        .where(
          and(
            eq(simActivities.branchId, branch.id),
            eq(simActivities.activityInstanceId, command.payload.activityInstanceId),
          ),
        )
        .limit(1);
      const activity = activityRow ? activityFromRow(activityRow) : undefined;
      const definition = activity ? await loadDefinition(tx, branch.id, activity.actionDefinitionId) : undefined;
      const [zoneRow] = activity
        ? await tx
            .select({ locationId: simZones.locationId })
            .from(simZones)
            .where(and(eq(simZones.branchId, branch.id), eq(simZones.zoneId, activity.zoneId)))
            .limit(1)
        : [];
      const coLocatedActorIds = activity
        ? await loadCoLocatedActorIds(tx, branch.id, activity.zoneId, activity.actorIds)
        : [];

      const resolution = resolveCancelActivity(
        {
          worldId: branch.worldId,
          branchId: branch.id,
          rulesetVersion: branch.rulesetVersion,
          headSequence: branch.headSequence,
          storySecond: branch.storySecond,
          ...(activity ? { activity } : {}),
          ...(definition
            ? { interruptibility: definition.interruptibility, noticeability: definition.noticeability }
            : {}),
          ...(zoneRow ? { zoneLocationId: zoneRow.locationId } : {}),
          coLocatedActorIds,
        },
        command,
      );
      if (!resolution.ok) return rejectedResult(command.id, resolution.code, resolution.publicReason);

      await appendSimulationEvent(tx, resolution.event);
      const [updated] = await tx
        .update(simActivities)
        .set({ phase: "cancelled", updatedSequence: resolution.event.sequence })
        .where(
          and(
            eq(simActivities.branchId, branch.id),
            eq(simActivities.activityInstanceId, resolution.activity.id),
          ),
        )
        .returning({ activityInstanceId: simActivities.activityInstanceId });
      if (!updated) throw new Error("Locked activity changed before its cancellation update");

      // Retire the pending completion trigger in the same transaction so it
      // can never fire against the cancelled activity.
      // Prefix-matched: a resumed activity's alarm carries an attempt-
      // versioned key the un-versioned key is a strict prefix of (E5.2).
      await tx
        .update(simTriggers)
        .set({
          state: "completed",
          resultCommandId: command.id,
          completedAt: new Date(command.submittedAtWallClock),
        })
        .where(
          and(
            eq(simTriggers.branchId, branch.id),
            eq(simTriggers.state, "pending"),
            sql`starts_with(${simTriggers.uniquenessKey}, ${activityCompletionUniquenessKey(resolution.activity.id)})`,
          ),
        );
      await advanceLockedBranch(tx, branch, resolution.event.sequence);

      return {
        status: "accepted",
        commandId: command.id,
        branchVersion: branch.version + 1,
        firstSequence: resolution.event.sequence,
        lastSequence: resolution.event.sequence,
        eventIds: [resolution.event.id],
      };
    },
  });
}

/** Pick an interrupted activity back up (E5.2 — the E3.4 re-arm note landed). */
export async function submitDurableResumeActivity(
  rawCommand: unknown,
  options: ActivityStoreOptions = {},
): Promise<ResumeActivityCommandResult> {
  return runSimulationCommand({
    rawCommand,
    commandSchema: resumeActivityCommandSchema,
    resultSchema: resumeActivityCommandResultSchema,
    invalidResult: () => rejectedResult("invalid", "invalid_command", "That resumption request is invalid."),
    branchUnavailableResult: (commandId) =>
      rejectedResult(commandId, "branch_mismatch", "That world branch is unavailable."),
    duplicateCommandIdResult: (commandId) =>
      rejectedResult(commandId, "duplicate_command_id", "That resumption has already been submitted."),
    conflictResult: (commandId, currentVersion) =>
      resumeActivityCommandResultSchema.parse({ status: "conflict", commandId, currentVersion, retryable: true }),
    database: options.database,
    admitAtLockedVersion: options.admitAtLockedVersion,
    execute: async (tx, branch: LockedBranchView, command) => {
      const [activityRow] = await tx
        .select()
        .from(simActivities)
        .where(
          and(
            eq(simActivities.branchId, branch.id),
            eq(simActivities.activityInstanceId, command.payload.activityInstanceId),
          ),
        )
        .limit(1);
      const activity = activityRow ? activityFromRow(activityRow) : undefined;
      const [zoneRow] = activity
        ? await tx
            .select({ locationId: simZones.locationId })
            .from(simZones)
            .where(and(eq(simZones.branchId, branch.id), eq(simZones.zoneId, activity.zoneId)))
            .limit(1)
        : [];

      const resolution = resolveResumeActivity(
        {
          worldId: branch.worldId,
          branchId: branch.id,
          rulesetVersion: branch.rulesetVersion,
          headSequence: branch.headSequence,
          storySecond: branch.storySecond,
          ...(activity ? { activity } : {}),
          ...(zoneRow ? { zoneLocationId: zoneRow.locationId } : {}),
        },
        command,
      );
      if (!resolution.ok) return rejectedResult(command.id, resolution.code, resolution.publicReason);

      const [resumedEvent, triggerEvent] = resolution.events;
      await appendSimulationEvent(tx, resumedEvent);
      await appendSimulationEvent(tx, triggerEvent);
      await applyTriggerScheduledEvent(tx, triggerEvent, { branchId: branch.id, worldId: branch.worldId });
      const [updated] = await tx
        .update(simActivities)
        .set({
          phase: "active",
          expectedCompleteAt: resolution.activity.expectedCompleteAt ?? null,
          startedAt: resolution.activity.startedAt ?? null,
          updatedSequence: triggerEvent.sequence,
        })
        .where(
          and(
            eq(simActivities.branchId, branch.id),
            eq(simActivities.activityInstanceId, resolution.activity.id),
          ),
        )
        .returning({ activityInstanceId: simActivities.activityInstanceId });
      if (!updated) throw new Error("Locked activity changed before its resumption update");
      await advanceLockedBranch(tx, branch, triggerEvent.sequence);

      return {
        status: "accepted",
        commandId: command.id,
        branchVersion: branch.version + 1,
        firstSequence: resumedEvent.sequence,
        lastSequence: triggerEvent.sequence,
        eventIds: [resumedEvent.id, triggerEvent.id],
      };
    },
  });
}
