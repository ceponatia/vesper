import { eq } from "drizzle-orm";
import type { PrincipalKind } from "@/contracts/simulation/envelopes";
import { characterChats, type Db } from "@/server/db";
import { log } from "@/server/log";
import { isLegacyUnanchoredEngineTestPlayer } from "@/server/test-support/simulation-fixtures";

/**
 * The durable command layer's own ownership gate (security-authz.plan.md
 * §Follow-ups item 1).
 *
 * Until this seam existed the command shells locked a branch by id and RECORDED
 * `principal.principalId` without ever checking it: `requireSimChat` in the
 * sim-command route was the only gate, so the whole successor surface was one
 * new caller away from a cross-account write. The service boundary now verifies
 * the principal itself — a supplied principal id is a claim, never a credential.
 *
 * Ownership is reached through the CHAT ANCHOR. `sim_worlds` / `sim_branches`
 * deliberately carry no owner column; `character_chats.sim_branch_id` →
 * `character_chats.owner_id` is the only account boundary the successor lane
 * has, so one branch → owning chat → owner id read is the whole rule.
 */

/** Stable diagnostic code for a refused command; asserted by the degradation tests. */
export const SIM_COMMAND_DENIED = "sim.command_denied";

/** Why a command was refused — the private cause, logged and never returned to the caller. */
export type SimCommandDenialReason =
  /** A player principal cannot prove ownership because no chat anchors the branch. */
  | "unanchored_player"
  /** A player principal that is not the owning chat's account. */
  | "principal_not_owner"
  /** More than one account's chat anchors this branch: ownership is unreadable, so fail closed. */
  | "ambiguous_anchor";

export interface SimCommandPrincipal {
  kind: PrincipalKind;
  principalId: string;
}

export interface SimCommandAuthorizationInput {
  branchId: string;
  commandId: string;
  type: string;
  principal: SimCommandPrincipal;
}

export type SimCommandAuthorization = { allowed: true } | { allowed: false; reason: SimCommandDenialReason };

/**
 * Which principal kinds carry an ACCOUNT id that has to be proven.
 *
 * - `player` is the only kind minted from a player-supplied request
 *   (`simPlayerEnvelope`), and its `principalId` is a `users.id`. A player must
 *   therefore resolve exactly one chat anchor and match that account. An
 *   unanchored branch is not an ownerless public branch; it is an engine state
 *   that a player cannot prove authority over.
 * - `director` / `storyteller` are the authoring surfaces: their only HTTP entry
 *   points are the admin sim routes, which 404 for a non-admin role before an
 *   envelope is ever built, plus world provisioning (`/api/successor-chats`).
 *   Their ids are account ids but an admin is by construction allowed on any
 *   branch, so matching them against the owner would deny every legitimate use.
 * - `npc_policy` / `npc_deliberator` / `system` / `migration` are engine-internal
 *   (the arbiter, the scheduler drain, the world seeders). Their `principalId` is
 *   a fixed label like `sim-scheduler` — not an account — and nothing outside the
 *   server can mint one, so there is no account claim to verify.
 *
 * Exhaustive by design: a new principal kind must state which side it lands on.
 */
function requiresOwnerMatch(kind: PrincipalKind): boolean {
  switch (kind) {
    case "player":
      return true;
    case "npc_policy":
    case "npc_deliberator":
    case "system":
    case "director":
    case "storyteller":
    case "migration":
      return false;
  }
}

/**
 * The accounts whose chats anchor this branch. Grouped so the read returns
 * DISTINCT owners, and capped at two — one row proves ownership, two proves the
 * anomaly, and nothing else changes the ruling.
 */
async function anchorOwnerIds(branchId: string, database: Db): Promise<string[]> {
  const rows = await database
    .select({ ownerId: characterChats.ownerId })
    .from(characterChats)
    .where(eq(characterChats.simBranchId, branchId))
    .groupBy(characterChats.ownerId)
    .limit(2);
  return rows.map((row) => row.ownerId);
}

/**
 * Decide whether this principal may mutate this branch. Read-only: it must be
 * safe to call before the command shell has written anything at all.
 *
 * A branch no chat points at is an engine/provisioning state, not a player-owned
 * resource. Engine-internal and privileged authoring principals may operate
 * there according to their own entry-point policy; a `player` principal must
 * resolve exactly one owning chat and match it. This keeps the service boundary
 * fail-closed even if a future caller accepts a raw branch id.
 *
 * The sole exception is the explicitly opted-in synthetic principal used by the
 * aggregate legacy engine suite. It is centralized in test support, requires
 * NODE_ENV=test, and is not active in the dedicated authorization suite or any
 * production/ordinary integration path.
 */
export async function authorizeSimulationCommand(
  input: SimCommandAuthorizationInput,
  database: Db,
): Promise<SimCommandAuthorization> {
  if (!requiresOwnerMatch(input.principal.kind)) return { allowed: true };

  const owners = await anchorOwnerIds(input.branchId, database);
  if (owners.length === 0) {
    return isLegacyUnanchoredEngineTestPlayer(input.principal.principalId)
      ? { allowed: true }
      : deny(input, "unanchored_player");
  }
  if (owners.length > 1) return deny(input, "ambiguous_anchor");
  return owners[0] === input.principal.principalId ? { allowed: true } : deny(input, "principal_not_owner");
}

function deny(input: SimCommandAuthorizationInput, reason: SimCommandDenialReason): SimCommandAuthorization {
  // Diagnostics over exceptions (docs/resilience.md §2): the refusal is a
  // coded warning here and a not-found-shaped result at the caller, so the
  // private cause never becomes a branch-existence oracle for the requester.
  log.warn(SIM_COMMAND_DENIED, "simulation command refused: principal cannot prove branch authority", {
    reason,
    branchId: input.branchId,
    commandId: input.commandId,
    type: input.type,
    principalKind: input.principal.kind,
    principalId: input.principal.principalId,
  });
  return { allowed: false, reason };
}
