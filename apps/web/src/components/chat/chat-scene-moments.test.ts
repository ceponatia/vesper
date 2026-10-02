import { describe, expect, it } from "vitest";
import { imageRecordSchema, type ImageRecord } from "@/lib/client/api";
import { scenesByAnchor } from "./chat-scene-moments";

/**
 * `scenesByAnchor`'s inclusion rule (issue #686): a `ready` scene always
 * shows; a `failed` one shows only when it is either a selfie (today's
 * "Failed" placeholder, unconditionally — a photo reply that silently never
 * arrives must not leave "sending you this…" dangling) or `recoverable` (the
 * new #686 case — a paid-for render whose download failed can still be
 * fetched back, so the tile earns its place with a Recover action). A failed,
 * non-selfie scene that is NOT recoverable is left out exactly as before #686.
 */

function scene(
  id: string,
  status: "pending" | "ready" | "failed",
  opts: { anchorMessageId?: string | null; recoverable?: boolean; selfie?: boolean } = {},
): ImageRecord {
  return imageRecordSchema.parse({
    id,
    kind: "scene",
    status,
    anchorMessageId: opts.anchorMessageId ?? "msg-1",
    recoverable: opts.recoverable ?? false,
    ...(opts.selfie ? { meta: { flavor: "selfie" } } : {}),
  });
}

describe("scenesByAnchor", () => {
  it("includes a recoverable failed scene", () => {
    const map = scenesByAnchor([scene("img-1", "failed", { recoverable: true })]);
    expect(map.get("msg-1")?.map((s) => s.id)).toEqual(["img-1"]);
  });

  it("excludes a non-recoverable failed scene", () => {
    const map = scenesByAnchor([scene("img-1", "failed", { recoverable: false })]);
    expect(map.has("msg-1")).toBe(false);
  });

  it("includes a failed selfie either way — recoverable or not", () => {
    const recoverableSelfie = scenesByAnchor([scene("img-1", "failed", { selfie: true, recoverable: true })]);
    expect(recoverableSelfie.get("msg-1")?.map((s) => s.id)).toEqual(["img-1"]);

    const lapsedSelfie = scenesByAnchor([scene("img-2", "failed", { selfie: true, recoverable: false })]);
    expect(lapsedSelfie.get("msg-1")?.map((s) => s.id)).toEqual(["img-2"]);
  });

  it("always includes a ready scene, recoverable or not", () => {
    const map = scenesByAnchor([scene("img-1", "ready")]);
    expect(map.get("msg-1")?.map((s) => s.id)).toEqual(["img-1"]);
  });

  it("excludes a pending scene", () => {
    const map = scenesByAnchor([scene("img-1", "pending")]);
    expect(map.has("msg-1")).toBe(false);
  });

  it("drops a scene with no anchor message, included or not", () => {
    const map = scenesByAnchor([
      scene("img-1", "ready", { anchorMessageId: null }),
      scene("img-2", "failed", { recoverable: true, anchorMessageId: null }),
    ]);
    expect(map.size).toBe(0);
  });

  it("groups by anchor and reads each group oldest-first (input arrives newest-first)", () => {
    const map = scenesByAnchor([
      scene("img-newer", "ready", { anchorMessageId: "msg-1" }),
      scene("img-older", "ready", { anchorMessageId: "msg-1" }),
      scene("img-other", "ready", { anchorMessageId: "msg-2" }),
    ]);
    expect(map.get("msg-1")?.map((s) => s.id)).toEqual(["img-older", "img-newer"]);
    expect(map.get("msg-2")?.map((s) => s.id)).toEqual(["img-other"]);
  });
});
