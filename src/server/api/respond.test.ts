import { describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { z } from "zod";
import {
  isForeignKeyViolation,
  isPgError,
  isUniqueViolation,
  jsonError,
  jsonOk,
  readBody,
  withRoute,
  withUser,
} from "./respond";

vi.mock("@/server/auth", () => {
  // Class defined inside the factory so the instanceof check in withUser uses the
  // exact same reference the test throws — vi.mock is hoisted above the import.
  class Unauthenticated extends Error {}
  return { getCurrentUser: vi.fn(), Unauthenticated };
});

import { getCurrentUser, Unauthenticated } from "@/server/auth";

const TEST_USER = { id: "u1", email: "t@test.local", name: "Tester", role: "user" as const };

function post(body: string): NextRequest {
  return new NextRequest("http://test.local/api/x", {
    method: "POST",
    body,
    headers: { "content-type": "application/json" },
  });
}

const emptyCtx = { params: Promise.resolve({}) };

describe("error envelope", () => {
  it("shapes { error: { code, message } } with the given status", async () => {
    const res = jsonError("not_found", "nope", 404);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: { code: "not_found", message: "nope" } });
  });

  it("jsonOk passes data and status through", async () => {
    const res = jsonOk({ hello: true }, 201);
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ hello: true });
  });
});

describe("readBody", () => {
  const schema = z.object({ name: z.string().min(1) });

  it("returns parsed value for a valid body", async () => {
    const result = await readBody(post(JSON.stringify({ name: "Maya" })), schema);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.name).toBe("Maya");
  });

  it("400s with invalid_json on malformed JSON", async () => {
    const result = await readBody(post("{nope"), schema);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(400);
      const body = await result.response.json();
      expect(body.error.code).toBe("invalid_json");
    }
  });

  it("400s with invalid_body and a path summary on schema failure", async () => {
    const result = await readBody(post(JSON.stringify({ name: 5 })), schema);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(400);
      const body = await result.response.json();
      expect(body.error.code).toBe("invalid_body");
      expect(body.error.message).toContain("name");
    }
  });
});

describe("withUser / withRoute", () => {
  it("passes the resolved user to the handler", async () => {
    vi.mocked(getCurrentUser).mockResolvedValueOnce(TEST_USER);
    const handler = withUser(async (user) => jsonOk({ id: user.id }));
    const res = await handler(new NextRequest("http://test.local/api/x"), emptyCtx);
    expect(await res.json()).toEqual({ id: "u1" });
  });

  it("401s with unauthenticated when no session resolves", async () => {
    vi.mocked(getCurrentUser).mockRejectedValueOnce(new Unauthenticated());
    const handler = withUser(async () => jsonOk({}));
    const res = await handler(new NextRequest("http://test.local/api/x"), emptyCtx);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe("unauthenticated");
  });

  it("500s with auth_unavailable when auth resolution genuinely fails (DB down)", async () => {
    vi.mocked(getCurrentUser).mockRejectedValueOnce(new Error("db down"));
    const handler = withUser(async () => jsonOk({}));
    const res = await handler(new NextRequest("http://test.local/api/x"), emptyCtx);
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.code).toBe("auth_unavailable");
  });

  it("never leaks handler exceptions — enveloped 500 instead", async () => {
    const handler = withRoute(async () => {
      throw new Error("secret stack detail");
    });
    const res = await handler(new NextRequest("http://test.local/api/x"), emptyCtx);
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.code).toBe("internal");
    expect(body.error.message).not.toContain("secret");
  });
});

describe("pg error detection", () => {
  it("matches a direct code and a nested cause chain", () => {
    expect(isPgError({ code: "23503" }, "23503")).toBe(true);
    expect(isForeignKeyViolation(new Error("outer", { cause: { code: "23503" } }))).toBe(true);
    expect(isUniqueViolation(new Error("outer", { cause: new Error("mid", { cause: { code: "23505" } }) }))).toBe(true);
  });

  it("rejects unrelated errors and primitives", () => {
    expect(isForeignKeyViolation(new Error("plain"))).toBe(false);
    expect(isForeignKeyViolation("23503")).toBe(false);
    expect(isForeignKeyViolation(null)).toBe(false);
  });
});
