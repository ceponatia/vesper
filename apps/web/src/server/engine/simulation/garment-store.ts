import {
  applyGarmentOperationCommandResultSchema,
  applyGarmentOperationCommandSchema,
  garmentOperationAppliedEventSchema,
  type ApplyGarmentOperationCommand,
  type ApplyGarmentOperationCommandResult,
  type ApplyGarmentOperationRejectionCode,
} from "@vesper/simulation-core/contracts/garments";
import { composeSimulationId } from "@vesper/simulation-core/contracts/identity";
import {
  containerAccessAllowed,
  resolveRootLocus,
  rootZoneId,
} from "@vesper/simulation-core/materials";
import {
  applyGarmentOperations,
  DiagnosticCollector,
  emptyChatGarmentStore,
  garmentOperationSchema,
  pristineGarmentConditionVector,
  sameGarmentCondition,
  sameGarmentPresentation,
  type ChatGarmentStore,
  type GarmentBlueprint,
  type GarmentConditionOverride,
  type GarmentConditionState,
  type GarmentInstanceState,
  type GarmentOperation,
  type GarmentPresentationState,
} from "@/contracts";
import type { Db } from "@/server/db";
import {
  advanceLockedBranch,
  appendSimulationEvent,
  runSimulationCommand,
  type LockedBranchView,
} from "./command-runner";
import { readItemGarmentInstance } from "./garment-reads";
import { upsertItemGarmentStateRow } from "./garment-rows";
import { loadMaterialResolutionView } from "./material-store";
import type { SimTx } from "./trigger-projector";

/**
 * #296 — the durable garment-operation command.
 *
 * An actor rearranges or marks a garment: a sleeve rolled, a placket opened,
 * rain on a coat, mud on a hem, a torn cuff. One command, one event, one
 * projection row, inside the shared locked transaction — modelled on
 * `submitDurableApplyItemConditionSource` (material-store.ts).
 *
 * ## The three laws this file exists to hold
 *
 * **1. Nothing writes `sim_item_garment_state` outside the event stream.** The
 * row is a projection of `garment_operation_applied`, and this command is the
 * only writer besides fork materialization (branch-store.ts), which replays the
 * same events through the same fold. A projection written from anywhere else
 * would make every fork of a dressed world disagree with its own history.
 *
 * **2. The event records the RESULT, and the row is written from exactly that
 * value.** The reducer runs ONCE, here, under the branch lock; the state it
 * produces is stamped into the event payload and the row from a single
 * variable, so the projector re-applying the event cannot land anywhere else.
 * Re-running the reducer at replay time would tie every historical outcome to
 * today's reducer, today's material coefficients and today's blueprint static.
 *
 * **3. One owner per channel.** `sim_item_holdings` owns where a garment is;
 * `item-condition-v1` meters own its cleanliness and wear; this projection owns
 * presentation, wetness, crease, deposits and damage marks. An operation that
 * addresses somebody else's channel is REFUSED here rather than half-applied —
 * see {@link OPERATION_OWNER_COMMAND} — and the two channels a supported
 * operation writes as a side effect are stripped back to their defaults before
 * anything is recorded (see {@link recordableCondition}).
 */

export interface GarmentStoreOptions {
  database?: Db;
  /** See `runSimulationCommand` — admit at whatever version the lock finds. */
  admitAtLockedVersion?: boolean;
}

function rejectedResult(
  commandId: string,
  code: ApplyGarmentOperationRejectionCode,
  publicReason: string,
  legalAlternativeCommandTypes: readonly string[] = [],
): ApplyGarmentOperationCommandResult {
  return {
    status: "rejected",
    commandId,
    code,
    publicReason,
    legalAlternativeCommandTypes: [...legalAlternativeCommandTypes],
  };
}

// ---------------------------------------------------------------------------
// Owner routing
// ---------------------------------------------------------------------------

/**
 * The operation kinds another command owns, and which one.
 *
 * `transfer` moves a garment, which is `transfer_item`'s whole job — including
 * the worn-window modifier that arms cleanliness drift on donning, which this
 * command has no way to arm. `clean` and an `apply_condition` on cleanliness or
 * wear address the `item-condition-v1` meters, whose owner is
 * `apply_item_condition_source`. Applying either here would produce a second
 * writer for a channel that already has one, and the two would then disagree
 * the moment one of them was replayed and the other was not.
 */
const OPERATION_OWNER_COMMAND: Readonly<Record<string, string>> = {
  transfer: "transfer_item",
  clean: "apply_item_condition_source",
};

/** The owner command for an operation this command may not apply, or undefined. */
function ownerCommandFor(operation: GarmentOperation): string | undefined {
  const byKind = OPERATION_OWNER_COMMAND[operation.kind];
  if (byKind !== undefined) return byKind;
  if (operation.kind === "apply_condition" && (operation.channel === "cleanliness" || operation.channel === "wear")) {
    return "apply_item_condition_source";
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// The recordable state
// ---------------------------------------------------------------------------

const PRISTINE_CONDITION_VECTOR = pristineGarmentConditionVector();

/**
 * The condition this projection may RECORD: everything it owns, with the two
 * channels it does NOT own put back to their defaults.
 *
 * `deposit`, `accept_transfer` and `damage` are this command's business, and
 * each of them writes `cleanliness` or `wear` as a SIDE EFFECT of the fact it
 * records — a stain soils where it landed, a tear ages the garment. In the chat
 * lane that is right, because there the garment store owns all four channels.
 * Here those two belong to `item-condition-v1`, and the read adapter
 * (`garment-reads.ts`) copies the integrated meter over the stored base on
 * every read — so a value left in this row would be authored, persisted,
 * replayed, forked, and then silently discarded at the only moment anyone looks
 * at it. Worse, it would be a SECOND opinion about a channel that already has
 * an owner, and the two would diverge the first time one of them moved.
 *
 * Region overrides are stripped on the same two channels for a subtler reason:
 * the reducer prunes an override against the base it just wrote, so a per-part
 * `cleanliness` that happened to equal the lowered base is dropped, and
 * restoring the base afterwards would resurrect that part as clean. Carrying a
 * per-part opinion on a channel whose base comes from somewhere else is not a
 * gradient, it is a value that means nothing next to the number it is read
 * against — so neither half is kept.
 *
 * What survives is the located FACT: the deposit record and the damage mark,
 * with their kind, scope, intensity and freshness. Nothing about the change is
 * lost; only the duplicate opinion about someone else's channel is.
 */
function recordableCondition(condition: GarmentConditionState): GarmentConditionState {
  const regionOverrides: Record<string, GarmentConditionOverride> = {};
  for (const [partId, override] of Object.entries(condition.regionOverrides)) {
    if (!override) continue;
    const kept: GarmentConditionOverride = {};
    if (override.wetness !== undefined) kept.wetness = override.wetness;
    if (override.crease_load !== undefined) kept.crease_load = override.crease_load;
    if (Object.keys(kept).length > 0) regionOverrides[partId] = kept;
  }
  return {
    ...condition,
    base: {
      ...condition.base,
      cleanliness: PRISTINE_CONDITION_VECTOR.cleanliness,
      wear: PRISTINE_CONDITION_VECTOR.wear,
    },
    regionOverrides,
  };
}

/** Presentation + the recordable condition: exactly what the event and the row carry. */
interface RecordableGarmentState {
  presentation: GarmentPresentationState;
  condition: GarmentConditionState;
}

function recordableState(input: {
  presentation: GarmentPresentationState;
  condition: GarmentConditionState;
}): RecordableGarmentState {
  return { presentation: input.presentation, condition: recordableCondition(input.condition) };
}

/** True when two recordable states are the same garment — the no-op test. */
function sameRecordableState(left: RecordableGarmentState, right: RecordableGarmentState): boolean {
  return (
    sameGarmentPresentation(left.presentation, right.presentation) &&
    sameGarmentCondition(left.condition, right.condition)
  );
}

/** The single-instance store the shared reducer runs against. */
function singleGarmentStore(
  instance: GarmentInstanceState,
  blueprintHash: string,
  blueprint: GarmentBlueprint,
): ChatGarmentStore {
  return { ...emptyChatGarmentStore(), seeded: true, blueprints: { [blueprintHash]: blueprint }, instances: [instance] };
}

/** The last `garment_op.*` code the reducer pushed, if it dropped the operation. */
function droppedOperationCode(collector: DiagnosticCollector): string | undefined {
  return collector.items.filter((entry) => entry.code.startsWith("garment_op.")).at(-1)?.code;
}

/**
 * The code a reduce that applied nothing is rejected with. A drop always
 * carries its own `garment_op.*` diagnostic; an operation the reducer accepted
 * but that changed nothing carries none, and `garment_op.no_change` is the
 * stand-in. Both are rejections rather than accepted no-ops: an event whose
 * `after` equals the row it replaces is a sequence number and a fork boundary
 * bought for nothing, and every consumer downstream would have to learn to
 * ignore it.
 */
const NO_CHANGE_CODE = "garment_op.no_change";

/** The stored row would not parse, so there is no baseline to apply an operation to. */
const STATE_UNREADABLE_CODE = "garment_op.state_unreadable";

// ---------------------------------------------------------------------------
// apply_garment_operation (v1)
// ---------------------------------------------------------------------------

/**
 * Execute one ApplyGarmentOperation: resolve the actor's reach to the item,
 * build the one item's chat-shaped instance, run the SHARED reducer, and record
 * the result as one event plus one projection row, atomically.
 */
export async function submitDurableApplyGarmentOperation(
  rawCommand: unknown,
  options: GarmentStoreOptions = {},
): Promise<ApplyGarmentOperationCommandResult> {
  return runSimulationCommand({
    rawCommand,
    commandSchema: applyGarmentOperationCommandSchema,
    resultSchema: applyGarmentOperationCommandResultSchema,
    invalidResult: () => rejectedResult("invalid", "invalid_command", "That garment request is invalid."),
    branchUnavailableResult: (commandId) =>
      rejectedResult(commandId, "branch_mismatch", "That world branch is unavailable."),
    duplicateCommandIdResult: (commandId) =>
      rejectedResult(commandId, "duplicate_command_id", "That garment change has already been submitted."),
    conflictResult: (commandId, currentVersion) =>
      applyGarmentOperationCommandResultSchema.parse({
        status: "conflict",
        commandId,
        currentVersion,
        retryable: true,
      }),
    database: options.database,
    admitAtLockedVersion: options.admitAtLockedVersion,
    execute: async (tx: SimTx, branch: LockedBranchView, command: ApplyGarmentOperationCommand) => {
      const { actorId, itemId } = command.payload;

      // The opaque payload becomes a typed operation at the APPLICATION
      // boundary — the package carries it as a bounded object and never learns
      // the wardrobe vocabulary (docs/engine/materials.md §Garments).
      const parsedOperation = garmentOperationSchema.safeParse(command.payload.operation);
      if (!parsedOperation.success) {
        return rejectedResult(command.id, "operation_invalid", "That is not a garment operation.");
      }
      const operation = parsedOperation.data;

      const owner = ownerCommandFor(operation);
      if (owner !== undefined) {
        return rejectedResult(
          command.id,
          "operation_unsupported",
          `A garment "${operation.kind}" operation is recorded by ${owner}, not here.`,
          [owner],
        );
      }

      // The material-reach law, in `resolveApplyItemConditionSource`'s order
      // (material-condition.ts): a garment is exactly as reachable as any other
      // item an actor adjusts, decided against the same lock-consistent view.
      const view = await loadMaterialResolutionView(tx, branch, [itemId]);
      if (!view.actorById(actorId)) {
        return rejectedResult(command.id, "actor_not_found", "That actor is unavailable.");
      }
      if (!command.principal.controlledActorIds.includes(actorId)) {
        return rejectedResult(command.id, "unauthorized_actor", "You cannot direct that actor.");
      }
      const actorZoneId = view.actorZoneId(actorId);
      if (actorZoneId === null) {
        return rejectedResult(command.id, "actor_not_embodied", "They are not anywhere they can do that.");
      }
      const item = view.itemById(itemId);
      if (!item) return rejectedResult(command.id, "item_not_found", "That item is unavailable.");
      if (item.locus.kind === "gone") return rejectedResult(command.id, "item_gone", "That item is gone.");

      const root = resolveRootLocus(item.locus, view.itemById);
      if (rootZoneId(root, view) !== actorZoneId) {
        return rejectedResult(command.id, "root_not_colocated", "That item is not within reach.");
      }
      if (root.kind === "actor" && root.actorId !== actorId) {
        return item.locus.kind === "worn"
          ? rejectedResult(command.id, "worn_by_other", "That is worn by someone else.")
          : rejectedResult(command.id, "held_by_other", "That is in someone else's keeping.");
      }
      if (item.locus.kind === "container" && !containerAccessAllowed(view, item.locus.containerItemId, actorId)) {
        return rejectedResult(command.id, "container_access_denied", "That container is closed to them.");
      }
      if (view.reservingActivityId(itemId) !== null) {
        return rejectedResult(command.id, "item_reserved", "That is reserved for something else right now.");
      }

      const garment = await readItemGarmentInstance(tx, branch.id, item);
      if (!garment.reliable) {
        // No readable construction means no parts to address. Applying anything
        // against the degraded graph would record a result asserting the
        // garment covers nothing — the exposure defect docs/resilience.md and
        // the degraded law both exist to prevent.
        return rejectedResult(command.id, "garment_not_modelled", "That garment's construction is not modelled.");
      }
      if (!garment.state.readable) {
        // The stored row would not parse at the top level, so the read
        // degraded it to the neutral presentation and the pristine condition.
        // Applying on top of THAT baseline would record an `after` that does
        // not follow from the previous event's `after` — quietly turning a
        // corrupt row into corrupt history, and history is the half a fork
        // cannot repair. Refusing leaves the row exactly as it is; the
        // rejection code on the `sim_commands` row is the operator's signal
        // (this lane has no diagnostic sink), and a fork rebuilds the row from
        // the events. The guard is exactly as wide as the parse: a column that
        // parses but is field-repaired by the schemas' `.catch()` defaults
        // reads as readable and is NOT refused here.
        return rejectedResult(command.id, "operation_rejected", STATE_UNREADABLE_CODE);
      }

      // The branch clock is story SECONDS; the shared reducer integrates in
      // chat-clock MINUTES. Floor rather than round, so the minute a write
      // integrates to is never ahead of the second the event is stamped with.
      const atStoryMinute = Math.floor(branch.storySecond / 60);

      const collector = new DiagnosticCollector();
      const before = recordableState(garment.instance);
      const reduced = applyGarmentOperations(
        singleGarmentStore(garment.instance, garment.blueprintHash, garment.blueprint),
        [operation],
        { atMinutes: atStoryMinute, sink: collector },
      );
      const next = reduced.store.instances[0];
      if (reduced.applied === 0 || !next) {
        // The reducer refused it, or it changed nothing. Either way no history
        // is written: a rejection is not domain history (commands-events.md).
        const code = droppedOperationCode(collector) ?? NO_CHANGE_CODE;
        return rejectedResult(command.id, "operation_rejected", code);
      }

      const after = recordableState(next);
      if (sameRecordableState(before, after)) {
        // Reachable only when the reducer's ONLY effect was on a channel this
        // projection does not own. Nothing this command accepts can do that
        // today — a deposit still records its deposit, a damage its mark — but
        // the check is what guarantees the invariant rather than assuming it.
        return rejectedResult(command.id, "operation_rejected", NO_CHANGE_CODE);
      }

      const sequence = branch.headSequence + 1;
      const locationId = view.actorLocationId(actorId);
      const built = garmentOperationAppliedEventSchema.safeParse({
        id: composeSimulationId("event", [branch.id, command.id, `garment-operation-${itemId}`]),
        worldId: branch.worldId,
        branchId: branch.id,
        sequence,
        storySecond: branch.storySecond,
        type: "garment_operation_applied",
        schemaVersion: 1,
        rulesetVersion: branch.rulesetVersion,
        commandId: command.id,
        correlationId: command.correlationId,
        actorIds: [actorId],
        entityIds: [itemId],
        ...(locationId === null ? {} : { locationId }),
        recordedAtWallClock: command.submittedAtWallClock,
        payload: {
          actorId,
          itemId,
          operation,
          after,
          derived: { atStoryMinute, blueprintHash: garment.blueprintHash },
        },
      });
      if (!built.success) {
        // Unreachable by construction — the reducer's own caps hold every legal
        // result far inside the contract's opaque-payload bound. Degrading
        // rather than throwing keeps a malformed result from failing the turn
        // (docs/resilience.md §2); the row is left exactly as it was.
        return rejectedResult(command.id, "operation_rejected", "garment_op.result_unrecordable");
      }
      const event = built.data;

      await appendSimulationEvent(tx, event);
      // Written from the EVENT'S OWN payload rather than from the local
      // variable, so the row holds byte-for-byte what a replay of this event
      // re-applies — the one invariant that makes a fork of a dressed world
      // agree with its own history.
      await upsertItemGarmentStateRow(
        tx,
        branch.id,
        itemId,
        event.payload.after.presentation,
        event.payload.after.condition,
        event.sequence,
      );
      await advanceLockedBranch(tx, branch, event.sequence);

      return {
        status: "accepted",
        commandId: command.id,
        branchVersion: branch.version + 1,
        firstSequence: event.sequence,
        lastSequence: event.sequence,
        eventIds: [event.id],
      };
    },
  });
}
