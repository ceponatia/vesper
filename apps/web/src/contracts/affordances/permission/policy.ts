import { affordanceEvidence, type AffordanceEvidence, type AffordanceSubjectId } from "../core";
import {
  CONTACT_ACTION_SCOPE,
  contactActionRequiresPermission,
  type ContactActionKind,
  type ContactInteractionPolicyRead,
  type ContactPolicyScope,
} from "../contact";
import type {
  RomanticPermissionDenialRecord,
  RomanticPermissionProjection,
  RomanticPermissionProjectionEntry,
} from "./projection";

/**
 * The RESOLVER ADAPTER's pure half — projection → one attempt's policy read.
 *
 * The required mapping, verbatim from the ruling:
 *
 * - granting target is the player  → `not_required` with the `player_target`
 *   basis, WITHOUT manufacturing a player grant;
 * - explicit denial of the current attempt → `denied` — checked before the
 *   standing grant, because "not now" rejects THIS attempt without erasing a
 *   standing grant, and a mapping that let the grant win would make the denial
 *   unreachable;
 * - current exact standing grant → `allowed`, scopes = the direction's granted
 *   scopes (today `["romantic_touch"]`);
 * - standing grant withdrawn or relationship-revoked, no newer grant →
 *   `withdrawn`;
 * - no answer → `unresolved`;
 * - different direction or different scope → NEVER `allowed` for that scope.
 *   The lookup is keyed by the exact directional key, so a reverse grant simply
 *   is not found; a grant that exists for ANOTHER scope of the same direction
 *   comes back `allowed` naming only the scopes it actually covers, and the
 *   contact resolver's own exact-scope check turns that into
 *   `permission_scope_missing` — a refusal, not a silence, because "a grant
 *   that exists and does not name this action is an answer about this action"
 *   (contact/decisions.ts).
 *
 * Chronology is the FOLD's concern, not this function's: the projection handed
 * in must already contain only chronologically effective events
 * (`foldRomanticPermissionProjection`'s `effectiveBefore`), so this read stays
 * a pure lookup. For an ordinary player attempt every committed event precedes
 * the attempt and no cutoff is needed.
 *
 * Evidence names the deciding event ids (bounded), never prose — it is debug
 * output per the core's evidence law.
 */

export interface DeriveRomanticPermissionPolicyInput {
  readonly projection: RomanticPermissionProjection;
  /** Who is attempting the contact. */
  readonly permittedActorId: AffordanceSubjectId;
  /** Whose permission the attempt needs — the contact's target. */
  readonly grantingTargetId: AffordanceSubjectId;
  readonly actionKind: ContactActionKind;
  /** The lane's player subject; a granting target equal to it takes the ruled exception. */
  readonly playerSubjectId: AffordanceSubjectId;
  /** The current attempt's action id, matched against recorded attempt denials. */
  readonly attemptActionId?: string;
  /** The active contact being rechecked after a denial, when one committed. */
  readonly attemptContactId?: string;
}

/** How many deciding events an evidence list names before it stops. */
const MAX_POLICY_EVIDENCE = 8;

function eventEvidence(eventId: string, detail: string): AffordanceEvidence {
  return affordanceEvidence("event", `permission:${eventId}`, detail);
}

function directionEntries(
  input: DeriveRomanticPermissionPolicyInput,
): readonly RomanticPermissionProjectionEntry[] {
  return input.projection.entries.filter(
    (entry) =>
      entry.permittedActorId === input.permittedActorId && entry.grantingTargetId === input.grantingTargetId,
  );
}

function denialOfCurrentAttempt(
  input: DeriveRomanticPermissionPolicyInput,
): RomanticPermissionDenialRecord | undefined {
  if (input.attemptActionId === undefined && input.attemptContactId === undefined) return undefined;
  return input.projection.denials.find(
    (denial) =>
      denial.permittedActorId === input.permittedActorId &&
      denial.grantingTargetId === input.grantingTargetId &&
      ((input.attemptActionId !== undefined && denial.attemptActionId === input.attemptActionId) ||
        (input.attemptContactId !== undefined && denial.attemptContactId === input.attemptContactId)),
  );
}

export function derivePermissionPolicyRead(input: DeriveRomanticPermissionPolicyInput): ContactInteractionPolicyRead {
  // Total-function guard: a permission-neutral kind never consults this owner,
  // and the honest answer if somebody asks anyway is the neutral one — WITHOUT
  // the player-target basis, so it can never slip through the resolver's gate.
  if (!contactActionRequiresPermission(input.actionKind)) {
    return {
      status: "not_required",
      scopes: [],
      evidence: [affordanceEvidence("adapter", "permission.derive", "action_not_gated")],
    };
  }

  // The ruled player-target exception: the player writes their own reaction, so
  // no standing player grant exists or is manufactured. The explicit basis is
  // what lets the resolver pass this — and ONLY this — `not_required`.
  if (input.grantingTargetId === input.playerSubjectId) {
    return {
      status: "not_required",
      notRequiredBasis: "player_target",
      notRequiredTargetId: input.grantingTargetId,
      scopes: [],
      evidence: [affordanceEvidence("adapter", "permission.player_target", "not_required")],
    };
  }

  const denial = denialOfCurrentAttempt(input);
  if (denial !== undefined) {
    return { status: "denied", scopes: [], evidence: [eventEvidence(denial.eventId, "attempt_denied")] };
  }

  const entries = directionEntries(input);
  const requiredScope = CONTACT_ACTION_SCOPE[input.actionKind];
  const required = entries.find((entry) => entry.scope === requiredScope);

  // The required scope's own standing dominates: a withdrawn grant for THIS
  // exact scope is an answer about this action, and a grant for some other
  // scope must not paper over it. `withdrawn` and `revoked` both read
  // `withdrawn` here — the contact core's policy vocabulary has one word for a
  // grant that existed and is gone, and WHICH way it went lives in the deciding
  // event, named in the evidence.
  if (required !== undefined && required.standing !== "granted") {
    return {
      status: "withdrawn",
      scopes: [],
      evidence: [eventEvidence(required.decidedByEventId, required.standing)],
    };
  }

  const granted = entries.filter((entry) => entry.standing === "granted");
  if (granted.length > 0) {
    const scopes: readonly ContactPolicyScope[] = granted.slice(0, MAX_POLICY_EVIDENCE).map((entry) => entry.scope);
    return {
      status: "allowed",
      scopes,
      evidence: granted
        .slice(0, MAX_POLICY_EVIDENCE)
        .map((entry) => eventEvidence(entry.decidedByEventId, `granted_${entry.scope}`)),
    };
  }

  return {
    status: "unresolved",
    scopes: [],
    evidence: [affordanceEvidence("adapter", "permission.derive", "no_answer")],
  };
}
