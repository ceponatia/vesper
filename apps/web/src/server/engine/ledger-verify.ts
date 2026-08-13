/**
 * The verified idempotent-append judgment shared by the chat lane's durable
 * ledgers — contact events (`chat-contact-events.ts`) and permission events
 * (`chat-permission-events.ts`, romantic-contact-affordances.spec.permission.md
 * §"Events and active projection").
 *
 * Both ledgers write under a (chat, event ref, sequence) idempotency key with
 * `onConflictDoNothing`, and both must then VERIFY every collided key: "the key
 * is taken" and "the key is taken by this very write" are not the same fact,
 * and acknowledging a stranger's row would report somebody else's record as
 * this call's commit. The judgment is one algorithm with two row shapes, so it
 * lives here once — two copies would be two chances for one of them to drift.
 *
 * Everything table-specific stays with the table: the insert statement, the
 * conflicting-row select, and the per-column `matches` comparison are callbacks
 * the owning module supplies. This module owns only the orchestration and the
 * pure mismatch judgment, and it returns values rather than throwing — each
 * caller owns its own abort shape (docs/resilience.md §2).
 */

/** One ledger row's identity, as a mismatch report names it. */
export interface LedgerKey {
  readonly eventRef: string;
  readonly sequence: number;
}

/**
 * The attempted rows whose key is held by a DIFFERENT record, in sequence
 * order. PURE — the whole judgment, extracted so it is testable without a
 * database.
 *
 * An attempted row with no stored counterpart is not a mismatch: it did not
 * conflict, so there is nothing that could disagree with it.
 */
export function ledgerMismatches<
  Attempted extends { readonly eventRef: string; readonly sequence: number },
  Stored extends { readonly sequence: number },
>(
  attempted: readonly Attempted[],
  stored: readonly Stored[],
  matches: (attempted: Attempted, stored: Stored) => boolean,
): readonly LedgerKey[] {
  const bySequence = new Map(stored.map((row) => [row.sequence, row]));
  return attempted
    .flatMap((row) => {
      const existing = bySequence.get(row.sequence);
      if (existing === undefined || matches(row, existing)) return [];
      return [{ eventRef: row.eventRef, sequence: row.sequence }];
    })
    .sort((left, right) => left.sequence - right.sequence);
}

/**
 * Insert, then verify every collided key against what this write meant to put
 * there. Runs inside the caller's transaction (the callbacks close over it).
 *
 * `inserted` counts the rows that landed THIS call; `mismatched` names every
 * attempted key held by a different record. A non-empty `mismatched` means the
 * caller must abort — rows this call DID insert are already part of its
 * transaction and roll back with it.
 */
export async function insertVerifiedLedgerRows<
  Attempted extends { readonly eventRef: string; readonly sequence: number },
  Stored extends { readonly sequence: number },
>(input: {
  readonly rows: readonly Attempted[];
  /** The `onConflictDoNothing` insert; returns the sequences that landed. */
  readonly insert: (rows: readonly Attempted[]) => Promise<readonly { readonly sequence: number }[]>;
  /** The stored rows currently holding these sequences' keys. */
  readonly loadStored: (sequences: readonly number[]) => Promise<readonly Stored[]>;
  /** Is the row already under this key the row this write meant to put there? */
  readonly matches: (attempted: Attempted, stored: Stored) => boolean;
}): Promise<{ inserted: number; mismatched: readonly LedgerKey[] }> {
  if (input.rows.length === 0) return { inserted: 0, mismatched: [] };
  const landed = await input.insert(input.rows);
  const inserted = landed.length;
  if (inserted === input.rows.length) return { inserted, mismatched: [] };
  const landedSequences = new Set(landed.map((row) => row.sequence));
  const conflicted = input.rows.filter((row) => !landedSequences.has(row.sequence));
  const stored = await input.loadStored(conflicted.map((row) => row.sequence));
  return { inserted, mismatched: ledgerMismatches(conflicted, stored, input.matches) };
}
