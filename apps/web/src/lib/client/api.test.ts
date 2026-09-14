import { afterEach, describe, expect, it, vi } from "vitest";
import {
  apiGet,
  characterDetailSchema,
  charactersApi,
  createdRefSchema,
  detailOf,
  emptyCharacterDraft,
  imageAdvisoriesApi,
  imageRecordSchema,
  imageUrl,
  itemDetailSchema,
  toApiError,
  withQuery,
} from "./api";
import { avatarReplayHintSchema, avatarReplayMapSchema } from "./api/images";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("toApiError", () => {
  it("reads the error envelope", () => {
    const err = toApiError(409, { error: { code: "session_busy", message: "Session is narrating" } });
    expect(err).toEqual({ status: 409, code: "session_busy", message: "Session is narrating" });
  });

  it("degrades on a non-envelope body", () => {
    const err = toApiError(500, "<html>oops</html>");
    expect(err.status).toBe(500);
    expect(err.code).toBe("http_500");
    expect(err.message).toContain("500");
  });

  it("fills a missing message from the status", () => {
    const err = toApiError(404, { error: { code: "not_found", message: "" } });
    expect(err.message).toContain("404");
  });
});

describe("withQuery", () => {
  it("skips undefined and empty params", () => {
    expect(withQuery("/api/items", { q: "", tag: undefined, kind: "clothing" })).toBe("/api/items?kind=clothing");
    expect(withQuery("/api/items", {})).toBe("/api/items");
  });

  it("encodes values", () => {
    expect(withQuery("/api/characters", { q: "a b" })).toBe("/api/characters?q=a+b");
  });
});

describe("imageUrl", () => {
  it("points at the serving route", () => {
    expect(imageUrl("img1")).toBe("/api/images/img1/file");
  });
});

describe("imageRecordSchema", () => {
  it("preserves image failure details from row meta", () => {
    const parsed = imageRecordSchema.parse({
      id: "img-failed",
      kind: "avatar",
      status: "failed",
      prompt: "portrait prompt",
      meta: {
        model: "replicate/qwen/qwen-image-2512",
        error: "The operation was aborted due to timeout",
        variantKind: "pose",
      },
    });
    expect(parsed.meta.model).toBe("replicate/qwen/qwen-image-2512");
    expect(parsed.meta.error).toBe("The operation was aborted due to timeout");
    expect(parsed.meta.variantKind).toBe("pose");
  });

  it("carries the render provenance through the parse instead of stripping it", () => {
    const render = { seed: 42, predictionId: "pred-1", droppedControls: [] };
    const parsed = imageRecordSchema.parse({
      id: "img-ready",
      kind: "scene",
      status: "ready",
      prompt: "scene prompt",
      meta: { model: "replicate/qwen/qwen-image-2512", render },
    });
    expect(parsed.meta.render).toEqual(render);
    // Degraded shapes miss cleanly rather than failing the record.
    expect(imageRecordSchema.parse({ id: "img-2", meta: { render: "not-an-object" } }).meta.render).toBeUndefined();
  });

  it("carries render advisories through the parse, including a reviewed one (issue #249)", () => {
    const advisories = [
      {
        version: 1,
        code: "blank_output",
        level: "advisory",
        reason: "The render came back as a flat, near-uniform image with almost no visible detail.",
        evidence: { grayVariance: 1, laplacianVariance: 0 },
        offers: ["retry_same", "new_variation"],
        review: { verdict: "agree", at: "2026-09-13T00:00:00.000Z" },
      },
    ];
    const parsed = imageRecordSchema.parse({
      id: "img-3",
      kind: "scene",
      status: "ready",
      prompt: "scene prompt",
      meta: { model: "replicate/qwen/qwen-image-2512", advisories },
    });
    expect(parsed.meta.advisories).toEqual(advisories);
  });

  it("survives a code outside today's known enum — a future or older deploy's advisory (correction round 1)", () => {
    // The client schema is deliberately LOOSE on `code` (a plain string, not
    // the producer's strict enum): a version bump or a code this deployment
    // does not recognize yet must not make the whole entry unparsable, which
    // is exactly the bug a strict `renderAdvisorySchema.extend(...)` caused —
    // a review already written for it would come back `ok:false`.
    const parsed = imageRecordSchema.parse({
      id: "img-4",
      meta: { advisories: [{ version: 2, code: "some_future_code", level: "advisory", reason: "r", evidence: {}, offers: [] }] },
    });
    expect(parsed.meta.advisories).toHaveLength(1);
    expect(parsed.meta.advisories?.[0]?.code).toBe("some_future_code");
    expect(parsed.meta.advisories?.[0]?.version).toBe(2);
  });

  it("drops an unparseable advisories entry and keeps its known sibling, rather than failing the whole list", () => {
    const known = {
      version: 1,
      code: "blank_output",
      level: "advisory",
      reason: "flat fill",
      evidence: { grayVariance: 1 },
      offers: ["retry_same"],
    };
    const parsed = imageRecordSchema.parse({
      id: "img-5",
      meta: { advisories: [known, "not an advisory object", null, 42] },
    });
    expect(parsed.meta.advisories).toEqual([known]);
  });

  // Kills the defect a strict shape here would cause: a NEW row written by a
  // newer deploy (issue #248's `retry`/`candidates` meta keys) must never fail
  // an older client's parse of the whole record.
  it("carries the retry and candidates provenance (issue #248) through the parse", () => {
    const parsed = imageRecordSchema.parse({
      id: "img-retry",
      kind: "avatar",
      status: "ready",
      prompt: "portrait prompt",
      meta: {
        retry: { mode: "same_composition", sourceImageId: "img-source", seed: 777 },
        candidates: { group: "grp-1", index: 1, of: 2 },
      },
    });
    expect(parsed.meta.retry).toEqual({ mode: "same_composition", sourceImageId: "img-source", seed: 777 });
    expect(parsed.meta.candidates).toEqual({ group: "grp-1", index: 1, of: 2 });
  });

  it("degrades a malformed retry or candidates value to absent, never a failed parse", () => {
    const parsed = imageRecordSchema.parse({
      id: "img-malformed",
      kind: "avatar",
      status: "ready",
      prompt: "",
      meta: { retry: "not-an-object", candidates: 42 },
    });
    expect(parsed.meta.retry).toBeUndefined();
    expect(parsed.meta.candidates).toBeUndefined();
  });
});

describe("avatarReplayHintSchema / avatarReplayMapSchema (issue #248)", () => {
  it("parses an eligible and a refused hint", () => {
    expect(avatarReplayHintSchema.parse({ ok: true })).toEqual({ ok: true });
    expect(avatarReplayHintSchema.parse({ ok: false, reason: "no_recorded_seed" })).toEqual({
      ok: false,
      reason: "no_recorded_seed",
    });
  });

  it("a map keys hints by image id and degrades a malformed map to empty", () => {
    const map = avatarReplayMapSchema.parse({
      "img-1": { ok: true },
      "img-2": { ok: false, reason: "model_changed" },
    });
    expect(map).toEqual({ "img-1": { ok: true }, "img-2": { ok: false, reason: "model_changed" } });
    expect(avatarReplayMapSchema.parse("not-an-object")).toEqual({});
  });
});

describe("imageAdvisoriesApi.review", () => {
  it("reports ok:true on a PATCH response carrying a newer advisory version (issue #249 correction round 1)", async () => {
    // Regression: the response schema used to be `renderAdvisorySchema.extend(...)`,
    // pinned to `version: z.literal(1)` — a review the server had already
    // recorded, echoed back at a bumped version, parsed as a failure and the
    // lightbox reported "Could not record your review" for a write that
    // actually succeeded.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          advisory: {
            version: 2,
            code: "blank_output",
            level: "advisory",
            reason: "flat fill",
            evidence: { grayVariance: 1 },
            offers: ["retry_same"],
            review: { verdict: "agree", at: "2026-09-13T00:00:00.000Z" },
          },
        }),
      ),
    );
    const result = await imageAdvisoriesApi.review("img-1", { code: "blank_output", verdict: "agree" });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.data.advisory.version).toBe(2);
    expect(result.data.advisory.review?.verdict).toBe("agree");
  });
});

describe("request plumbing", () => {
  it("returns parsed data on success", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse([{ id: "c1", name: "Maya" }])));
    const result = await charactersApi.list();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toHaveLength(1);
      expect(result.data[0]?.name).toBe("Maya");
      expect(result.data[0]?.tags).toEqual([]);
    }
  });

  it("unwraps keyed list envelopes and drops bad elements", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ characters: [{ id: "c1", name: "Maya" }, { nope: true }, null] })),
    );
    const result = await charactersApi.list();
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.map((c) => c.id)).toEqual(["c1"]);
  });

  it("shapes HTTP errors through the envelope", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ error: { code: "not_found", message: "No such character" } }, 404)),
    );
    const result = await charactersApi.get("missing");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("not_found");
      expect(result.error.status).toBe(404);
    }
  });

  it("turns thrown fetch into a network error, not an exception", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new Error("offline"))));
    const result = await charactersApi.list();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("network_error");
      expect(result.error.status).toBe(0);
    }
  });

  it("tolerates an empty body on non-JSON responses", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 500 })));
    const result = await charactersApi.get("c1");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("http_500");
  });

  it("sends JSON bodies with content-type", async () => {
    const fetchMock = vi.fn(async (..._args: Parameters<typeof fetch>) => jsonResponse({ id: "new1" }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await charactersApi.create({ name: "Iva" });
    expect(result.ok).toBe(true);
    const init = fetchMock.mock.calls[0]?.[1];
    expect(init?.method).toBe("POST");
    expect((init?.headers as Record<string, string>)["content-type"]).toBe("application/json");
    expect(init?.body).toBe(JSON.stringify({ name: "Iva" }));
  });

  it("unwraps detail envelopes like { character, portraits }", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ character: { id: "c1", name: "Maya" }, portraits: [] })),
    );
    const result = await charactersApi.get("c1");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.id).toBe("c1");
  });

  it("accepts a bare detail body", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ id: "c1", name: "Maya" })));
    const result = await charactersApi.get("c1");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.name).toBe("Maya");
  });

  it("flags unexpected success shapes instead of crashing", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse("not an object")));
    const result = await apiGet(characterDetailSchema, "/api/characters/c1");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("client.response_shape");
  });
});

describe("createdRefSchema", () => {
  it("accepts a bare id object", () => {
    expect(createdRefSchema.parse({ id: "x1" })).toEqual({ id: "x1" });
  });

  it("accepts a wrapped entity", () => {
    expect(createdRefSchema.parse({ session: { id: "s1" } })).toEqual({ id: "s1" });
  });

  it("rejects shapes with no id", () => {
    expect(createdRefSchema.safeParse({ ok: true }).success).toBe(false);
  });
});

describe("resource schemas degrade per-field", () => {
  it("character detail falls back to an empty profile on garbage", () => {
    const parsed = characterDetailSchema.parse({ id: "c1", name: 42, profile: "broken" });
    expect(parsed.name).toBe("Untitled");
    expect(parsed.profile.attributes).toEqual([]);
    expect(parsed.profile.bodyPlanId).toBe("humanoid");
  });

  it("character detail carries `mine`, defaulting to editable when absent", () => {
    // A foreign public row renders the read-only preview + duplicate CTA…
    const wrapped = detailOf(characterDetailSchema, "character").parse({
      character: { id: "c1", name: "Cass" },
      mine: false, // sibling of the wrapped row, merged by detailOf
    });
    expect(wrapped.mine).toBe(false);
    // …and an old/absent flag degrades to the editor (owner-scoped PATCH still guards).
    expect(characterDetailSchema.parse({ id: "c1", name: "Cass" }).mine).toBe(true);
  });

  it("item detail tolerates a missing definition", () => {
    const parsed = itemDetailSchema.parse({ id: "i1", name: "Coat", kind: "clothing" });
    expect(parsed.definition.coverage).toEqual([]);
    expect(parsed.definition.opacity).toBe("opaque");
    expect(parsed.definition.layer).toBeNull();
  });

  it("detailOf still accepts a bare entity", () => {
    const parsed = detailOf(characterDetailSchema, "character").parse({ id: "c2", name: "Bare" });
    expect(parsed.id).toBe("c2");
    expect(parsed.mine).toBe(true);
  });
});

describe("draft schemas", () => {
  it("emptyCharacterDraft is schema-valid and fully defaulted", () => {
    const draft = emptyCharacterDraft();
    expect(draft.name).toBe("");
    expect(draft.profile.attributes).toEqual([]);
    expect(draft.suggestedItems).toEqual([]);
  });

  it("forge response accepts bare drafts and wrapped drafts", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ name: "Iva", tags: ["sailor"] })));
    const bare = await charactersApi.forge({ prompt: "a sailor" });
    expect(bare.ok).toBe(true);
    if (bare.ok) {
      expect(bare.data.draft.name).toBe("Iva");
      expect(bare.data.diagnostics).toEqual([]);
    }

    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          draft: { name: "Iva" },
          diagnostics: [{ severity: "warn", code: "forge.outfit_failed", message: "no outfit" }],
        }),
      ),
    );
    const wrapped = await charactersApi.forge({ prompt: "a sailor" });
    expect(wrapped.ok).toBe(true);
    if (wrapped.ok) {
      expect(wrapped.data.diagnostics[0]?.code).toBe("forge.outfit_failed");
    }
  });
});
