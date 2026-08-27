import { z } from "zod";
import {
  createCommandEnvelopeSchema,
  createCommandResultSchema,
  createEventEnvelopeSchema,
  createStableStringSetSchema,
} from "./envelopes";
import {
  commandIdSchema,
  linkIdSchema,
  locationIdSchema,
  storySecondSchema,
  worldCharacterIdSchema,
  zoneIdSchema,
} from "./identity";

/**
 * E3.5 — layered access. Routes plan over public links (E3.1); the last
 * private hop — a front door, a bedroom threshold — is a separate validated
 * action: `attempt_entry` through one adjacent link, granted by an
 * AccessGrant or, where the world type permits it, forced as an explicit,
 * witnessed, consequential act (ruling 3 — never auto-succeeding over a
 * person; this is spatial transgression only, and interpersonal consent
 * remains an untouched separate precondition). Missing or malformed grant
 * data fails closed (§13.1). Storyteller relocation is the one privileged
 * bypass: a distinct audited command family (§7, ruling 4), never a hidden
 * flag on ordinary movement.
 */

export const accessGrantBases = ["owner", "resident", "employee", "invitation", "key", "forced"] as const;
export const accessGrantBasisSchema = z.enum(accessGrantBases);

export const accessGrantSchema = z
  .object({
    id: z.string().min(1).max(1_024),
    granteeActorId: worldCharacterIdSchema,
    /** Grant scope: a location, optionally narrowed to specific zones. */
    locationId: locationIdSchema,
    zoneIds: createStableStringSetSchema(zoneIdSchema, "Grant zone IDs").optional(),
    basis: accessGrantBasisSchema,
    validFrom: storySecondSchema,
    validUntil: storySecondSchema.optional(),
    revokedAt: storySecondSchema.optional(),
  })
  .strict();

export type AccessGrant = z.infer<typeof accessGrantSchema>;

/** Fail-closed grant check: only a well-formed, live grant admits (§13.1). */
export function grantAdmitsEntry(
  grant: AccessGrant,
  input: { actorId: string; locationId: string; zoneId: string; storySecond: number },
): boolean {
  if (grant.granteeActorId !== input.actorId) return false;
  if (grant.locationId !== input.locationId) return false;
  if (grant.zoneIds !== undefined && !grant.zoneIds.includes(input.zoneId as never)) return false;
  if (grant.validFrom > input.storySecond) return false;
  if (grant.validUntil !== undefined && grant.validUntil < input.storySecond) return false;
  if (grant.revokedAt !== undefined && grant.revokedAt <= input.storySecond) return false;
  return true;
}

// --- AttemptEntry command -----------------------------------------------------

const attemptEntryPayloadSchema = z
  .object({
    actorId: worldCharacterIdSchema,
    linkId: linkIdSchema,
    /** True marks an explicit forced-entry attempt (ruling 3). */
    forced: z.boolean(),
  })
  .strict();

export const attemptEntryCommandSchema = createCommandEnvelopeSchema(
  "attempt_entry",
  1,
  attemptEntryPayloadSchema,
);

export const attemptEntryRejectionCodes = [
  "invalid_command",
  "duplicate_command_id",
  "branch_mismatch",
  "actor_not_found",
  "unauthorized_actor",
  "link_not_found",
  "not_adjacent",
  "actor_in_transit",
  "activity_conflict",
  "link_impassable",
  "entry_denied",
  "trespass_not_permitted",
] as const;
export const attemptEntryRejectionCodeSchema = z.enum(attemptEntryRejectionCodes);
export const attemptEntryCommandResultSchema = createCommandResultSchema(attemptEntryRejectionCodeSchema);

export const zoneEntryBases = ["public", "granted", "forced"] as const;
export const zoneEntryBasisSchema = z.enum(zoneEntryBases);

const zoneEnteredPayloadSchema = z
  .object({
    actorId: worldCharacterIdSchema,
    linkId: linkIdSchema,
    fromZoneId: zoneIdSchema,
    toZoneId: zoneIdSchema,
    basis: zoneEntryBasisSchema,
    /** Captured witnesses at both threshold zones — a forced entry is noisy. */
    observerActorIds: createStableStringSetSchema(worldCharacterIdSchema, "Entry witness IDs"),
  })
  .strict();

export const zoneEnteredEventSchema = createEventEnvelopeSchema(
  "zone_entered",
  1,
  zoneEnteredPayloadSchema,
).extend({ commandId: commandIdSchema });

export type AttemptEntryCommand = z.infer<typeof attemptEntryCommandSchema>;
export type AttemptEntryRejectionCode = z.infer<typeof attemptEntryRejectionCodeSchema>;
export type AttemptEntryCommandResult = z.infer<typeof attemptEntryCommandResultSchema>;
export type ZoneEnteredEvent = z.infer<typeof zoneEnteredEventSchema>;

// --- Storyteller relocation (ruling 4) ----------------------------------------

const storytellerRelocatePayloadSchema = z
  .object({
    actorId: worldCharacterIdSchema,
    destinationZoneId: zoneIdSchema,
    /** Recorded rationale — the audit trail's why (§3.2 invariant 6). */
    reason: z.string().trim().min(1).max(500),
  })
  .strict();

export const storytellerRelocateActorCommandSchema = createCommandEnvelopeSchema(
  "storyteller_relocate_actor",
  1,
  storytellerRelocatePayloadSchema,
);

export const storytellerRelocateRejectionCodes = [
  "invalid_command",
  "duplicate_command_id",
  "branch_mismatch",
  "actor_not_found",
  "unauthorized_principal",
  "destination_not_found",
] as const;
export const storytellerRelocateRejectionCodeSchema = z.enum(storytellerRelocateRejectionCodes);
export const storytellerRelocateActorCommandResultSchema = createCommandResultSchema(
  storytellerRelocateRejectionCodeSchema,
);

const storytellerRelocationPayloadSchema = z
  .object({
    actorId: worldCharacterIdSchema,
    fromZoneId: zoneIdSchema.optional(),
    /** Set when the relocation tore the actor out of an active journey. */
    abandonedJourneyId: z.string().min(1).max(1_024).optional(),
    toZoneId: zoneIdSchema,
    reason: z.string().trim().min(1).max(500),
  })
  .strict();

/** Privileged causality — visibly distinct from ordinary movement in audit. */
export const storytellerRelocationEventSchema = createEventEnvelopeSchema(
  "storyteller_relocation",
  1,
  storytellerRelocationPayloadSchema,
).extend({ commandId: commandIdSchema });

export type StorytellerRelocateActorCommand = z.infer<typeof storytellerRelocateActorCommandSchema>;
export type StorytellerRelocateRejectionCode = z.infer<typeof storytellerRelocateRejectionCodeSchema>;
export type StorytellerRelocateActorCommandResult = z.infer<
  typeof storytellerRelocateActorCommandResultSchema
>;
export type StorytellerRelocationEvent = z.infer<typeof storytellerRelocationEventSchema>;
