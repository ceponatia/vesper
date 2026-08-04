import type { NextRequest } from "next/server";
import type { CurrentUser } from "@/server/auth";
import { recordSupportAccessAudit } from "./support";
import { jsonError, type RouteContext, type RouteOptions, withUser } from "./respond";

export const OWNER_ADMIN_API_PREFIX = "/api/admin/self";
export const SUPPORT_ADMIN_API_PREFIX = "/api/admin/support";

export type AuthorizedHandler<P, R> = (
  user: CurrentUser,
  resource: R,
  req: NextRequest,
  ctx: RouteContext<P>,
) => Promise<Response>;

export type ResourceResolver<P, R> = (
  user: CurrentUser,
  params: P,
  req: NextRequest,
) => Promise<R | null>;

export interface OwnedEntity<T, K extends string = string> {
  kind: K;
  value: T;
}

export interface CrossAccountSupportTarget<T> {
  ownerId: string;
  resourceType: string;
  resourceId: string;
  value: T;
}

export interface CrossAccountSupportAccess {
  reason: string | null;
  ticketId: string | null;
}

function isWithinNamespace(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

function hiddenAdminRoute(): Response {
  return jsonError("not_found", "not found", 404);
}

/**
 * Resolve and authorize a sensitive owner-scoped resource before route code
 * runs. A missing row and a row owned by someone else deliberately collapse to
 * the same 404.
 */
export function withAuthorizedResource<P, R>(
  label: string,
  resolve: ResourceResolver<P, R>,
  handler: AuthorizedHandler<P, R>,
  options: RouteOptions = {},
): (req: NextRequest, ctx: RouteContext<P>) => Promise<Response> {
  return withUser<P>(async (user, req, ctx) => {
    const params = await ctx.params;
    const resource = await resolve(user, params, req);
    if (resource === null) return jsonError("not_found", `${label} not found`, 404);
    return handler(user, resource, req, ctx);
  }, options);
}

/** Typed convenience wrapper for routes rooted at /api/chats/[chatId]. */
export function withOwnedChat<P extends { chatId: string }, R>(
  resolve: ResourceResolver<P, R>,
  handler: AuthorizedHandler<P, R>,
  options: RouteOptions = {},
): (req: NextRequest, ctx: RouteContext<P>) => Promise<Response> {
  return withAuthorizedResource("chat", resolve, handler, options);
}

/** Typed convenience wrapper for owned library entities. */
export function withOwnedEntity<P, T, K extends string>(
  kind: K,
  resolve: ResourceResolver<P, T>,
  handler: AuthorizedHandler<P, OwnedEntity<T, K>>,
): (req: NextRequest, ctx: RouteContext<P>) => Promise<Response> {
  return withAuthorizedResource(
    kind,
    async (user, params, req) => {
      const value = await resolve(user, params, req);
      return value === null ? null : { kind, value };
    },
    handler,
  );
}

/**
 * Administrator access to the administrator's own data and developer tools.
 * The wrapper is intentionally valid only beneath `/api/admin/self`; using it
 * from the old ambiguous `/api/admin/*` namespace fails closed with a hidden
 * 404.
 */
export function withOwnerAdmin<P = Record<string, never>>(
  handler: (user: CurrentUser, req: NextRequest, ctx: RouteContext<P>) => Promise<Response>,
): (req: NextRequest, ctx: RouteContext<P>) => Promise<Response> {
  return withUser<P>(async (user, req, ctx) => {
    if (user.role !== "admin" || !isWithinNamespace(req.nextUrl.pathname, OWNER_ADMIN_API_PREFIX)) {
      return hiddenAdminRoute();
    }
    return handler(user, req, ctx);
  });
}

/** Owner-admin access composed with an owner-scoped resource resolver. */
export function withOwnerAdminResource<P, R>(
  label: string,
  resolve: ResourceResolver<P, R>,
  handler: AuthorizedHandler<P, R>,
): (req: NextRequest, ctx: RouteContext<P>) => Promise<Response> {
  return withOwnerAdmin<P>(async (user, req, ctx) => {
    const params = await ctx.params;
    const resource = await resolve(user, params, req);
    if (resource === null) return jsonError("not_found", `${label} not found`, 404);
    return handler(user, resource, req, ctx);
  });
}

/** Owner-admin + owned-chat composition for self-scoped inspection tools. */
export function withOwnerAdminOwnedChat<P extends { chatId: string }, R>(
  resolve: ResourceResolver<P, R>,
  handler: AuthorizedHandler<P, R>,
): (req: NextRequest, ctx: RouteContext<P>) => Promise<Response> {
  return withOwnerAdminResource("chat", resolve, handler);
}

function supportAccessFromHeaders(req: NextRequest): CrossAccountSupportAccess | Response {
  const reason = req.headers.get("x-support-reason")?.trim() || null;
  const ticketId = req.headers.get("x-support-ticket-id")?.trim() || null;
  if (reason === null && ticketId === null) {
    return jsonError("support_reason_required", "cross-account support access requires a reason or ticket ID", 400);
  }
  if ((reason?.length ?? 0) > 500 || (ticketId?.length ?? 0) > 120) {
    return jsonError("invalid_support_reason", "support reason or ticket ID is too long", 400);
  }
  return { reason, ticketId };
}

/**
 * Explicit cross-account support boundary. It is target-only by construction:
 * the resolver must identify one resource and owner, the request must carry a
 * reason or ticket ID, and an awaited append-only audit event lands before any
 * sensitive handler runs. Audit failure fails closed.
 */
export function withCrossAccountSupport<P, R>(
  resolve: ResourceResolver<P, CrossAccountSupportTarget<R>>,
  handler: (
    user: CurrentUser,
    target: CrossAccountSupportTarget<R>,
    access: CrossAccountSupportAccess,
    req: NextRequest,
    ctx: RouteContext<P>,
  ) => Promise<Response>,
): (req: NextRequest, ctx: RouteContext<P>) => Promise<Response> {
  return withUser<P>(async (user, req, ctx) => {
    if (user.role !== "admin" || !isWithinNamespace(req.nextUrl.pathname, SUPPORT_ADMIN_API_PREFIX)) {
      return hiddenAdminRoute();
    }

    const access = supportAccessFromHeaders(req);
    if (access instanceof Response) return access;

    const params = await ctx.params;
    const target = await resolve(user, params, req);
    if (target === null) return jsonError("not_found", "support target not found", 404);
    if (target.ownerId === user.id) {
      return jsonError("support_scope_mismatch", "use the self-scoped admin route for your own data", 400);
    }

    try {
      await recordSupportAccessAudit({
        actorUserId: user.id,
        targetOwnerId: target.ownerId,
        resourceType: target.resourceType,
        resourceId: target.resourceId,
        method: req.method,
        route: req.nextUrl.pathname,
        reason: access.reason,
        ticketId: access.ticketId,
      });
    } catch {
      return jsonError("support_audit_unavailable", "support access could not be audited", 503);
    }

    return handler(user, target, access, req, ctx);
  });
}
