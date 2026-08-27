import { NextResponse, type NextRequest } from "next/server";
import type { CurrentUser } from "@/server/auth";
import { HIDDEN_IMAGE_KINDS, type ImageKind } from "@/server/images";
import { recordAbuseSignal } from "./abuse-log";
import { clientIp, hashClientIp } from "./client-ip";
import { laneHealth, laneRetryAfterSeconds, queueSaturated, type ProviderLane } from "./backpressure";
import { checkStorageQuota, consumeDailyBudget, type UsageCounterKind } from "./quota";
import { tooManyRequests, type LimitedResponse } from "./route-limits";

/**
 * Durable cost guards, as route-facing helpers.
 *
 * These sit one layer above the burst limits in `route-limits.ts`: a per-minute
 * window bounds *rate*, these bound *total* — spend per day, disk per account,
 * work in flight — and they are checked explicitly by the routes that incur the
 * cost rather than declaratively by the wrapper, because a lane's cost is a
 * property of what the handler is about to do, not of its URL.
 *
 * Every guard returns a response to send, or null to continue.
 */

function signalContext(req: NextRequest): { route: string; method: string; ipHash: string } {
  return {
    route: req.nextUrl.pathname,
    method: req.method,
    ipHash: hashClientIp(clientIp(req)),
  };
}

/**
 * Charge one unit (or `amount`) of a daily provider budget. Denials are 429s
 * carrying the UTC-midnight reset, so a client can tell "slow down for a minute"
 * apart from "you are done for today".
 */
export async function dailyBudgetRejection(
  kind: UsageCounterKind,
  user: Pick<CurrentUser, "id">,
  req: NextRequest,
  amount = 1,
): Promise<LimitedResponse | null> {
  const decision = await consumeDailyBudget(user.id, kind, amount);
  if (decision.allowed) return null;

  recordAbuseSignal({
    kind: "budget_exceeded",
    ...signalContext(req),
    policy: kind,
    scope: "user",
    ownerId: user.id,
    limit: decision.limit,
    observed: decision.used,
  });

  return tooManyRequests(
    "daily_budget_exceeded",
    "daily limit reached for this kind of request; it resets at midnight UTC",
    {
      limit: decision.limit,
      remaining: decision.remaining,
      resetAt: decision.resetAt,
      retryAfterSeconds: decision.retryAfterSeconds,
    },
    "account",
  );
}

/**
 * Refuse work that would push an account past its stored-image quota. `addBytes`
 * is the caller's best estimate — exact for an upload, a conservative reservation
 * for a render whose output size is not yet known.
 */
export async function storageQuotaRejection(
  user: Pick<CurrentUser, "id">,
  req: NextRequest,
  addBytes = 0,
): Promise<LimitedResponse | null> {
  const decision = await checkStorageQuota(user.id, addBytes);
  if (decision.allowed) return null;

  recordAbuseSignal({
    kind: "storage_quota_exceeded",
    ...signalContext(req),
    policy: "storage_bytes",
    scope: "user",
    ownerId: user.id,
    limit: decision.limit,
    observed: decision.used,
  });

  // Storage frees when the owner deletes something, not on a clock, so there is
  // no honest retry time to advertise — the reset is an action, not an instant.
  return NextResponse.json(
    {
      error: {
        code: "storage_quota_exceeded",
        message: "image storage quota reached; delete some images to free space",
        retry: {
          retryAfterSeconds: 0,
          resetAt: new Date().toISOString(),
          limit: decision.limit,
          remaining: decision.remaining,
          scope: "account" as const,
        },
      },
    },
    { status: 429 },
  );
}

/** Emit the 429 for a job-slot claim the database refused. */
export function jobCapRejection(
  claim: { active: number; limit: number },
  user: Pick<CurrentUser, "id">,
  req: NextRequest,
): LimitedResponse {
  recordAbuseSignal({
    kind: "job_cap_exceeded",
    ...signalContext(req),
    policy: "concurrent_jobs",
    scope: "user",
    ownerId: user.id,
    limit: claim.limit,
    observed: claim.active,
  });

  // A slot frees when work finishes; 10s is a probe interval, not a promise.
  const resetAt = Date.now() + 10_000;
  return tooManyRequests(
    "too_many_active_jobs",
    `you already have ${String(claim.active)} background jobs running; wait for one to finish`,
    { limit: claim.limit, remaining: 0, resetAt, retryAfterSeconds: 10 },
    "account",
  );
}

/**
 * Space a queued render is assumed to consume before its real size is known.
 * Deliberately generous — a stored webp runs a few hundred KB, so reserving this
 * much means the quota stops admitting work slightly early rather than
 * discovering the overage only after the bytes are already on disk.
 */
export const ESTIMATED_RENDER_BYTES = 1_500_000;

export interface ImageRenderGuardOptions {
  /** Renders about to be queued — a batch charges its whole size, not one unit. */
  count?: number;
  /** Override the per-render storage reservation. */
  reserveBytes?: number;
  /**
   * Let a `count` of 0 charge nothing.
   *
   * Off by default, and deliberately opt-in rather than inferred: for every
   * ordinary caller a count of 0 is a caller that forgot to say how much work it
   * was queueing, and silently charging it nothing would turn an arithmetic slip
   * into free provider spend. It is ON for work that genuinely bills no
   * provider — the lab's edge-only extraction, which is a sharp convolution in
   * this process — where charging the floor's one unit of `provider_image_day`
   * makes that number stop meaning what it says.
   *
   * The other legs still run at that count (with the storage reservation
   * keeping its floor of one when it applies at all — see `outputKind`): local
   * work rides the same queue, so it is still refused into a dead lane.
   */
  allowZeroCount?: boolean;
  /**
   * The `images.kind` this render writes. Declaring one of the
   * `HIDDEN_IMAGE_KINDS` skips the storage-quota leg entirely: hidden rows are
   * excluded from the quota's stored-byte sum (`checkStorageQuota`), so their
   * admission must not spend the visible headroom either — an account sitting
   * at its quota can still run identity trials and lab work whose bytes it can
   * neither see nor delete. Backpressure and the daily provider budget are
   * about spend and queue depth, not disk, and still apply.
   */
  outputKind?: ImageKind;
}

/**
 * The full pre-flight every queued image render shares: provider/queue health,
 * storage headroom, and the daily provider budget. Kept as one call so the six
 * image routes cannot drift apart in which of the three they remember to check.
 *
 * The budget is charged **last** on purpose: it is the only guard here that
 * *consumes* something, so a render refused for a dead provider or a full disk
 * must not also cost the caller a unit of their daily allowance.
 *
 * A charge of zero skips that leg entirely rather than consuming 0, so a caller
 * whose provider bill really is nothing cannot be refused by a budget it is not
 * spending — and leaves no counter row claiming it did. The storage leg is
 * likewise skipped when `outputKind` declares a hidden kind, because the quota
 * it guards does not count those bytes (see the option's own doc).
 */
export async function imageRenderRejection(
  user: Pick<CurrentUser, "id">,
  req: NextRequest,
  options: ImageRenderGuardOptions = {},
): Promise<Response | null> {
  const requested = options.count ?? 1;
  const charged = options.allowZeroCount === true ? Math.max(0, requested) : Math.max(1, requested);
  const hiddenOutput = options.outputKind !== undefined && HIDDEN_IMAGE_KINDS.some((kind) => kind === options.outputKind);
  // Storage keeps the floor whatever the bill is: zero-cost work still writes an
  // image, so the reservation is about bytes rather than about spend.
  const reserveBytes = (options.reserveBytes ?? ESTIMATED_RENDER_BYTES) * Math.max(1, charged);

  const shed = await backpressureRejection("image", user, req);
  if (shed) return shed;

  if (!hiddenOutput) {
    const overQuota = await storageQuotaRejection(user, req, reserveBytes);
    if (overQuota) return overQuota;
  }

  if (charged === 0) return null;
  return dailyBudgetRejection("provider_image_day", user, req, charged);
}

/** Base64 carries 3 bytes per 4 characters; close enough to charge a quota with. */
export function decodedDataUrlBytes(dataUrl: string): number {
  const comma = dataUrl.indexOf(",");
  const payload = comma === -1 ? dataUrl.length : dataUrl.length - comma - 1;
  return Math.ceil((payload * 3) / 4);
}

/**
 * Pre-flight for a synchronous player upload: storage headroom first, then the
 * daily accepted-bytes budget.
 *
 * Charged from the *declared* payload rather than the stored result, because the
 * decision has to happen before the bytes are written — and because the abuse
 * being bounded is submission volume, which is real whether or not the image
 * survives decoding.
 */
export async function uploadRejection(
  user: Pick<CurrentUser, "id">,
  req: NextRequest,
  dataUrl: string,
): Promise<Response | null> {
  const bytes = decodedDataUrlBytes(dataUrl);
  const overQuota = await storageQuotaRejection(user, req, bytes);
  if (overQuota) return overQuota;
  return dailyBudgetRejection("upload_bytes_day", user, req, bytes);
}

export type BackpressureResponse = NextResponse<{
  error: { code: string; message: string; retry: { retryAfterSeconds: number } };
}>;

/**
 * Shed expensive work when the provider lane is tripped or the queue is full.
 *
 * 503 rather than 429: nothing the caller did is wrong, and the distinction
 * matters to a client deciding whether to back off (429) or fail over (503).
 * Only ever applied to work that has not started — never to an in-flight turn.
 */
export async function backpressureRejection(
  lane: ProviderLane,
  user: Pick<CurrentUser, "id">,
  req: NextRequest,
): Promise<BackpressureResponse | null> {
  const health = laneHealth(lane);
  const saturated = health === "unhealthy" ? false : await queueSaturated();
  if (health !== "unhealthy" && !saturated) return null;

  const retryAfterSeconds = health === "unhealthy" ? laneRetryAfterSeconds(lane) : 15;
  recordAbuseSignal({
    kind: "backpressure_shed",
    ...signalContext(req),
    policy: health === "unhealthy" ? `lane:${lane}` : "queue_depth",
    scope: "user",
    ownerId: user.id,
    limit: 0,
    observed: retryAfterSeconds,
  });

  return NextResponse.json(
    {
      error: {
        code: "temporarily_unavailable",
        message:
          health === "unhealthy"
            ? "the image or model provider is failing right now; try again shortly"
            : "the work queue is saturated; try again shortly",
        retry: { retryAfterSeconds },
      },
    },
    { status: 503, headers: { "Retry-After": String(retryAfterSeconds) } },
  );
}
