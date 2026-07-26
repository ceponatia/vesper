import { eq } from "drizzle-orm";
import type { PrincipalKind } from "@/contracts/simulation/envelopes";
import { characterChats, type Db } from "@/server/db";
import { log } from "@/server/log";

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
 *   (`simPlayerEnvelope`), and its `principalId` is a `users.id` — so it is the
 *   one kind whose claim is checked against the branch's owning chat.
 * - `director` / `storyteller` are the authoring surfaces: their only HTTP entry
 *   points are the admin sim routes, which 404 for a non-admin role before an
 *   envelope is ever built, plus world provisioning (`/api/successor-chats`),
 *   which seeds a branch the caller just minted and does not yet anchor. Their
 *   ids are account ids but an admin is by construction allowed on any branch,
 *   so matching them against the owner would deny every legitimate use.
 * - `npc_policy` / `npc_deliberator` / `system` / `migration` are engine-internal
 *   (the arbiter, the scheduler drain, the world seeders). Their `principalId` is
 *   a fixed label like `sim-scheduler` — not an account — and nothing outside the
 *   server can mint one, so there is no claim to verify.
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
 * A branch NO chat points at is unanchored — a fixture branch, a fork not yet
 * linked, or a world provisioned in the moments before its chat row exists
 * (`/api/successor-chats` seeds the authored relationship first, then flips the
 * chat onto the branch). There is no account boundary to cross there, and no
 * HTTP surface lets a player name a branch id: the player route derives it from
 * a chat it already proved they own, and the admin route is role-gated. So an
 * unanchored branch admits; an ANCHORED one admits only its owner.
 */
export async function authorizeSimulationCommand(
  input: SimCommandAuthorizationInput,
  database: Db,
): Promise<SimCommandAuthorization> {
  if (!requiresOwnerMatch(input.principal.kind)) return { allowed: true };

  const owners = await anchorOwnerIds(input.branchId, database);
  if (owners.length === 0) return { allowed: true };
  if (owners.length > 1) return deny(input, "ambiguous_anchor");
  return owners[0] === input.principal.principalId ? { allowed: true } : deny(input, "principal_not_owner");
}

function deny(input: SimCommandAuthorizationInput, reason: SimCommandDenialReason): SimCommandAuthorization {
  // Diagnostics over exceptions (docs/resilience.md §2): the refusal is a
  // coded warning here and a not-found-shaped result at the caller, so the
  // private cause never becomes a branch-existence oracle for the requester.
  log.warn(SIM_COMMAND_DENIED, "simulation command refused: principal is not the branch owner", {
    reason,
    branchId: input.branchId,
    commandId: input.commandId,
    type: input.type,
    principalKind: input.principal.kind,
    principalId: input.principal.principalId,
  });
  return { allowed: false, reason };
}
