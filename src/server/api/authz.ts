import type { NextRequest } from "next/server";
import type { CurrentUser } from "@/server/auth";
import { jsonError, type RouteContext, withUser } from "./respond";

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

/**
 * Resolve and authorize a sensitive resource before route code runs. A missing
 * row and a row owned by someone else deliberately collapse to the same 404.
 */
export function withAuthorizedResource<P, R>(
  label: string,
  resolve: ResourceResolver<P, R>,
  handler: AuthorizedHandler<P, R>,
): (req: NextRequest, ctx: RouteContext<P>) => Promise<Response> {
  return withUser<P>(async (user, req, ctx) => {
    const params = await ctx.params;
    const resource = await resolve(user, params, req);
    if (resource === null) return jsonError("not_found", `${label} not found`, 404);
    return handler(user, resource, req, ctx);
  });
}

/** Require an administrator without revealing that the route exists. */
export function withAdmin<P = Record<string, never>>(
  handler: (user: CurrentUser, req: NextRequest, ctx: RouteContext<P>) => Promise<Response>,
): (req: NextRequest, ctx: RouteContext<P>) => Promise<Response> {
  return withUser<P>(async (user, req, ctx) => {
    if (user.role !== "admin") return jsonError("not_found", "not found", 404);
    return handler(user, req, ctx);
  });
}

/** Typed convenience wrapper for routes rooted at /api/chats/[chatId]. */
export function withOwnedChat<P extends { chatId: string }, R>(
  resolve: ResourceResolver<P, R>,
  handler: AuthorizedHandler<P, R>,
): (req: NextRequest, ctx: RouteContext<P>) => Promise<Response> {
  return withAuthorizedResource("chat", resolve, handler);
}

/** Typed convenience wrapper for owned library entities. */
export function withOwnedEntity<P, T, K extends string>(
  kind: K,
  resolve: ResourceResolver<P, T>,
  handler: AuthorizedHandler<P, OwnedEntity<T, K>>,
): (req: NextRequest, ctx: RouteContext<P>) => Promise<Response> {
  return withAuthorizedResource(kind, async (user, params, req) => {
    const value = await resolve(user, params, req);
    return value === null ? null : { kind, value };
  }, handler);
}

/** Administrator + owned-chat composition for sensitive support/debug routes. */
export function withAdminOwnedChat<P extends { chatId: string }, R>(
  resolve: ResourceResolver<P, R>,
  handler: AuthorizedHandler<P, R>,
): (req: NextRequest, ctx: RouteContext<P>) => Promise<Response> {
  return withAdmin<P>(async (user, req, ctx) => {
    const params = await ctx.params;
    const resource = await resolve(user, params, req);
    if (resource === null) return jsonError("not_found", "chat not found", 404);
    return handler(user, resource, req, ctx);
  });
}
