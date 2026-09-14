import { describe, expect, it } from "vitest";
import { imageRecordSchema, type ImageRecord } from "@/lib/client/api";
import { avatarGenerationRows, isAvatarGenerationComplete, type AvatarGenerationRequest } from "./portrait-studio-state";

/**
 * Kills the busy-forever bug (codex review round 1, finding A on issue
 * #248): a two-candidate request claims no canonical pointer, so a studio
 * that only clears its busy state when `avatarImageId` changes never clears
 * it once both candidates land. Completion here is judged from the
 * request's own rows instead.
 */

function row(id: string, status: "pending" | "ready" | "failed", kind = "avatar"): ImageRecord {
  return imageRecordSchema.parse({ id, kind, status });
}

function request(over: Partial<AvatarGenerationRequest> = {}): AvatarGenerationRequest {
  return {
    jobId: "job-1",
    candidates: 1,
    priorAvatarRowIds: new Set<string>(),
    priorAvatarImageId: null,
    ...over,
  };
}

describe("isAvatarGenerationComplete", () => {
  it("two-candidate: two ready rows of the request are both new — done", () => {
    const req = request({ candidates: 2, priorAvatarRowIds: new Set(["img-old"]) });
    const rows = [row("img-2", "ready"), row("img-1", "ready"), row("img-old", "ready")];
    expect(isAvatarGenerationComplete(req, { rows, avatarImageId: null })).toBe(true);
  });

  it("two-candidate: one ready, one still pending — busy", () => {
    const req = request({ candidates: 2, priorAvatarRowIds: new Set(["img-old"]) });
    const rows = [row("img-2", "pending"), row("img-1", "ready"), row("img-old", "ready")];
    expect(isAvatarGenerationComplete(req, { rows, avatarImageId: null })).toBe(false);
  });

  it("two-candidate: one failed, one ready — done (settled is settled, whichever way)", () => {
    const req = request({ candidates: 2, priorAvatarRowIds: new Set(["img-old"]) });
    const rows = [row("img-2", "failed"), row("img-1", "ready"), row("img-old", "ready")];
    expect(isAvatarGenerationComplete(req, { rows, avatarImageId: null })).toBe(true);
  });

  it("two-candidate: only one new row has appeared so far — busy (never claims done on a partial group)", () => {
    const req = request({ candidates: 2, priorAvatarRowIds: new Set(["img-old"]) });
    const rows = [row("img-1", "ready"), row("img-old", "ready")];
    expect(isAvatarGenerationComplete(req, { rows, avatarImageId: null })).toBe(false);
  });

  it("single-candidate: the pointer changing to a new image is done, even before the row list catches up", () => {
    const req = request({ candidates: 1, priorAvatarImageId: "img-old", priorAvatarRowIds: new Set(["img-old"]) });
    const rows = [row("img-old", "ready")]; // the list has not refetched the new row yet
    expect(isAvatarGenerationComplete(req, { rows, avatarImageId: "img-new" })).toBe(true);
  });

  it("single-candidate: a failed retry never moves the pointer, but its own new row settling is still done", () => {
    const req = request({ candidates: 1, priorAvatarImageId: "img-old", priorAvatarRowIds: new Set(["img-old"]) });
    const rows = [row("img-new", "failed"), row("img-old", "ready")];
    expect(isAvatarGenerationComplete(req, { rows, avatarImageId: "img-old" })).toBe(true);
  });

  it("single-candidate: nothing has changed yet — busy", () => {
    const req = request({ candidates: 1, priorAvatarImageId: "img-old", priorAvatarRowIds: new Set(["img-old"]) });
    const rows = [row("img-old", "ready")];
    expect(isAvatarGenerationComplete(req, { rows, avatarImageId: "img-old" })).toBe(false);
  });

  it("ignores a variant row entirely — only avatar-kind rows count toward the request", () => {
    const req = request({ candidates: 1, priorAvatarRowIds: new Set(["img-old"]), priorAvatarImageId: "img-old" });
    const rows = [row("img-variant", "ready", "portrait_variant"), row("img-old", "ready")];
    expect(isAvatarGenerationComplete(req, { rows, avatarImageId: "img-old" })).toBe(false);
  });
});

describe("avatarGenerationRows", () => {
  it("returns only the new avatar-kind rows, oldest baseline excluded", () => {
    const req = request({ priorAvatarRowIds: new Set(["img-old"]) });
    const rows = [row("img-new", "ready"), row("img-old", "ready"), row("img-variant", "ready", "portrait_variant")];
    expect(avatarGenerationRows(req, rows).map((r) => r.id)).toEqual(["img-new"]);
  });
});
