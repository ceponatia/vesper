import { affordanceSubjectId, type AffordanceSubjectId } from "@/contracts";

/**
 * Direction validation for the `romantic_touch` developer-override endpoint
 * (romantic-contact-affordances.spec.permission.md §"Authorship and developer
 * controls"; plan ruling 1) — the pure half of the route's POST, extracted so
 * the participant rules are unit-testable without a database.
 *
 * A permission key is directional: `permitted actor → granting target`. The
 * override may name:
 *
 * - **granting target**: a roster NPC of the chat, and NEVER the player — the
 *   ruled player-target exception means no standing player grant exists, so
 *   there is nothing for an override to edit (spec §"Direction and participant
 *   rules");
 * - **permitted actor**: the lane's player subject or a roster NPC, and never
 *   the target itself — a self-directed grant is not a direction.
 *
 * Failures come back as typed values with the HTTP-facing code and message,
 * never as exceptions (docs/resilience.md §2).
 */

export type OverrideDirectionFailureCode =
  | "target_is_player"
  | "target_not_in_roster"
  | "actor_not_in_chat"
  | "actor_is_target";

export type OverrideDirectionResult =
  | {
      readonly ok: true;
      readonly permittedActorId: AffordanceSubjectId;
      readonly grantingTargetId: AffordanceSubjectId;
    }
  | { readonly ok: false; readonly code: OverrideDirectionFailureCode; readonly message: string };

export interface ResolveOverrideDirectionInput {
  /** Who may attempt the contact, as the request named them. */
  readonly permittedActorId: string;
  /** Whose standing grant the override edits, as the request named them. */
  readonly grantingTargetId: string;
  /** The chat's roster character ids — the only legal NPC vocabulary. */
  readonly rosterCharacterIds: readonly string[];
  /** The lane's player subject id (`CHAT_CONTACT_PLAYER_SUBJECT`). */
  readonly playerSubjectId: string;
}

export function resolveOverrideDirection(input: ResolveOverrideDirectionInput): OverrideDirectionResult {
  const roster = new Set(input.rosterCharacterIds);
  if (input.grantingTargetId === input.playerSubjectId) {
    return {
      ok: false,
      code: "target_is_player",
      message:
        "the player never holds a standing grant to edit — the player-target exception means the player writes their own reaction",
    };
  }
  if (!roster.has(input.grantingTargetId)) {
    return {
      ok: false,
      code: "target_not_in_roster",
      message: "the granting target must be a roster character of this conversation",
    };
  }
  if (input.permittedActorId !== input.playerSubjectId && !roster.has(input.permittedActorId)) {
    return {
      ok: false,
      code: "actor_not_in_chat",
      message: "the permitted actor must be the player or a roster character of this conversation",
    };
  }
  if (input.permittedActorId === input.grantingTargetId) {
    return {
      ok: false,
      code: "actor_is_target",
      message: "a participant cannot hold a grant toward themselves — pick two different participants",
    };
  }
  return {
    ok: true,
    permittedActorId: affordanceSubjectId(input.permittedActorId),
    grantingTargetId: affordanceSubjectId(input.grantingTargetId),
  };
}
