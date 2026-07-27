import { and, eq, inArray, notExists, sql } from "drizzle-orm";
import {
  characterChats,
  db,
  simBranches,
  simProvisioningPendingStates,
  simProvisioningRequests,
  simWorlds,
  type Db,
} from "@/server/db";
import { log } from "@/server/log";

/**
 * A successor world's one destructive verb (successor-world-lifecycle.plan.md,
 * owner ruling E20-1).
 *
 * The schema makes it a single statement: `sim_branches` cascades from
 * `sim_worlds` and every branch-scoped table cascades from `sim_branches`, so
 * deleting the world row takes the whole graph — branches, cast, space, items,
 * bodies, events, commands, triggers, memory documents, all of it. The
 * chat-side FK (`character_chats.sim_branch_id → sim_branches.id`) is
 * `set null`, so a chat that outlives its world is simply unrouted rather than
 * broken.
 *
 * The standalone verb — deleting a world that no chat is taking with it:
 * provisioning's compensating cleanup (a failed build leaves nothing behind)
 * and the orphan sweeper below. `deleteChat` keeps its own copy of the
 * statement because there it must run INSIDE the chat's delete transaction.
 * Keeping this out of the route layer also keeps the ownership guardrail's
 * "every route mutation is owner-scoped" rule honest, since `sim_worlds`
 * deliberately carries no owner column (the chat anchor is the successor lane's
 * only account boundary).
 */
export async function deleteSimWorldGraph(worldId: string, database: Db = db()): Promise<void> {
  await database.delete(simWorlds).where(eq(simWorlds.id, worldId));
}

/**
 * How long a world is protected from the sweeper purely for being young. Long
 * enough that a synchronous provision (seconds) plus any operator retry is never
 * mistaken for an orphan; short enough that the one-time cleanup run at deploy
 * still reclaims the historical leak on its first pass.
 */
export const DEFAULT_ORPHAN_GRACE_MS = 60 * 60 * 1000;

/**
 * Upper bound on one pass. The delete loop is per-world (see below), so an
 * unbounded candidate set would turn a single admin call into an unbounded run;
 * `truncated` tells the operator to call again rather than silently under-report.
 */
const SWEEP_LIMIT = 500;

export interface SweepOrphanWorldsOptions {
  /** Report what would be deleted and delete nothing. */
  dryRun?: boolean;
  /** Override the age a world must reach before it is eligible (ms). */
  graceMs?: number;
}

/** One world the sweep selected but could not delete — the sweep continued past it. */
export interface OrphanSweepFailure {
  worldId: string;
  error: string;
}

export interface OrphanSweepResult {
  /** Worlds matching the orphan predicate at scan time, oldest first. */
  candidateWorldIds: string[];
  /** Worlds actually deleted. Empty on a dry run. */
  deletedWorldIds: string[];
  /** Per-world diagnostics for the deletes that threw. */
  failures: OrphanSweepFailure[];
  dryRun: boolean;
  /** The grace window actually applied, after clamping. */
  graceMs: number;
  /** The candidate set hit `SWEEP_LIMIT` — call again to finish. */
  truncated: boolean;
}

/**
 * Reclaim successor worlds nothing can ever reach again
 * (successor-world-lifecycle.plan.md slice 2, owner ruling E20-2).
 *
 * A world is an ORPHAN when all three hold:
 *
 *  1. **Unrouted** — no `character_chats` row references any of its branches
 *     through `sim_branch_id`. That reference is the successor lane's only
 *     ownership anchor (`sim_worlds` carries no owner column), so a world with
 *     no chat pointing into it is unreachable by construction: no route, no
 *     read, no delete can ever name it again.
 *  2. **Not in flight** — no `sim_provisioning_requests` row in a non-terminal
 *     state (`simProvisioningPendingStates`) names it. A half-built world is
 *     unrouted by definition until the authority flip, and its record is what
 *     says a retry still intends to finish it.
 *  3. **Older than the grace window** — the belt to (2)'s braces, and the
 *     protection a world enjoys in the seconds between `provisionStarterWorld`
 *     committing and the record advancing to `world_created`. Measured on the
 *     DATABASE clock (`sim_worlds.created_at` vs `now()`), never the app's, so
 *     clock skew cannot shorten it.
 *
 * Slice 1 made new leaks unreachable (a deleted successor chat now takes its
 * world in-tx), so this exists for the historical leak plus the one degraded
 * path that still admits a new one: a chat whose `sim_branch_id` points at a
 * branch that has vanished deletes anyway and names this sweeper as the reclaim
 * path (`deleteChat`, `chat.delete_sim_branch_missing`).
 *
 * Deletion is a per-world loop rather than one `DELETE … WHERE id IN (…)`: the
 * cascade behind each world is large, and one world that cannot be deleted must
 * not abort the reclaim of the rest (docs/resilience.md — degraded defaults over
 * failed operations, diagnostics over exceptions). Every failure is a structured
 * warn and lands in the returned `failures`; the pass still reports honestly.
 */
export async function sweepOrphanSimWorlds(options: SweepOrphanWorldsOptions = {}): Promise<OrphanSweepResult> {
  const dryRun = options.dryRun ?? false;
  // A negative or non-finite override would silently widen the predicate to
  // "every world"; clamp rather than throw, and report what was applied.
  const requested = options.graceMs ?? DEFAULT_ORPHAN_GRACE_MS;
  const graceMs = Number.isFinite(requested) && requested > 0 ? Math.floor(requested) : 0;
  const database = db();

  const candidates = await database
    .select({ id: simWorlds.id })
    .from(simWorlds)
    .where(
      and(
        sql`${simWorlds.createdAt} <= now() - ${graceMs} * interval '1 millisecond'`,
        notExists(
          database
            .select({ present: sql<number>`1` })
            .from(simBranches)
            .innerJoin(characterChats, eq(characterChats.simBranchId, simBranches.id))
            .where(eq(simBranches.worldId, simWorlds.id)),
        ),
        notExists(
          database
            .select({ present: sql<number>`1` })
            .from(simProvisioningRequests)
            .where(
              and(
                eq(simProvisioningRequests.worldId, simWorlds.id),
                inArray(simProvisioningRequests.state, [...simProvisioningPendingStates]),
              ),
            ),
        ),
      ),
    )
    .orderBy(simWorlds.createdAt)
    .limit(SWEEP_LIMIT + 1);

  const truncated = candidates.length > SWEEP_LIMIT;
  const candidateWorldIds = candidates.slice(0, SWEEP_LIMIT).map((row) => row.id);
  const deletedWorldIds: string[] = [];
  const failures: OrphanSweepFailure[] = [];

  if (!dryRun) {
    for (const worldId of candidateWorldIds) {
      try {
        await deleteSimWorldGraph(worldId, database);
        deletedWorldIds.push(worldId);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        failures.push({ worldId, error: detail });
        log.warn("engine.sim.sweep", "an orphan world could not be deleted; continuing the sweep", {
          code: "sim.sweep_world_failed",
          worldId,
          error: detail,
        });
      }
    }
  }

  log.info("engine.sim.sweep", dryRun ? "orphan world sweep (dry run)" : "orphan world sweep complete", {
    code: "sim.sweep_complete",
    dryRun,
    graceMs,
    candidates: candidateWorldIds.length,
    deleted: deletedWorldIds.length,
    failed: failures.length,
    truncated,
  });

  return { candidateWorldIds, deletedWorldIds, failures, dryRun, graceMs, truncated };
}
