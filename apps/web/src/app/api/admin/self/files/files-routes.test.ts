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
import { GET as PREVIEW } from "./preview/route";

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

describe("owner-admin Files media preview", () => {
  // Deliberately ASCII text inside files named `.png` and `.mp4`: the route
  // decides the content type from the extension alone and never sniffs, so a
  // fixture whose bytes contradict its name is the honest one to serve.
  const ALPHABET = "abcdefghijklmnopqrstuvwxyz";

  function preview(path: string, headers?: Record<string, string>): Promise<Response> {
    return PREVIEW(apiRequest("/api/admin/self/files/preview", { query: { path }, headers }), routeCtx());
  }

  it("stays behind the same owner-admin gate as the rest of Files", async () => {
    expect((await upload("", "shot.png", ALPHABET)).status).toBe(201);

    // This is the one route that answers with a real content type, so it is the
    // one that must not open a door the inert ones keep shut.
    await withAuthUser(authState, { role: "user" }, async () => {
      await expectApiError(await preview("shot.png"), 404, "not_found");
    });
  });

  it("serves an allowlisted file inline with the type its extension names", async () => {
    expect((await upload("", "shot.png", ALPHABET)).status).toBe(201);

    const response = await preview("shot.png");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("content-disposition")).toBe(
      'inline; filename="shot.png"; filename*=UTF-8\'\'shot.png',
    );
    // nosniff is what makes the allowlist sufficient rather than hopeful: these
    // bytes are text, and the browser must still refuse to read them as one.
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("accept-ranges")).toBe("bytes");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("content-length")).toBe(String(ALPHABET.length));
    expect(response.headers.get("content-range")).toBeNull();
    expect(await response.text()).toBe(ALPHABET);
  });

  it.each([
    { label: "an interior window", header: "bytes=4-8", contentRange: "bytes 4-8/26", body: "efghi" },
    { label: "a single byte", header: "bytes=0-0", contentRange: "bytes 0-0/26", body: "a" },
    { label: "the last byte", header: "bytes=25-25", contentRange: "bytes 25-25/26", body: "z" },
    { label: "a suffix", header: "bytes=-5", contentRange: "bytes 21-25/26", body: "vwxyz" },
    { label: "an end past the last byte", header: "bytes=20-999", contentRange: "bytes 20-25/26", body: "uvwxyz" },
    { label: "a player's opening request", header: "bytes=0-", contentRange: "bytes 0-25/26", body: ALPHABET },
  ])("answers $label with exactly the bytes it names", async ({ header, contentRange, body }) => {
    expect((await upload("", "clip.mp4", ALPHABET)).status).toBe(201);

    const response = await preview("clip.mp4", { range: header });
    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe(contentRange);
    expect(response.headers.get("content-length")).toBe(String(body.length));
    expect(response.headers.get("content-type")).toBe("video/mp4");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("accept-ranges")).toBe("bytes");
    expect(await response.text()).toBe(body);
  });

  it("refuses a range that lies outside the file, and says how long it is", async () => {
    expect((await upload("", "clip.mp4", ALPHABET)).status).toBe(201);

    const response = await preview("clip.mp4", { range: "bytes=99-" });
    await expectApiError(response, 416, "range_not_satisfiable");
    expect(response.headers.get("content-range")).toBe("bytes */26");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("degrades a multi-range request to the whole file rather than erroring", async () => {
    expect((await upload("", "clip.mp4", ALPHABET)).status).toBe(201);

    const response = await preview("clip.mp4", { range: "bytes=0-1,4-5" });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-range")).toBeNull();
    expect(await response.text()).toBe(ALPHABET);
  });

  it("serves a zero-byte file whole and satisfies no range into it", async () => {
    expect((await upload("", "silence.mp3", "")).status).toBe(201);

    const whole = await preview("silence.mp3");
    expect(whole.status).toBe(200);
    expect(whole.headers.get("content-type")).toBe("audio/mpeg");
    expect(whole.headers.get("content-length")).toBe("0");
    expect(await whole.text()).toBe("");

    const ranged = await preview("silence.mp3", { range: "bytes=0-" });
    await expectApiError(ranged, 416, "range_not_satisfiable");
    expect(ranged.headers.get("content-range")).toBe("bytes */0");
  });

  it("refuses an SVG and leaves it downloadable as inert bytes", async () => {
    expect((await upload("", "logo.svg", '<svg onload="alert(1)"/>')).status).toBe(201);

    const refused = await preview("logo.svg");
    await expectApiError(refused, 415, "unsupported_media_type");
    expect(refused.headers.get("x-content-type-options")).toBe("nosniff");

    // An SVG is a document that can carry script, so it never earns a real
    // content type here. The download route is untouched and still the door it
    // reaches the owner through.
    const downloaded = await DOWNLOAD(
      apiRequest("/api/admin/self/files/download", { query: { path: "logo.svg" } }),
      routeCtx(),
    );
    expect(downloaded.status).toBe(200);
    expect(downloaded.headers.get("content-type")).toBe("application/octet-stream");
    expect(downloaded.headers.get("content-disposition")).toContain("attachment;");
  });

  it.each(["notes.txt", "page.html", "clip.mkv", "avatar.png.html"])("refuses %s", async (name) => {
    expect((await upload("", name, "not previewable")).status).toBe(201);
    await expectApiError(await preview(name), 415, "unsupported_media_type");
  });

  it("judges the path before it judges the type", async () => {
    // The allowlist runs on the name the server resolved, so a file that is not
    // there is reported missing whatever its extension promised, and a path the
    // managed tree refuses is refused as a path.
    await expectApiError(await preview("missing.png"), 404, "not_found");
    await expectApiError(await preview("missing.txt"), 404, "not_found");
    await expectApiError(await preview(""), 400, "invalid_path");
    await expectApiError(await preview("../escape.png"), 400, "invalid_path");
  });
});
