import { describe, expect, it } from "vitest";
import { imageRecordSchema, type ImageRecord } from "@/lib/client/api";
import { avatarGenerationRows, isAvatarGenerationComplete, type AvatarGenerationRequest } from "./portrait-studio-state";

/**
 * Kills the busy-forever bug (issue #248 codex review round 1, finding A)
 * and the two holes a client-side snapshot left open (round 2, threads
 * 3–4): an empty snapshot before the portraits list has ever loaded reads
 * every settled row as "new" and clears the busy state early, and a ref
 * filled in only after the POST resolves lets a completion check re-evaluate
 * a stale, unrelated request. Tracking by the request's own client-minted
 * id, stamped on every row it reserves, closes both: only a row carrying
 * THIS request's id ever counts, whether or not it existed before.
 */

const REQUEST_ID = "req-1";

function row(id: string, status: "pending" | "ready" | "failed", requestId: string | undefined, kind = "avatar"): ImageRecord {
  return imageRecordSchema.parse({
    id,
    kind,
    status,
    ...(requestId !== undefined ? { meta: { request: { id: requestId, candidates: 1 } } } : {}),
  });
}

function request(over: Partial<AvatarGenerationRequest> = {}): AvatarGenerationRequest {
  return { requestId: REQUEST_ID, candidates: 1, ...over };
}

describe("isAvatarGenerationComplete", () => {
  it("two-candidate: two ready rows stamped with this request's id — done", () => {
    const req = request({ candidates: 2 });
    const rows = [row("img-2", "ready", REQUEST_ID), row("img-1", "ready", REQUEST_ID)];
    expect(isAvatarGenerationComplete(req, { rows })).toBe(true);
  });

  it("two-candidate: one ready, one still pending — busy", () => {
    const req = request({ candidates: 2 });
    const rows = [row("img-2", "pending", REQUEST_ID), row("img-1", "ready", REQUEST_ID)];
    expect(isAvatarGenerationComplete(req, { rows })).toBe(false);
  });

  it("two-candidate: one failed, one ready — done (settled is settled, whichever way)", () => {
    const req = request({ candidates: 2 });
    const rows = [row("img-2", "failed", REQUEST_ID), row("img-1", "ready", REQUEST_ID)];
    expect(isAvatarGenerationComplete(req, { rows })).toBe(true);
  });

  it("two-candidate: only one stamped row has appeared so far — busy (never claims done on a partial group)", () => {
    const req = request({ candidates: 2 });
    const rows = [row("img-1", "ready", REQUEST_ID)];
    expect(isAvatarGenerationComplete(req, { rows })).toBe(false);
  });

  it("old settled rows carrying no request id at all never count toward a new request", () => {
    // The bug a client-side snapshot could not close: before the portraits
    // list has ever loaded, "what existed before this request" is empty, so
    // every pre-existing row — including these, from long before request
    // tracking even existed — read as "new" and completed the request
    // instantly. Identifying rows by the tracked id instead makes an
    // unstamped row invisible to the check no matter how many of them exist.
    const req = request({ candidates: 1 });
    const rows = [row("img-old-1", "ready", undefined), row("img-old-2", "failed", undefined)];
    expect(isAvatarGenerationComplete(req, { rows })).toBe(false);
  });

  it("a row stamped with a DIFFERENT request's id never counts toward this one", () => {
    // The other hole: a ref replaced only after the POST resolves let a
    // completion check re-evaluate the PREVIOUS request while a new one was
    // still in flight. Two distinct ids on otherwise-identical rows prove
    // the two requests can never be confused for each other.
    const req = request({ candidates: 1 });
    const rows = [row("img-1", "ready", "req-0")];
    expect(isAvatarGenerationComplete(req, { rows })).toBe(false);
  });

  it("ordering: the request is tracked before the server has reserved anything — zero matching rows is busy, not done", () => {
    const req = request({ candidates: 2 });
    expect(isAvatarGenerationComplete(req, { rows: [] })).toBe(false);
  });

  it("ignores a variant row entirely, even one stamped with the request's id — only avatar-kind rows count", () => {
    const req = request({ candidates: 1 });
    const rows = [row("img-variant", "ready", REQUEST_ID, "portrait_variant")];
    expect(isAvatarGenerationComplete(req, { rows })).toBe(false);
  });
});

describe("avatarGenerationRows", () => {
  it("returns only the rows stamped with this request's id, oldest unstamped rows excluded", () => {
    const req = request();
    const rows = [row("img-mine", "ready", REQUEST_ID), row("img-old", "ready", undefined), row("img-other", "ready", "req-0")];
    expect(avatarGenerationRows(req, rows).map((r) => r.id)).toEqual(["img-mine"]);
  });
});
