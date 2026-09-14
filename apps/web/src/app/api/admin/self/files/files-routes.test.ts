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

function mutate(body: unknown): Promise<Response> {
  return MUTATE(apiRequest("/api/admin/self/files", { body }), routeCtx());
}

function upload(path: string, name: string, body: string): Promise<Response> {
  return UPLOAD(
    apiRequest("/api/admin/self/files/upload", { method: "PUT", body, query: { path, name } }),
    routeCtx(),
  );
}

interface BatchFailures {
  failures: Array<{ path: string; code: string; message: string }>;
}

describe("owner-admin Files routes", () => {
  it("hides the API from a signed-in non-admin", async () => {
    await withAuthUser(authState, { role: "user" }, async () => {
      const listed = await LIST(apiRequest("/api/admin/self/files"), routeCtx());
      await expectApiError(listed, 404, "not_found");

      // The batch actions sit behind the same gate; a new action must not open
      // a door the single-entry ones keep shut.
      const batched = await mutate({ action: "delete_many", paths: ["anything"] });
      await expectApiError(batched, 404, "not_found");
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

  it("previews a delete, refuses a non-empty folder, and removes the tree once asked", async () => {
    expect((await mutate({ action: "create_folder", path: "", name: "share" })).status).toBe(201);
    expect((await upload("share", "note.txt", "hello")).status).toBe(201);

    let response = await mutate({ action: "delete_preview", paths: ["share"] });
    expect(await expectJson(response, 200)).toEqual({ files: 1, folders: 1, bytes: 5, truncated: false });

    // Partial success: the refused folder is a `failures` row, not a status.
    response = await mutate({ action: "delete_many", paths: ["share", "missing.txt"] });
    const refused = await expectJson<BatchFailures & { deleted: number }>(response, 200);
    expect(refused.deleted).toBe(0);
    expect(refused.failures.map((failure) => [failure.path, failure.code])).toEqual([
      ["share", "folder_not_empty"],
      ["missing.txt", "not_found"],
    ]);

    response = await mutate({ action: "delete_many", paths: ["share"], recursive: true });
    expect(await expectJson(response, 200)).toEqual({ deleted: 1, failures: [] });

    response = await mutate({ action: "delete_many", paths: [] });
    await expectApiError(response, 400, "invalid_body");
  });

  it("moves a selection and reports a collision per path without failing the request", async () => {
    expect((await mutate({ action: "create_folder", path: "", name: "box" })).status).toBe(201);
    expect((await upload("", "a.txt", "root a")).status).toBe(201);
    expect((await upload("", "b.txt", "root b")).status).toBe(201);
    expect((await upload("box", "a.txt", "box a")).status).toBe(201);

    let response = await mutate({ action: "move", paths: ["a.txt", "b.txt"], destination: "box" });
    const result = await expectJson<BatchFailures & { moved: number; entries: Array<{ path: string }> }>(response, 200);
    expect(result.moved).toBe(1);
    expect(result.entries.map((entry) => entry.path)).toEqual(["box/b.txt"]);
    expect(result.failures.map((failure) => [failure.path, failure.code])).toEqual([["a.txt", "already_exists"]]);

    // A missing destination is one fact about the request, so it fails the
    // request rather than repeating itself once per path.
    response = await mutate({ action: "move", paths: ["a.txt"], destination: "nowhere" });
    await expectApiError(response, 404, "not_found");

    response = await LIST(apiRequest("/api/admin/self/files", { query: { path: "box" } }), routeCtx());
    const listing = await expectJson<{ entries: Array<{ name: string }> }>(response, 200);
    expect(listing.entries.map((entry) => entry.name)).toEqual(["a.txt", "b.txt"]);
  });
});
