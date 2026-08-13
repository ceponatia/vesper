import { describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { withRoute } from "./respond";

const ctx = { params: Promise.resolve({}) };
const handler = vi.fn(async () => new Response(null, { status: 204 }));

function request(method: string, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest("http://test.local/api/resource", {
    method,
    headers,
  });
}

async function expectCsrfRejected(response: Response): Promise<void> {
  expect(response.status).toBe(403);
  expect(await response.json()).toEqual({
    error: { code: "csrf_origin", message: "request origin is not allowed" },
  });
}

describe("centralized CSRF origin protection", () => {
  it("allows a same-origin cookie-authenticated mutation", async () => {
    handler.mockClear();
    const route = withRoute(handler);
    const response = await route(
      request("POST", { cookie: "vesper.session=abc", origin: "http://test.local" }),
      ctx,
    );

    expect(response.status).toBe(204);
    expect(handler).toHaveBeenCalledOnce();
  });

  it("rejects a cross-origin cookie-authenticated mutation", async () => {
    handler.mockClear();
    const route = withRoute(handler);
    const response = await route(
      request("PATCH", { cookie: "vesper.session=abc", origin: "https://attacker.example" }),
      ctx,
    );

    await expectCsrfRejected(response);
    expect(handler).not.toHaveBeenCalled();
  });

  it("rejects a missing Origin on a cookie-authenticated browser mutation", async () => {
    handler.mockClear();
    const route = withRoute(handler);
    const response = await route(request("DELETE", { cookie: "vesper.session=abc" }), ctx);

    await expectCsrfRejected(response);
    expect(handler).not.toHaveBeenCalled();
  });

  it.each(["GET", "HEAD"])("leaves %s requests unaffected", async (method) => {
    handler.mockClear();
    const route = withRoute(handler);
    const response = await route(request(method, { cookie: "vesper.session=abc" }), ctx);

    expect(response.status).toBe(204);
    expect(handler).toHaveBeenCalledOnce();
  });

  it("permits a documented non-browser integration exemption", async () => {
    handler.mockClear();
    const route = withRoute(handler, {
      csrf: "exempt",
      csrfExemptionReason: "Signed server-to-server import callback; no browser client.",
    });
    const response = await route(request("POST", { cookie: "integration-cookie" }), ctx);

    expect(response.status).toBe(204);
    expect(handler).toHaveBeenCalledOnce();
  });

  it("does not permit an undocumented exemption", async () => {
    handler.mockClear();
    const route = withRoute(handler, { csrf: "exempt", csrfExemptionReason: "" });
    const response = await route(request("POST", { cookie: "integration-cookie" }), ctx);

    expect(response.status).toBe(500);
    expect(handler).not.toHaveBeenCalled();
  });

  it("does not apply CSRF checks to requests without cookies", async () => {
    handler.mockClear();
    const route = withRoute(handler);
    const response = await route(request("PUT"), ctx);

    expect(response.status).toBe(204);
    expect(handler).toHaveBeenCalledOnce();
  });
});
