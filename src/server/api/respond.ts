import { NextResponse, type NextRequest } from "next/server";
import type { ZodType } from "zod";
import { log } from "@/server/log";
import { getCurrentUser, Unauthenticated, type CurrentUser } from "@/server/auth";

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

/**
 * Wraps a handler with Better Auth session resolution and the error envelope.
 * No signed session ⇒ **401 `unauthenticated`** (never a fabricated user); a
 * genuine resolution failure (DB down) stays a **500 `auth_unavailable`**. The
 * two are distinct codes so clients can redirect-to-sign-in vs. retry.
 */
export function withUser<P = Record<string, never>>(
  handler: UserHandler<P>,
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
    return handler(user, req, ctx);
  });
}

/** Same envelope/error protection for routes that need no resolved user. */
export function withRoute<P = Record<string, never>>(
  handler: (req: NextRequest, ctx: RouteContext<P>) => Promise<Response>,
): (req: NextRequest, ctx: RouteContext<P>) => Promise<Response> {
  return async (req, ctx) => {
    try {
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

/** Zod-validated request body; malformed JSON and schema failures are 400s. */
export async function readBody<T>(req: NextRequest, schema: ZodType<T>): Promise<BodyResult<T>> {
  let raw: unknown;
  try {
    raw = await req.json();
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
