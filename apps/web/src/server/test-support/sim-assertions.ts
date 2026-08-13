import { count, eq, getTableColumns, getTableName, is } from "drizzle-orm";
import { PgTable, type PgColumn } from "drizzle-orm/pg-core";
import { expect } from "vitest";
import { db, schema } from "@/server/db";

/**
 * Outcome and row-footprint assertions for the durable-simulation suites.
 *
 * Two problems this fixes:
 *
 * 1. `expect(result.status).toBe("accepted")` appears 200+ times, and every one
 *    of those failures reads `expected 'rejected' to be 'accepted'` — the code
 *    and public reason that would explain WHY are in the outcome object nobody
 *    printed. `expectAccepted`/`expectRejected` put the whole outcome in the
 *    message, plus a caller-supplied context string.
 * 2. The Gate 4/5/6 corpora each hand-maintained a `worldFootprint()` listing
 *    every table a lane may write — the assertion that a read wrote NOTHING.
 *    A new store meant remembering to extend three hand lists, and forgetting
 *    was invisible: the invariance proof simply stopped covering the new table.
 *    `branchFootprint` DERIVES the list from the drizzle schema instead.
 */

// ---------------------------------------------------------------------------
// Command outcomes
// ---------------------------------------------------------------------------

function outcomeMessage(expected: string, outcome: unknown, context?: string): string {
  const prefix = context === undefined || context.trim() === "" ? "" : `${context}: `;
  return `${prefix}expected the command to be ${expected}, got ${JSON.stringify(outcome, null, 2)}`;
}

/**
 * Assert a command was accepted, and narrow the outcome union to its accepted
 * member so the caller can read `eventIds`/`lastSequence` without the
 * `if (x.status !== "accepted") throw new Error("unreachable")` dance.
 */
export function expectAccepted<T extends { status: string }>(
  outcome: T,
  context?: string,
): asserts outcome is T & { status: "accepted" } {
  expect(outcome.status, outcomeMessage("accepted", outcome, context)).toBe("accepted");
}

/**
 * Assert a command was rejected with exactly `code`. Matched as an object (not
 * two separate `toBe`s) so a rejection with the RIGHT status and the WRONG code
 * reports both halves at once.
 */
export function expectRejected<T extends { status: string; code?: string }>(
  outcome: T,
  code: string,
  context?: string,
): asserts outcome is T & { status: "rejected" } {
  expect(outcome, outcomeMessage(`rejected as "${code}"`, outcome, context)).toMatchObject({
    status: "rejected",
    code,
  });
}

// ---------------------------------------------------------------------------
// Branch footprint
// ---------------------------------------------------------------------------

interface BranchScopedSimTable {
  /** The SQL table name — the footprint key, so it never drifts from the schema. */
  name: string;
  table: PgTable;
  branchId: PgColumn;
}

let cachedBranchScopedTables: BranchScopedSimTable[] | undefined;

/**
 * Every exported drizzle table whose SQL name starts with `sim_` AND which
 * carries a `branch_id` column, sorted by name.
 *
 * The three `sim_` tables WITHOUT one are excluded by construction, and each is
 * correctly out of scope for a per-branch footprint: `sim_worlds` and
 * `sim_branches` are the containers a branch lives in (a branch row's own count
 * is trivially 1), and `sim_command_requests` is chat-keyed idempotency
 * bookkeeping, not branch state. `sim_provisioning_requests` has a NULLABLE
 * branch_id and is included by the mechanical rule — it reads 0 for every
 * directly-seeded engine branch, so it costs one query and no correctness.
 */
function branchScopedSimTables(): BranchScopedSimTable[] {
  if (cachedBranchScopedTables) return cachedBranchScopedTables;
  // Widened to `unknown[]` so drizzle's `is` narrows cleanly off the schema
  // namespace's heterogeneous union instead of intersecting every member.
  const exported: readonly unknown[] = Object.values(schema);
  const found: BranchScopedSimTable[] = [];
  for (const value of exported) {
    if (!is(value, PgTable)) continue;
    const name = getTableName(value);
    if (!name.startsWith("sim_")) continue;
    const branchId = getTableColumns(value).branchId;
    if (!branchId) continue;
    found.push({ name, table: value, branchId });
  }
  found.sort((left, right) => left.name.localeCompare(right.name));
  cachedBranchScopedTables = found;
  return found;
}

/** The derived table list, for a suite that wants to assert the coverage itself. */
export function branchFootprintTableNames(): string[] {
  return branchScopedSimTables().map((entry) => entry.name);
}

/**
 * Row counts for one branch across every branch-scoped `sim_` table, keyed by
 * SQL table name. The "rows written" meter: snapshot before, snapshot after,
 * and a read that wrote nothing shows an all-zero `footprintDelta`.
 */
export async function branchFootprint(branchId: string): Promise<Record<string, number>> {
  const tables = branchScopedSimTables();
  const counts = await Promise.all(
    tables.map(async (entry) => {
      const rows = await db().select({ value: count() }).from(entry.table).where(eq(entry.branchId, branchId));
      return rows[0]?.value ?? 0;
    }),
  );
  const footprint: Record<string, number> = {};
  tables.forEach((entry, index) => {
    footprint[entry.name] = counts[index] ?? 0;
  });
  return footprint;
}

/**
 * The CHANGED rows only. Dropping the zeros is what makes the assertion
 * readable: `expect(footprintDelta(before, after)).toEqual({})` says "nothing
 * anywhere moved", and a real delta names just the tables that grew.
 */
export function footprintDelta(
  before: Record<string, number>,
  after: Record<string, number>,
): Record<string, number> {
  const delta: Record<string, number> = {};
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const change = (after[key] ?? 0) - (before[key] ?? 0);
    if (change !== 0) delta[key] = change;
  }
  return delta;
}
