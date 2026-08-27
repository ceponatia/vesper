import { z } from "zod";
import { affordanceSubjectIdSchema } from "../core";
import type { ContactPolicyScope } from "../contact";

/**
 * The romantic-permission EVENT — the durable unit of the branch-local grant
 * ledger, on repo conventions: bounded strings, branded subject ids, a strict
 * schema with no repairs.
 *
 * A permission key is DIRECTIONAL: `permitted actor → granting target → exact
 * scope → story branch`. If Mara grants Alex `romantic_touch`, the record says
 * nothing about Mara acting toward Alex — mutual permission is two records.
 * The branch is the chat (`branchId == character_chats.id`, ruled 2026-08-04):
 * character chat has no separate branch entity, so branch-local means
 * chat-scoped, and a grant never leaks into an unrelated chat, a character
 * copy, or a sibling branch.
 *
 * ## The five kinds, and what each may change
 *
 * - **granted** — the target authorizes the named actor for the exact scope.
 *   Establishes (or re-establishes) the standing grant.
 * - **attempt_denied** — the target rejects ONE attempt ("not now"). Evidence
 *   about that attempt; it never changes the standing projection.
 * - **withdrawn** — the target revokes the standing grant ("not anymore").
 * - **relationship_revoked** — reserved for the future relationship-transition
 *   producer. In the vocabulary and the fold NOW so its arrival is a producer,
 *   not a migration; nothing emits it yet.
 * - **developer_overridden** — the audited dev-menu path. Carries an explicit
 *   `operation` (`grant` | `withdraw`) that the fold applies; an override
 *   without one is malformed and is DROPPED, never guessed into a grant.
 *
 * ## Chronology fields
 *
 * `storyTime` + `orderInSource` (+ the committed ledger position and the
 * optional `evidenceOffset`) give every event an effective position in
 * committed chronology (`chronology.ts`). Resolution may use only permission
 * effective BEFORE the attempted action; ambiguous ordering fails closed.
 *
 * The schema is STRICT throughout — no `.catch()`, no defaults. A permission
 * event is an authorization claim, and repairing one would manufacture the very
 * thing this owner exists to stop; an event that does not parse simply stops
 * being an event (dropped at the boundary with a diagnostic, per
 * docs/resilience.md §1).
 */

/** The exact scopes this owner knows. The MVP is deliberately one entry. */
export const romanticPermissionScopes = ["romantic_touch"] as const satisfies readonly ContactPolicyScope[];
export const romanticPermissionScopeSchema = z.enum(romanticPermissionScopes);
export type RomanticPermissionScope = z.infer<typeof romanticPermissionScopeSchema>;

export const romanticPermissionEventKinds = [
  "granted",
  "attempt_denied",
  "withdrawn",
  "relationship_revoked",
  "developer_overridden",
] as const;
export const romanticPermissionEventKindSchema = z.enum(romanticPermissionEventKinds);
export type RomanticPermissionEventKind = z.infer<typeof romanticPermissionEventKindSchema>;

export const romanticPermissionSourceKinds = [
  "npc_decision",
  "relationship_transition",
  "developer_override",
] as const;
export const romanticPermissionSourceKindSchema = z.enum(romanticPermissionSourceKinds);
export type RomanticPermissionSourceKind = z.infer<typeof romanticPermissionSourceKindSchema>;

/** What a developer override does to the standing grant. */
export const romanticPermissionOverrideOperations = ["grant", "withdraw"] as const;
export const romanticPermissionOverrideOperationSchema = z.enum(romanticPermissionOverrideOperations);
export type RomanticPermissionOverrideOperation = z.infer<typeof romanticPermissionOverrideOperationSchema>;

const permissionIdSchema = z.string().trim().min(1).max(256);

export const romanticPermissionEventSchema = z.object({
  /** The event's own idempotency identity within its branch. */
  eventId: permissionIdSchema,
  /** The story branch — the chat id in the chat lane (ruled: a chat IS its branch). */
  branchId: permissionIdSchema,
  /** Who may attempt the contact. */
  permittedActorId: affordanceSubjectIdSchema,
  /** Whose authoritative side authored the event — only the target may grant. */
  grantingTargetId: affordanceSubjectIdSchema,
  scope: romanticPermissionScopeSchema,
  kind: romanticPermissionEventKindSchema,
  sourceKind: romanticPermissionSourceKindSchema,
  /** The assistant message the decision is grounded in, when one exists. */
  sourceMessageId: permissionIdSchema.optional(),
  /** The simulation/override event it is grounded in, when one exists. */
  sourceEventId: permissionIdSchema.optional(),
  /** The story-clock minute the event landed on. */
  storyTime: z.number().int().min(0),
  /** The event's position among its source's own events (same-reply ordering). */
  orderInSource: z.number().int().min(0),
  /** REQUIRED for `developer_overridden` (enforced by the fold); absent otherwise. */
  operation: romanticPermissionOverrideOperationSchema.optional(),
  /** For `attempt_denied`: the contact attempt (action id) the denial addressed. */
  attemptActionId: z.string().trim().min(1).max(512).optional(),
  /** The active contact produced by that attempt, when one committed. */
  attemptContactId: z.string().trim().min(1).max(512).optional(),
  /** Character offset of the deciding evidence within its source reply, when known. */
  evidenceOffset: z.number().int().min(0).optional(),
});

export type RomanticPermissionEvent = z.infer<typeof romanticPermissionEventSchema>;
