import { asc, eq } from "drizzle-orm";
import type { BranchForkResult, SimulationBranchEvent } from "@/contracts/simulation/branching";
import type { PrincipalKind } from "@/contracts/simulation/envelopes";
import { newId } from "@/lib/ids";
import { db, simBranches, simEvents } from "@/server/db";
import { branchEventFromRow, forkBranch, loadBranchAncestry, readBranchAncestryEvents } from "@/server/engine";

/**
 * Event read-back and fork-at-head for the durable-simulation suites.
 *
 * Every suite grew its own `branchEvents(branchId)`: select from `sim_events`,
 * order by sequence, map through the row parser. Two divergences made the copies
 * worth collapsing rather than deleting one by one:
 *
 * - household-store.int.test.ts had hand-inlined `rowToEvent` — a byte copy of
 *   the exported `branchEventFromRow`, which would silently rot the day the
 *   event envelope gains a field. This module always uses the real exported
 *   mapper.
 * - gate3-corpus.int.test.ts needed the ANCESTRY-aware form (a forked child's
 *   logical stream is its own rows plus each ancestor's, bounded by the fork
 *   chain), which a plain `branchId =` select silently under-reads. That is the
 *   `includeAncestry` flag, and it routes through the production R4 read helper
 *   so the bounds are never a test's to compute.
 */

export interface ReadBranchEventsOptions {
  /** Filter to these event types (the production ancestry read filters in SQL). */
  types?: readonly string[];
  /**
   * Read the branch's LOGICAL stream (own rows + inherited ancestor rows bounded
   * by the fork chain) rather than only the rows it owns. Required for any
   * assertion about a forked child's history.
   */
  includeAncestry?: boolean;
}

/** One branch's events, sequence-ordered, parsed back into the typed union. */
export async function readBranchEvents(
  branchId: string,
  options: ReadBranchEventsOptions = {},
): Promise<SimulationBranchEvent[]> {
  const { types } = options;
  if (options.includeAncestry) {
    const ancestry = await loadBranchAncestry(db(), branchId);
    return readBranchAncestryEvents(db(), ancestry, types === undefined ? {} : { types });
  }
  const rows = await db()
    .select()
    .from(simEvents)
    .where(eq(simEvents.branchId, branchId))
    .orderBy(asc(simEvents.sequence));
  const events = rows.map(branchEventFromRow);
  return types === undefined ? events : events.filter((event) => types.includes(event.type));
}

/**
 * The event TYPES a branch appended, in sequence order — the "what happened, in
 * what order" assertion most store suites actually want (duplicates kept: a type
 * appearing twice is a fact about the stream).
 */
export async function readBranchEventTypes(branchId: string): Promise<string[]> {
  const events = await readBranchEvents(branchId);
  return events.map((event) => event.type);
}

/**
 * The payload of the LAST event of `type` on this branch, or `undefined` when
 * the branch never appended one. Returned as `unknown` on purpose — the payload
 * union is per-type, so the caller narrows it (usually via `toMatchObject`).
 */
export async function latestEventPayload(branchId: string, type: string): Promise<unknown> {
  const events = await readBranchEvents(branchId, { types: [type] });
  return events.at(-1)?.payload;
}

export interface ForkAtHeadInput {
  parentBranchId: string;
  /** Minted when absent. */
  childBranchId?: string;
  reason: string;
  /** Forks act on branches, not actors, so a fork principal carries no actor set. */
  principal?: { kind: PrincipalKind; principalId: string };
}

export interface ForkAtHeadResult {
  childBranchId: string;
  /** The parent head the child inherited — every event at or below it. */
  atSequence: number;
  /** The parent's own event stream, for the replay-parity assertion that follows. */
  parentEvents: SimulationBranchEvent[];
  /** The production fork result — trigger inheritance assertions read this. */
  fork: BranchForkResult;
}

/**
 * Fork a branch at its current head — the "and forks with parity" tail every
 * durable store suite ends on. The parent's head must be read first (a fork past
 * it is rejected), and the parent's events are handed back because the parity
 * check invariably replays them against the child's rows.
 */
export async function forkAtHead(input: ForkAtHeadInput): Promise<ForkAtHeadResult> {
  const [parent] = await db()
    .select({ headSequence: simBranches.headSequence })
    .from(simBranches)
    .where(eq(simBranches.id, input.parentBranchId))
    .limit(1);
  if (!parent) throw new Error(`parent branch row missing: ${input.parentBranchId}`);

  const childBranchId = input.childBranchId ?? newId();
  const fork = await forkBranch({
    parentBranchId: input.parentBranchId,
    childBranchId,
    atSequence: parent.headSequence,
    principal: input.principal ?? { kind: "storyteller", principalId: "gm-1" },
    reason: input.reason,
  });

  return {
    childBranchId,
    atSequence: parent.headSequence,
    parentEvents: await readBranchEvents(input.parentBranchId),
    fork,
  };
}
