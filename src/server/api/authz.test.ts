import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const { getCurrentUser, recordSupportAccessAudit } = vi.hoisted(() => ({
  getCurrentUser: vi.fn(),
  recordSupportAccessAudit: vi.fn(),
}));

vi.mock("@/server/auth", () => ({
  getCurrentUser,
  Unauthenticated: class Unauthenticated extends Error {},
}));

vi.mock("@/server/log", () => ({
  log: { error: vi.fn() },
}));

vi.mock("./support", () => ({ recordSupportAccessAudit }));

import {
  withCrossAccountSupport,
  withOwnedChat,
  withOwnedEntity,
  withOwnerAdmin,
  withOwnerAdminOwnedChat,
} from "./authz";

const ctx = <P>(params: P) => ({ params: Promise.resolve(params) });
const request = (path = "/api/test", init: RequestInit = {}) =>
  new NextRequest(`http://localhost${path}`, init);

beforeEach(() => {
  getCurrentUser.mockReset();
  getCurrentUser.mockResolvedValue({ id: "owner", email: "o@example.com", name: "Owner", role: "user" });
  recordSupportAccessAudit.mockReset();
  recordSupportAccessAudit.mockResolvedValue("audit-1");
});

describe("route authorization wrappers", () => {
  it("passes an owned chat into the handler", async () => {
    const req = request();
    const handler = vi.fn(async () => new Response(null, { status: 204 }));
    const route = withOwnedChat<{ chatId: string }, { id: string }>(
      async (user, params) => (user.id === "owner" && params.chatId === "chat-1" ? { id: "chat-1" } : null),
      handler,
    );

    const response = await route(req, ctx({ chatId: "chat-1" }));

    expect(response.status).toBe(204);
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ id: "owner" }),
      { id: "chat-1" },
      req,
      expect.any(Object),
    );
  });

  it("makes missing and cross-owner chats indistinguishable", async () => {
    const route = withOwnedChat<{ chatId: string }, { id: string }>(async () => null, async () => new Response());

    const missing = await route(request(), ctx({ chatId: "missing" }));
    const foreign = await route(request(), ctx({ chatId: "belongs-to-someone-else" }));

    expect(missing.status).toBe(404);
    expect(foreign.status).toBe(404);
    expect(await missing.json()).toEqual(await foreign.json());
  });

  it("wraps authorized entities with a stable discriminant", async () => {
    const route = withOwnedEntity(
      "item",
      async () => ({ id: "item-1" }),
      async (_user, entity) => Response.json(entity),
    );

    const response = await route(request(), ctx({ id: "item-1" }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ kind: "item", value: { id: "item-1" } });
  });

  it("hides owner-admin routes from non-admin users", async () => {
    const handler = vi.fn(async () => new Response(null, { status: 204 }));
    const route = withOwnerAdmin(handler);

    const response = await route(request("/api/admin/self/test"), ctx({}));

    expect(response.status).toBe(404);
    expect(handler).not.toHaveBeenCalled();
  });

  it("allows administrators only in the explicit self namespace", async () => {
    getCurrentUser.mockResolvedValue({ id: "admin", email: "a@example.com", name: "Admin", role: "admin" });
    const handler = vi.fn(async () => new Response(null, { status: 204 }));
    const route = withOwnerAdmin(handler);

    const oldNamespace = await route(request("/api/admin/test"), ctx({}));
    const selfNamespace = await route(request("/api/admin/self/test"), ctx({}));

    expect(oldNamespace.status).toBe(404);
    expect(selfNamespace.status).toBe(204);
    expect(handler).toHaveBeenCalledOnce();
  });

  it("does not let an administrator inspect another owner's chat through a self route", async () => {
    getCurrentUser.mockResolvedValue({ id: "admin", email: "a@example.com", name: "Admin", role: "admin" });
    const handler = vi.fn(async () => new Response(null, { status: 204 }));
    const route = withOwnerAdminOwnedChat<{ chatId: string }, { id: string }>(
      async (user, params) => (params.chatId === "mine" && user.id === "admin" ? { id: "mine" } : null),
      handler,
    );

    const foreign = await route(request("/api/admin/self/chat-inspector/foreign"), ctx({ chatId: "foreign" }));

    expect(foreign.status).toBe(404);
    expect(handler).not.toHaveBeenCalled();
  });

  it("requires elevated authorization and a reason for cross-account support", async () => {
    const resolver = vi.fn(async () => ({
      ownerId: "target-owner",
      resourceType: "chat",
      resourceId: "chat-1",
      value: { id: "chat-1" },
    }));
    const handler = vi.fn(async () => new Response(null, { status: 204 }));
    const route = withCrossAccountSupport(resolver, handler);

    const ordinaryUser = await route(
      request("/api/admin/support/chats/chat-1", { headers: { "x-support-reason": "investigate failure" } }),
      ctx({ chatId: "chat-1" }),
    );
    expect(ordinaryUser.status).toBe(404);

    getCurrentUser.mockResolvedValue({ id: "admin", email: "a@example.com", name: "Admin", role: "admin" });
    const missingReason = await route(request("/api/admin/support/chats/chat-1"), ctx({ chatId: "chat-1" }));
    expect(missingReason.status).toBe(400);
    expect((await missingReason.json()).error.code).toBe("support_reason_required");
    expect(resolver).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });

  it("records every authorized support access before the handler runs", async () => {
    getCurrentUser.mockResolvedValue({ id: "admin", email: "a@example.com", name: "Admin", role: "admin" });
    const order: string[] = [];
    recordSupportAccessAudit.mockImplementation(async () => {
      order.push("audit");
      return "audit-1";
    });
    const route = withCrossAccountSupport(
      async () => ({
        ownerId: "target-owner",
        resourceType: "chat",
        resourceId: "chat-1",
        value: { id: "chat-1" },
      }),
      async (_user, target, access) => {
        order.push("handler");
        return Response.json({ id: target.value.id, reason: access.reason });
      },
    );

    const response = await route(
      request("/api/admin/support/chats/chat-1", {
        headers: { "x-support-reason": "diagnose ticket", "x-support-ticket-id": "SUP-42" },
      }),
      ctx({ chatId: "chat-1" }),
    );

    expect(response.status).toBe(200);
    expect(order).toEqual(["audit", "handler"]);
    expect(recordSupportAccessAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        actorUserId: "admin",
        targetOwnerId: "target-owner",
        resourceType: "chat",
        resourceId: "chat-1",
        reason: "diagnose ticket",
        ticketId: "SUP-42",
      }),
    );
  });

  it("fails closed when a support access cannot be audited", async () => {
    getCurrentUser.mockResolvedValue({ id: "admin", email: "a@example.com", name: "Admin", role: "admin" });
    recordSupportAccessAudit.mockRejectedValue(new Error("database unavailable"));
    const handler = vi.fn(async () => new Response(null, { status: 204 }));
    const route = withCrossAccountSupport(
      async () => ({
        ownerId: "target-owner",
        resourceType: "chat",
        resourceId: "chat-1",
        value: { id: "chat-1" },
      }),
      handler,
    );

    const response = await route(
      request("/api/admin/support/chats/chat-1", { headers: { "x-support-ticket-id": "SUP-42" } }),
      ctx({ chatId: "chat-1" }),
    );

    expect(response.status).toBe(503);
    expect((await response.json()).error.code).toBe("support_audit_unavailable");
    expect(handler).not.toHaveBeenCalled();
  });
});
