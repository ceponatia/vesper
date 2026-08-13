import { describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { z } from "zod";
import {
  DEFAULT_MAX_BODY_BYTES,
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
const encoder = new TextEncoder();

function post(body: string, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest("http://test.local/api/x", {
    method: "POST",
    body,
    headers: { "content-type": "application/json", ...headers },
  });
}

/** A request whose declared Content-Length is `bytes`, regardless of actual body. */
function postWithLength(body: string, bytes: number): NextRequest {
  return post(body, { "content-length": String(bytes) });
}

/** A streamed request split into deliberate transport chunks, with no declared length. */
function streamedPost(chunks: string[], headers: Record<string, string> = {}): NextRequest {
  const encoded = chunks.map((chunk) => encoder.encode(chunk));
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of encoded) controller.enqueue(chunk);
      controller.close();
    },
  });
  return new NextRequest("http://test.local/api/x", {
    method: "POST",
    body,
    headers: { "content-type": "application/json", ...headers },
  });
}

async function expectPayloadTooLarge(result: Awaited<ReturnType<typeof readBody>>): Promise<void> {
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.response.status).toBe(413);
    expect(await result.response.json()).toEqual({
      error: { code: "payload_too_large", message: "request body is too large" },
    });
  }
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

  it("rejects an oversized request from a valid Content-Length before buffering", async () => {
    const req = postWithLength(JSON.stringify({ name: "Maya" }), DEFAULT_MAX_BODY_BYTES + 1);
    await expectPayloadTooLarge(await readBody(req, schema));
  });

  it("rejects an oversized request without Content-Length", async () => {
    const body = JSON.stringify({ name: "abcdefghij" });
    await expectPayloadTooLarge(await readBody(post(body), schema, { maxBytes: encoder.encode(body).byteLength - 1 }));
  });

  it("counts streamed/chunked bodies across chunk boundaries", async () => {
    const chunks = ['{"na', 'me":"', 'Maya"}'];
    const actualBytes = chunks.reduce((sum, chunk) => sum + encoder.encode(chunk).byteLength, 0);
    await expectPayloadTooLarge(await readBody(streamedPost(chunks), schema, { maxBytes: actualBytes - 1 }));
  });

  it("does not trust a falsely low Content-Length", async () => {
    const body = JSON.stringify({ name: "abcdefghij" });
    const req = postWithLength(body, 1);
    await expectPayloadTooLarge(await readBody(req, schema, { maxBytes: encoder.encode(body).byteLength - 1 }));
  });

  it("counts multibyte UTF-8 bytes rather than JavaScript characters", async () => {
    const body = JSON.stringify({ name: "é" });
    const actualBytes = encoder.encode(body).byteLength;
    expect(body.length).toBeLessThan(actualBytes);
    await expectPayloadTooLarge(await readBody(post(body), schema, { maxBytes: actualBytes - 1 }));
  });

  it("parses a streamed request normally when actual bytes stay within the cap", async () => {
    const result = await readBody(streamedPost(['{"name":', '"Maya"}']), schema, { maxBytes: 64 });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.name).toBe("Maya");
  });

  it("rejects compressed request bodies before buffering", async () => {
    const result = await readBody(post(JSON.stringify({ name: "Maya" }), { "content-encoding": "gzip" }), schema);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(415);
      expect((await result.response.json()).error.code).toBe("unsupported_content_encoding");
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
