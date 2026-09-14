import { z } from "zod";
import {
  createCommandEnvelopeSchema,
  createCommandResultSchema,
  createEventEnvelopeSchema,
} from "./envelopes";
import {
  commandIdSchema,
  itemIdSchema,
  storySecondSchema,
  worldCharacterIdSchema,
} from "./identity";

/**
 * #296 — durable garment operations: the command an actor changes a garment
 * through, the event that records the RESULT, and the projection that fold
 * rebuilds.
 *
 * ## Why the payloads are opaque here
 *
 * The wardrobe vocabulary — part graphs, behaviors, closure shapes, condition
 * channels, deposit kinds — belongs to the application
 * (`apps/web/src/contracts/items/`), and the reducer that applies an operation
 * lives there too, shared byte-for-byte with the character-chat lane. This
 * package deliberately never learns it: `garment_blueprint` is already an
 * opaque object on the material item (`materials.ts`), and the three payloads
 * here are opaque for exactly the same reason. What this package DOES promise
 * is structural: each is a JSON object within a stated size bound, so it
 * round-trips through the event row byte-identically and hashes
 * deterministically for snapshot and fork checksums.
 *
 * ## Why the event records the resulting state
 *
 * Replay re-applies the recorded `after` and never re-runs the reducer — the
 * same law `item_condition_source_applied` follows with
 * `valueAfterFixedPoint` + `derived`. Re-running would make every historical
 * event's outcome depend on today's reducer, today's material coefficients and
 * today's blueprint static, so a fork of a dressed world would silently
 * re-dress itself the first time any of the three changed. Recording the result
 * makes the fold a pure re-application: `replayItemGarmentStateHistory`
 * (`../lib/garments.ts`) needs no wardrobe knowledge at all, which is what lets
 * it live in this package beside the projectors that must pass the event
 * through.
 *
 * `derived` carries what the write KNEW rather than what it needs: the story
 * minute the reducer integrated to, and the content hash of the blueprint it
 * ran against. Neither is replay input. They exist so a reader can tell that a
 * later operation ran against different construction, the same way
 * `ItemConditionIntegrationDerivation` records the registry version and the
 * modifier set behind a meter write.
 */

// --- Opaque payload bound -----------------------------------------------------

/**
 * The ceiling on one opaque garment payload, in serialized JSON characters.
 *
 * The application's own caps put every legal value far below this — at most 24
 * part nodes, 12 deposits, 12 damage marks and 16 region overrides — so the
 * bound never truncates a real garment. It exists so a malformed or hostile
 * caller cannot park an unbounded blob in `sim_events`, which is append-only
 * and replayed forever.
 */
export const GARMENT_OPAQUE_PAYLOAD_MAX_CHARS = 32_768;

/** True when a value serializes to JSON within {@link GARMENT_OPAQUE_PAYLOAD_MAX_CHARS}. */
function withinOpaquePayloadBound(value: unknown): boolean {
  let text: string | undefined;
  try {
    text = JSON.stringify(value);
  } catch {
    // Circular or otherwise non-serializable: not a JSON payload at all.
    return false;
  }
  return text !== undefined && text.length > 0 && text.length <= GARMENT_OPAQUE_PAYLOAD_MAX_CHARS;
}

/** A bounded, opaque JSON object — the shape this package promises and nothing more. */
function opaqueGarmentObjectSchema(label: string) {
  return z
    .record(z.string(), z.unknown())
    .refine(withinOpaquePayloadBound, `${label} must serialize within ${GARMENT_OPAQUE_PAYLOAD_MAX_CHARS} characters`);
}

/**
 * One garment operation as this package carries it: a discriminating `kind`
 * plus whatever else the application's `garmentOperationSchema` defines.
 *
 * The `kind` is surfaced — and only the `kind` — because it is the one field
 * this layer has a legitimate use for: the store's owner routing refuses a
 * `transfer`/`clean`/cleanliness-or-wear operation here without parsing the
 * rest, and an operator reading `sim_events` can tell what a row was without a
 * wardrobe decoder. Everything else passes through untouched.
 */
export const garmentOperationEnvelopeSchema = z
  .object({ kind: z.string().trim().min(1).max(64) })
  .passthrough()
  .refine(
    withinOpaquePayloadBound,
    `Garment operation must serialize within ${GARMENT_OPAQUE_PAYLOAD_MAX_CHARS} characters`,
  );
export type GarmentOperationEnvelope = z.infer<typeof garmentOperationEnvelopeSchema>;

/** The presentation half of a recorded result — the app's `GarmentPresentationState`. */
export const garmentPresentationPayloadSchema = opaqueGarmentObjectSchema("Garment presentation");
/** The condition half of a recorded result — the app's `GarmentConditionState`. */
export const garmentConditionPayloadSchema = opaqueGarmentObjectSchema("Garment condition");

/**
 * The state one garment is IN after an operation — both channels the
 * `sim_item_garment_state` projection owns, recorded together because they are
 * written together and a projector that could apply one without the other
 * would be able to leave the row half-updated.
 */
export const garmentStateAfterSchema = z
  .object({
    presentation: garmentPresentationPayloadSchema,
    condition: garmentConditionPayloadSchema,
  })
  .strict();
export type GarmentStateAfter = z.infer<typeof garmentStateAfterSchema>;

// --- Command -------------------------------------------------------------------

const applyGarmentOperationPayloadSchema = z
  .object({
    actorId: worldCharacterIdSchema,
    itemId: itemIdSchema,
    operation: garmentOperationEnvelopeSchema,
  })
  .strict();

export const applyGarmentOperationCommandSchema = createCommandEnvelopeSchema(
  "apply_garment_operation",
  1,
  applyGarmentOperationPayloadSchema,
);

/**
 * The closed rejection vocabulary. The first block is the material-reach law
 * `apply_item_condition_source` already states — same checks, same order, so a
 * garment is exactly as reachable as any other item an actor adjusts. The last
 * four are this command's own:
 *
 * - `garment_not_modelled` — the item carries no readable blueprint static, so
 *   there is no construction to address. Refusing is the only honest answer: a
 *   degraded blueprint has no parts, and applying an operation against it would
 *   record a result that says the garment covers nothing.
 * - `operation_invalid` — the opaque payload does not parse as a
 *   `GarmentOperation` at the application boundary.
 * - `operation_unsupported` — a well-formed operation whose channel this
 *   command does not own (`transfer`, `clean`, or an `apply_condition` on
 *   cleanliness/wear). The rejection names the command that does.
 * - `operation_rejected` — nothing was applied, and `publicReason` carries the
 *   stable `garment_op.*` code saying why: the shared reducer dropped it, it
 *   changed nothing (`garment_op.no_change`), or the stored row it would have
 *   applied to does not parse (`garment_op.state_unreadable`), in which case
 *   there is no baseline for a result to honestly follow from — or, unreachable
 *   by construction, the reduced result would not fit the event contract
 *   (`garment_op.result_unrecordable`).
 */
export const applyGarmentOperationRejectionCodes = [
  "invalid_command",
  "duplicate_command_id",
  "branch_mismatch",
  "actor_not_found",
  "unauthorized_actor",
  "actor_not_embodied",
  "item_not_found",
  "item_gone",
  "root_not_colocated",
  "held_by_other",
  "worn_by_other",
  "container_access_denied",
  "item_reserved",
  "garment_not_modelled",
  "operation_invalid",
  "operation_unsupported",
  "operation_rejected",
] as const;
export const applyGarmentOperationRejectionCodeSchema = z.enum(applyGarmentOperationRejectionCodes);
export const applyGarmentOperationCommandResultSchema = createCommandResultSchema(
  applyGarmentOperationRejectionCodeSchema,
);

// --- Event ---------------------------------------------------------------------

const garmentOperationAppliedPayloadSchema = z
  .object({
    actorId: worldCharacterIdSchema,
    itemId: itemIdSchema,
    /** The operation as submitted — audit and narration input, never replay input. */
    operation: garmentOperationEnvelopeSchema,
    /** The RESULT: what the projection row holds from this sequence onward. */
    after: garmentStateAfterSchema,
    derived: z
      .object({
        /** The story minute the reducer integrated the condition gradient to. */
        atStoryMinute: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
        /** Content hash of the blueprint static the result was computed against. */
        blueprintHash: z.string().trim().min(1).max(64),
      })
      .strict(),
  })
  .strict();

/**
 * One accepted garment operation. `commandId` is REQUIRED (unlike the envelope
 * factory's optional field): every one of these events is produced by exactly
 * one `apply_garment_operation` command, and the replay fold counts distinct
 * command ids to derive the projection version.
 */
export const garmentOperationAppliedEventSchema = createEventEnvelopeSchema(
  "garment_operation_applied",
  1,
  garmentOperationAppliedPayloadSchema,
).extend({ commandId: commandIdSchema });

// --- Projection ----------------------------------------------------------------

/** One item's durable garment state, as `sim_item_garment_state` stores it. */
export const itemGarmentStateEntrySchema = z
  .object({
    itemId: itemIdSchema,
    presentation: garmentPresentationPayloadSchema,
    condition: garmentConditionPayloadSchema,
  })
  .strict();
export type ItemGarmentStateEntry = z.infer<typeof itemGarmentStateEntrySchema>;

/**
 * The garment-state projection. Sparse by construction: an item with no entry
 * has never been operated on, which the read layer reads as the neutral
 * presentation plus the pristine condition — absence is a state, not a gap.
 */
export const itemGarmentStateProjectionSchema = z
  .object({
    branchId: z.string().min(1),
    headSequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    version: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    storySecond: storySecondSchema,
    items: z.array(itemGarmentStateEntrySchema),
  })
  .strict();
export type ItemGarmentStateProjection = z.infer<typeof itemGarmentStateProjectionSchema>;

// --- Types ---------------------------------------------------------------------

export type ApplyGarmentOperationCommand = z.infer<typeof applyGarmentOperationCommandSchema>;
export type ApplyGarmentOperationRejectionCode = z.infer<
  typeof applyGarmentOperationRejectionCodeSchema
>;
export type ApplyGarmentOperationCommandResult = z.infer<
  typeof applyGarmentOperationCommandResultSchema
>;
export type GarmentOperationAppliedEvent = z.infer<typeof garmentOperationAppliedEventSchema>;
