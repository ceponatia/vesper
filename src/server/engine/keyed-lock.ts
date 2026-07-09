/**
 * In-process per-key serialization (codebase-review A6/A8): the chat lane has no
 * DB-level concurrency invariant (the session lane's CAS + per-session queue is its
 * equivalent), so exchanges and summary folds for the same (owner, character) are
 * serialized here instead. In-process is correct on the single-machine Fly deploy —
 * revisit with a row-level CAS if the app ever scales past one machine.
 */

interface LockEntry {
  /** Settles when the current holder (and everyone queued before you) releases. */
  chain: Promise<void>;
  /** Holders + waiters; the entry is dropped when it reaches 0. */
  count: number;
}

const locks = new Map<string, LockEntry>();

/** True while any holder or waiter is active on the key. */
export function keyedLockBusy(key: string): boolean {
  return (locks.get(key)?.count ?? 0) > 0;
}

/** Run `fn` with the key held; concurrent callers queue in FIFO order. */
export async function withKeyedLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const entry = locks.get(key) ?? { chain: Promise.resolve(), count: 0 };
  entry.count += 1;
  locks.set(key, entry);
  const prev = entry.chain;
  let release!: () => void;
  entry.chain = new Promise<void>((resolve) => {
    release = resolve;
  });
  await prev;
  try {
    return await fn();
  } finally {
    release();
    entry.count -= 1;
    if (entry.count === 0) locks.delete(key);
  }
}

/**
 * Non-blocking variant: run `fn` with the key held, or return `null` immediately
 * if the key is busy (the caller turns that into a 409). The busy check and the
 * acquisition happen in the same synchronous tick, so two callers can't both pass.
 */
export function tryKeyedLock<T>(key: string, fn: () => Promise<T>): Promise<T> | null {
  if (keyedLockBusy(key)) return null;
  return withKeyedLock(key, fn);
}

/**
 * Bounded waiting acquire (data-loss-rerun fix). Poll `tryKeyedLock` until it wins the
 * key or `timeoutMs` elapses; resolve to `{ held }` (the held-lock promise, which stays
 * pending until `fn` completes) on success, or `null` on timeout. Distinct from
 * `withKeyedLock`, whose FIFO queue waits **unboundedly**: this gives up so the caller can
 * turn a miss into a 409 having mutated nothing. Used by the atomic rerun — stop the
 * in-flight reply, then wait a short window for its lock to release before touching the
 * transcript. `onAttempt` runs immediately before each try (the rerun re-issues its stop
 * there, so a reply that only registered its abort handler after the first attempt is
 * still caught). Each `tryKeyedLock` win is atomic within its tick, so polling can never
 * let two acquirers through.
 *
 * The held-lock promise is returned WRAPPED (`{ held }`), not bare: this function is async,
 * so returning the bare promise would await-flatten it — and in the exchange pipeline that
 * promise never resolves until the lock is released, which would hang the acquire itself.
 */
export async function acquireKeyedLockWithin<T>(
  key: string,
  fn: () => Promise<T>,
  opts: { timeoutMs: number; pollMs?: number; onAttempt?: () => void },
): Promise<{ held: Promise<T> } | null> {
  const pollMs = Math.max(1, opts.pollMs ?? 100);
  const deadline = Date.now() + opts.timeoutMs;
  for (;;) {
    opts.onAttempt?.();
    const held = tryKeyedLock(key, fn);
    if (held !== null) return { held };
    if (Date.now() >= deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}
