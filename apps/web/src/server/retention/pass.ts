/**
 * One bounded retention delete. `run` removes at most one batch of rows the
 * pass's rule says are expired and returns how many it removed; the next
 * maintenance tick takes the next batch. A backlog is worked down over ticks,
 * never in one statement.
 *
 * Expiry is decided from database data alone (timestamps, statuses), so a large
 * number of matching rows is ordinary cleanup — the image sweep's mass-expiry
 * refusal exists for a missing image volume and does not apply here.
 */
export interface RetentionPass {
  /** Summary key in the sweep's job payload and log line, e.g. `eventsExpired`. */
  readonly name: string;
  run(now: Date): Promise<number>;
}

/**
 * Rows one pass may delete per tick. Postgres `DELETE` has no `LIMIT`, so a pass
 * bounds itself with `WHERE id IN (SELECT id FROM … WHERE <expired> LIMIT n)`.
 */
export const RETENTION_BATCH_SIZE = 1000;
