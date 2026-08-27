import { NextResponse, type NextRequest } from "next/server";
import type { ZodType } from "zod";
import { log } from "@/server/log";
import { getCurrentUser, Unauthenticated, type CurrentUser } from "@/server/auth";
import { csrfRejection, type RouteCsrfOptions } from "./csrf";
import { ipRateLimitRejection, userRateLimitRejection } from "./route-limits";
import type { ApiLimitName } from "./rate-limit";

/**
 * Route-handler plumbing (docs/streaming-api.md, docs/resilience.md §7):
 * every error is the `{ error: { code, message } }` envelope with a correct
 * status; handler exceptions become a logged 500, never a leaked stack.
 */

export interface ApiError {
  error: { code: string; message: string };
}

export function jsonError(code: string, message: string, status: number): NextResponse<ApiError> {
  return NextResponse.json({ error: { code, message } }, { status });
}

export function jsonOk<T>(data: T, status = 200): NextResponse<T> {
  return NextResponse.json(data, { status });
}

export interface RouteContext<P> {
  params: Promise<P>;
}

export type UserHandler<P> = (user: CurrentUser, req: NextRequest, ctx: RouteContext<P>) => Promise<Response>;

export interface RouteLimitOptions {
  /**
   * Named per-user burst policy (`rate-limit.ts`). Declared here rather than
   * called inside the handler so the limit cannot be forgotten halfway down a
   * route, and so it is enforced before any body read or query runs.
   */
  limit?: ApiLimitName;
}

export type RouteOptions = RouteCsrfOptions & RouteLimitOptions;

/**
 * Wraps a handler with Better Auth session resolution, per-IP and per-user rate
 * limiting, centralized CSRF origin validation for cookie-bearing mutations, and
 * the error envelope. No signed session ⇒ **401 `unauthenticated`**; auth
 * infrastructure failures stay 500s.
 */
export function withUser<P = Record<string, never>>(
  handler: UserHandler<P>,
  options: RouteOptions = {},
): (req: NextRequest, ctx: RouteContext<P>) => Promise<Response> {
  return withRoute<P>(async (req, ctx) => {
    let user: CurrentUser;
    try {
      user = await getCurrentUser();
    } catch (err) {
      if (err instanceof Unauthenticated) {
        return jsonError("unauthenticated", "sign in to continue", 401);
      }
      log.error("api", "auth resolution failed", { error: errorText(err) });
      return jsonError("auth_unavailable", "could not resolve the current user", 500);
    }
    if (options.limit !== undefined) {
      const limited = userRateLimitRejection(options.limit, user.id, req);
      if (limited) return limited;
    }
    return handler(user, req, ctx);
  }, options);
}

/**
 * Shared envelope/error, per-IP rate limiting, and CSRF protection for routes
 * without a resolved user.
 *
 * The IP window runs **first**, ahead of both CSRF and `withUser`'s session
 * resolution, so an unauthenticated flood costs a map lookup rather than a
 * database round trip.
 */
export function withRoute<P = Record<string, never>>(
  handler: (req: NextRequest, ctx: RouteContext<P>) => Promise<Response>,
  options: RouteOptions = {},
): (req: NextRequest, ctx: RouteContext<P>) => Promise<Response> {
  return async (req, ctx) => {
    try {
      const limited = ipRateLimitRejection(req);
      if (limited) return limited;
      const csrf = csrfRejection(req, options);
      if (csrf) return csrf;
      return await handler(req, ctx);
    } catch (err) {
      log.error("api", `unhandled route error: ${req.method} ${req.nextUrl?.pathname ?? ""}`, {
        error: errorText(err),
      });
      return jsonError("internal", "internal server error", 500);
    }
  };
}

export type BodyResult<T> = { ok: true; value: T } | { ok: false; response: NextResponse<ApiError> };

/**
 * Default request-body cap (4 MB). Next route handlers don't enforce the old
 * Pages-API `bodyParser` limit, so `readBody` guards it here. Sized to admit the
 * largest legitimate body — the avatar-upload data URL (~3 MB after its own cap)
 * — while rejecting multi-hundred-MB DoS payloads.
 */
export const DEFAULT_MAX_BODY_BYTES = 4 * 1024 * 1024;

/**
 * Backstop cap for a stored message's content (chat send/edit, session message
 * edit) — an anti-abuse bound only, NEVER a product limit. Model replies have no
 * output-token cap in either lane, so a deliberately requested lengthy reply can
 * run tens of thousands of characters and must still round-trip through edit.
 */
export const MESSAGE_CONTENT_MAX = 100_000;

export interface ReadBodyOptions {
  /** Maximum number of actual encoded body bytes to buffer (default {@link DEFAULT_MAX_BODY_BYTES}). */
  maxBytes?: number;
}

const TOO_LARGE = () => jsonError("payload_too_large", "request body is too large", 413);

/**
 * Read at most `maxBytes` from the request stream. `Content-Length` is only an
 * early-rejection optimization: omitted, chunked, and falsely-low declarations
 * still hit the same byte counter. Counting chunks by `byteLength` measures the
 * encoded UTF-8 bytes rather than JavaScript code units.
 */
async function readBoundedBytes(req: NextRequest, maxBytes: number): Promise<Uint8Array | NextResponse<ApiError>> {
  const contentLengthHeader = req.headers.get("content-length");
  if (contentLengthHeader !== null) {
    const contentLength = Number(contentLengthHeader);
    if (Number.isFinite(contentLength) && contentLength > maxBytes) return TOO_LARGE();
  }

  const body = req.body;
  if (body === null) return new Uint8Array();

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel("request body exceeds configured byte limit").catch(() => undefined);
        return TOO_LARGE();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/**
 * Zod-validated JSON body with a hard streaming byte cap. Compressed request
 * bodies are rejected because their expanded size cannot be bounded by counting
 * transport bytes alone; route callers currently accept identity encoding only.
 */
export async function readBody<T>(
  req: NextRequest,
  schema: ZodType<T>,
  options: ReadBodyOptions = {},
): Promise<BodyResult<T>> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BODY_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new RangeError("readBody maxBytes must be a non-negative safe integer");
  }

  const contentEncoding = req.headers.get("content-encoding")?.trim().toLowerCase();
  if (contentEncoding && contentEncoding !== "identity") {
    return {
      ok: false,
      response: jsonError("unsupported_content_encoding", "compressed request bodies are not supported", 415),
    };
  }

  const bounded = await readBoundedBytes(req, maxBytes);
  if (bounded instanceof NextResponse) return { ok: false, response: bounded };

  let raw: unknown;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bounded);
    raw = JSON.parse(text);
  } catch {
    return { ok: false, response: jsonError("invalid_json", "request body is not valid JSON", 400) };
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, response: jsonError("invalid_body", summarizeIssues(parsed.error.issues), 400) };
  }
  return { ok: true, value: parsed.data };
}

function summarizeIssues(issues: ReadonlyArray<{ path: PropertyKey[]; message: string }>): string {
  return issues
    .slice(0, 3)
    .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
    .join("; ");
}

/** True when `err` (or anything in its cause chain) is the given pg error code. */
export function isPgError(err: unknown, code: string): boolean {
  let current: unknown = err;
  for (let depth = 0; depth < 6 && current !== null && typeof current === "object"; depth++) {
    if ((current as { code?: unknown }).code === code) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

export function isForeignKeyViolation(err: unknown): boolean {
  return isPgError(err, "23503");
}

export function isUniqueViolation(err: unknown): boolean {
  return isPgError(err, "23505");
}

export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
