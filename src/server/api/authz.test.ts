import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const getCurrentUser = vi.fn();

vi.mock("@/server/auth", () => ({
  getCurrentUser,
  Unauthenticated: class Unauthenticated extends Error {},
}));

vi.mock("@/server/log", () => ({
  log: { error: vi.fn() },
}));

import { withAdmin, withOwnedChat, withOwnedEntity } from "./authz";

const request = new NextRequest("http://localhost/api/test");
const ctx = <P>(params: P) => ({ params: Promise.resolve(params) });

beforeEach(() => {
  getCurrentUser.mockReset();
  getCurrentUser.mockResolvedValue({ id: "owner", email: "o@example.com", name: "Owner", role: "user" });
});

describe("route authorization wrappers", () => {
  it("passes an owned chat into the handler", async () => {
    const handler = vi.fn(async () => new Response(null, { status: 204 }));
    const route = withOwnedChat<{ chatId: string }, { id: string }>(
      async (user, params) => (user.id === "owner" && params.chatId === "chat-1" ? { id: "chat-1" } : null),
      handler,
    );

    const response = await route(request, ctx({ chatId: "chat-1" }));

    expect(response.status).toBe(204);
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ id: "owner" }),
      { id: "chat-1" },
      request,
      expect.any(Object),
    );
  });

  it("makes missing and cross-owner chats indistinguishable", async () => {
    const route = withOwnedChat<{ chatId: string }, { id: string }>(async () => null, async () => new Response());

    const missing = await route(request, ctx({ chatId: "missing" }));
    const foreign = await route(request, ctx({ chatId: "belongs-to-someone-else" }));

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

    const response = await route(request, ctx({ id: "item-1" }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ kind: "item", value: { id: "item-1" } });
  });

  it("hides admin routes from non-admin users", async () => {
    const handler = vi.fn(async () => new Response(null, { status: 204 }));
    const route = withAdmin(handler);

    const response = await route(request, ctx({}));

    expect(response.status).toBe(404);
    expect(handler).not.toHaveBeenCalled();
  });

  it("allows administrators", async () => {
    getCurrentUser.mockResolvedValue({ id: "admin", email: "a@example.com", name: "Admin", role: "admin" });
    const route = withAdmin(async () => new Response(null, { status: 204 }));

    const response = await route(request, ctx({}));

    expect(response.status).toBe(204);
  });
});
