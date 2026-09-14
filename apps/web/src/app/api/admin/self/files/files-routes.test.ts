import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const authState = vi.hoisted(() => ({
  user: { id: "admin-files-test", email: "admin@example.test", name: "Admin", role: "admin" as const },
}));

vi.mock("@/server/auth", async () => (await import("@/server/test-support")).routeAuthModule(authState));

import {
  apiRequest,
  expectApiError,
  expectJson,
  routeCtx,
  withAuthUser,
  withTempDataRoot,
  type TempDataRoot,
} from "@/server/test-support";
import { GET as LIST, POST as MUTATE } from "./route";
import { PUT as UPLOAD } from "./upload/route";
import { GET as DOWNLOAD } from "./download/route";

let temp: TempDataRoot;

beforeEach(async () => {
  temp = await withTempDataRoot("vesper-admin-files-routes");
});

afterEach(async () => {
  await temp.cleanup();
});

describe("owner-admin Files routes", () => {
  it("hides the API from a signed-in non-admin", async () => {
    await withAuthUser(authState, { role: "user" }, async () => {
      const response = await LIST(apiRequest("/api/admin/self/files"), routeCtx());
      await expectApiError(response, 404, "not_found");
    });
  });

  it("supports the folder/upload/list/download/rename/delete workflow", async () => {
    let response = await MUTATE(
      apiRequest("/api/admin/self/files", {
        body: { action: "create_folder", path: "", name: "share" },
      }),
      routeCtx(),
    );
    expect(response.status).toBe(201);

    response = await UPLOAD(
      apiRequest("/api/admin/self/files/upload", {
        method: "PUT",
        body: "hello from another device",
        query: { path: "share", name: "note.txt" },
      }),
      routeCtx(),
    );
    expect(response.status).toBe(201);

    response = await LIST(apiRequest("/api/admin/self/files", { query: { path: "share" } }), routeCtx());
    const listing = await expectJson<{ entries: Array<{ name: string; kind: string; size: number }> }>(response, 200);
    expect(listing.entries).toEqual([
      expect.objectContaining({ name: "note.txt", kind: "file", size: 25 }),
    ]);

    response = await DOWNLOAD(
      apiRequest("/api/admin/self/files/download", { query: { path: "share/note.txt" } }),
      routeCtx(),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/octet-stream");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-disposition")).toContain("attachment;");
    expect(await response.text()).toBe("hello from another device");

    response = await MUTATE(
      apiRequest("/api/admin/self/files", {
        body: { action: "rename", path: "share/note.txt", name: "renamed.bin" },
      }),
      routeCtx(),
    );
    expect(response.status).toBe(200);

    response = await MUTATE(
      apiRequest("/api/admin/self/files", { body: { action: "delete", path: "share/renamed.bin" } }),
      routeCtx(),
    );
    expect(response.status).toBe(200);
    response = await MUTATE(
      apiRequest("/api/admin/self/files", { body: { action: "delete", path: "share" } }),
      routeCtx(),
    );
    expect(response.status).toBe(200);
  });

  it("requires explicit overwrite and rejects encoded upload bodies", async () => {
    let response = await UPLOAD(
      apiRequest("/api/admin/self/files/upload", {
        method: "PUT",
        body: "first",
        query: { name: "same.bin" },
      }),
      routeCtx(),
    );
    expect(response.status).toBe(201);

    response = await UPLOAD(
      apiRequest("/api/admin/self/files/upload", {
        method: "PUT",
        body: "second",
        query: { name: "same.bin" },
      }),
      routeCtx(),
    );
    await expectApiError(response, 409, "already_exists");

    response = await UPLOAD(
      apiRequest("/api/admin/self/files/upload", {
        method: "PUT",
        body: "compressed-looking",
        headers: { "content-encoding": "gzip" },
        query: { name: "encoded.bin" },
      }),
      routeCtx(),
    );
    await expectApiError(response, 415, "unsupported_content_encoding");
  });
});
