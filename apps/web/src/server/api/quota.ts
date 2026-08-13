import { and, eq, notInArray, sql } from "drizzle-orm";
import { db, images, usageCounters } from "@/server/db";
import { HIDDEN_IMAGE_KINDS } from "@/server/images";
import { log } from "@/server/log";
import { errorText } from "./respond";

/**
 * Durable cost controls — the half of rate-limits.plan.md that must survive a
 * process restart.
 *
 * Burst windows live in memory because losing them is harmless. These do not: an
 * in-memory daily budget is cleared by crash-looping the process, which is
 * exactly the move an abuser would make, so spend and disk are accounted in
 * Postgres.
 */

export const USAGE_COUNTER_KINDS = [
  /** Narrative / agent / tool model calls. */
  "provider_text_day",
  /** Image renders reaching a paid provider. */
  "provider_image_day",
  /** Embedding calls. */
  "provider_embed_day",
  /** Player-supplied bytes accepted per day (distinct from total stored bytes). */
  "upload_bytes_day",
] as const;

export type UsageCounterKind = (typeof USAGE_COUNTER_KINDS)[number];

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Per-account daily ceilings. Counted in **calls**, not currency: per-model
 * prices live outside the app and would rot in here (rate-limits.plan.md OQ1).
 * Sized generously — these are an abuse backstop, not a product plan, and a
 * legitimate heavy session should never see one.
 */
export function dailyBudget(kind: UsageCounterKind): number {
  switch (kind) {
    case "provider_text_day":
      return envInt("LIMIT_PROVIDER_TEXT_DAY", 1_000);
    case "provider_image_day":
      return envInt("LIMIT_PROVIDER_IMAGE_DAY", 200);
    case "provider_embed_day":
      return envInt("LIMIT_PROVIDER_EMBED_DAY", 5_000);
    case "upload_bytes_day":
      return envInt("LIMIT_UPLOAD_BYTES_DAY", 500 * 1024 * 1024);
  }
}

/** Total stored image bytes admitted per account. */
export function storageQuotaBytes(): number {
  return envInt("LIMIT_STORAGE_BYTES", 2 * 1024 * 1024 * 1024);
}

/** UTC calendar day, `YYYY-MM-DD` — the counter's window key. */
export function utcDayKey(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/** Epoch ms of the next UTC midnight: when a day counter rolls over. */
export function nextUtcDayStart(now: Date = new Date()): number {
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
}

export interface BudgetDecision {
  readonly allowed: boolean;
  readonly kind: UsageCounterKind;
  readonly limit: number;
  readonly used: number;
  readonly remaining: number;
  readonly resetAt: number;
  readonly retryAfterSeconds: number;
}

function decision(
  allowed: boolean,
  kind: UsageCounterKind,
  limit: number,
  used: number,
  now: Date,
): BudgetDecision {
  const resetAt = nextUtcDayStart(now);
  return {
    allowed,
    kind,
    limit,
    used,
    remaining: Math.max(0, limit - used),
    resetAt,
    retryAfterSeconds: allowed ? 0 : Math.max(1, Math.ceil((resetAt - now.getTime()) / 1000)),
  };
}

async function currentAmount(ownerId: string, kind: UsageCounterKind, day: string): Promise<number> {
  const [row] = await db()
    .select({ amount: usageCounters.amount })
    .from(usageCounters)
    .where(
      and(
        eq(usageCounters.ownerId, ownerId),
        eq(usageCounters.kind, kind),
        eq(usageCounters.windowStart, day),
      ),
    )
    .limit(1);
  return row?.amount ?? 0;
}

/**
 * Consume `amount` of a daily budget, atomically.
 *
 * The whole check-and-increment is one statement so parallel turns cannot both
 * read "just under the limit" and both proceed. `setWhere` makes the increment
 * itself conditional: when it would breach the ceiling the update matches no
 * row, nothing is written, and the empty `RETURNING` *is* the denial. A rejected
 * call therefore never inflates the counter — repeatedly hitting a closed budget
 * cannot extend the lockout past midnight.
 *
 * Degradation (docs/resilience.md): if the counter table is unreachable the call
 * is **allowed** with a diagnostic. These are cost backstops layered behind
 * per-minute limits already enforced in memory; failing every turn closed
 * because an accounting table blipped trades a bounded cost risk for a total
 * outage.
 */
export async function consumeDailyBudget(
  ownerId: string,
  kind: UsageCounterKind,
  amount = 1,
  now: Date = new Date(),
): Promise<BudgetDecision> {
  const limit = dailyBudget(kind);
  const day = utcDayKey(now);

  if (amount > limit) return decision(false, kind, limit, limit, now);

  try {
    const [row] = await db()
      .insert(usageCounters)
      .values({ ownerId, kind, windowStart: day, amount })
      .onConflictDoUpdate({
        target: [usageCounters.ownerId, usageCounters.kind, usageCounters.windowStart],
        // Hand-qualified: drizzle renders bare column refs unqualified in some
        // clause positions, and an unqualified `amount` here would resolve to the
        // proposed row rather than the stored one.
        set: {
          amount: sql`"usage_counters"."amount" + ${amount}`,
          updatedAt: now,
        },
        setWhere: sql`"usage_counters"."amount" + ${amount} <= ${limit}`,
      })
      .returning({ amount: usageCounters.amount });

    if (row) return decision(true, kind, limit, row.amount, now);
    return decision(false, kind, limit, await currentAmount(ownerId, kind, day), now);
  } catch (err) {
    log.error("api.limits", "daily budget accounting unavailable; allowing", {
      kind,
      ownerId,
      error: errorText(err),
    });
    return decision(true, kind, limit, 0, now);
  }
}

/** Read a counter without consuming it (surfacing remaining budget, tests). */
export async function readDailyUsage(
  ownerId: string,
  kind: UsageCounterKind,
  now: Date = new Date(),
): Promise<BudgetDecision> {
  const limit = dailyBudget(kind);
  const used = await currentAmount(ownerId, kind, utcDayKey(now));
  return decision(used < limit, kind, limit, used, now);
}

export interface StorageQuotaDecision {
  readonly allowed: boolean;
  readonly limit: number;
  readonly used: number;
  readonly remaining: number;
}

/**
 * Per-owner stored-image quota.
 *
 * Derived from `SUM(images.bytes)` rather than tracked in a counter, and that is
 * deliberate: images are deleted through several paths (single, bulk, chat
 * cleanup, orphan sweep, cascade), and a counter would need every one of them to
 * remember to decrement. A sum cannot drift, and freeing space works by itself.
 *
 * Hidden internal kinds (`HIDDEN_IMAGE_KINDS`) are excluded: those bytes are the
 * system's own bookkeeping, invisible to their owner and not theirs to delete,
 * so they must not eat into the space the user can actually see and manage.
 *
 * Degrades open on a query failure, for the same reason budgets do.
 */
export async function checkStorageQuota(ownerId: string, addBytes = 0): Promise<StorageQuotaDecision> {
  const limit = storageQuotaBytes();
  try {
    const [row] = await db()
      .select({ used: sql<number>`COALESCE(SUM(${images.bytes}), 0)::bigint` })
      .from(images)
      .where(and(eq(images.ownerId, ownerId), notInArray(images.kind, [...HIDDEN_IMAGE_KINDS])));
    const used = Number(row?.used ?? 0);
    return {
      allowed: used + addBytes <= limit,
      limit,
      used,
      remaining: Math.max(0, limit - used),
    };
  } catch (err) {
    log.error("api.limits", "storage quota accounting unavailable; allowing", {
      ownerId,
      error: errorText(err),
    });
    return { allowed: true, limit, used: 0, remaining: limit };
  }
}
