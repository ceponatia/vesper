import { afterEach, describe, expect, it, vi } from "vitest";
import {
  apiGet,
  characterDetailSchema,
  charactersApi,
  createdRefSchema,
  detailOf,
  emptyCharacterDraft,
  emptyWorldDraft,
  imageRecordSchema,
  imageUrl,
  itemDetailSchema,
  sessionSummarySchema,
  sessionsApi,
  toApiError,
  withQuery,
  worldDetailSchema,
  worldDraftSchema,
} from "./api";

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
        model: "venice/qwen-image",
        error: "The operation was aborted due to timeout",
        variantKind: "pose",
      },
    });
    expect(parsed.meta.model).toBe("venice/qwen-image");
    expect(parsed.meta.error).toBe("The operation was aborted due to timeout");
    expect(parsed.meta.variantKind).toBe("pose");
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

  it("world detail drops bad list elements but keeps the rest", () => {
    const parsed = worldDetailSchema.parse({
      id: "w1",
      name: "Harborfall",
      cast: [{ id: "cast1", name: "Maya", role: "nonsense" }, "garbage"],
      loreChunks: [{ id: "l1", title: "The Flood", tier: "??", visibility: "secret" }],
    });
    expect(parsed.cast).toHaveLength(1);
    expect(parsed.cast[0]?.role).toBe("npc");
    expect(parsed.loreChunks[0]?.tier).toBe("scene");
    expect(parsed.loreChunks[0]?.visibility).toBe("secret");
    expect(parsed.locations).toEqual([]);
  });

  it("session summary defaults status", () => {
    const parsed = sessionSummarySchema.parse({ id: "s1", status: "exploded" });
    expect(parsed.status).toBe("ready");
    expect(parsed.title).toBe("Untitled session");
  });

  it("relationship edges default kind/stage and drop rows without ids", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          relationships: [
            { id: "r1", fromParticipantId: "npc1", toParticipantId: "player", kind: "feeling", stage: "friendly" },
            { id: "r2", fromParticipantId: "npc1", toParticipantId: "player", kind: "??", stage: 7 },
            { fromParticipantId: "npc2", toParticipantId: "player" }, // no id → dropped
          ],
        }),
      ),
    );
    const result = await sessionsApi.relationships("s1");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toHaveLength(2);
      expect(result.data[0]?.stage).toBe("friendly");
      expect(result.data[1]?.kind).toBe("feeling");
      expect(result.data[1]?.stage).toBe("stranger");
    }
  });

  it("posts participant clothing updates and parses the response", async () => {
    const fetchMock = vi.fn(async (..._args: Parameters<typeof fetch>) =>
      jsonResponse({ itemInstanceId: "item1", participantId: "npc1", worn: false }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await sessionsApi.updateParticipantClothing("s1", "npc1", {
      action: "remove",
      itemInstanceId: "item1",
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toEqual({ itemInstanceId: "item1", participantId: "npc1", worn: false });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/sessions/s1/participants/npc1/clothing",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ action: "remove", itemInstanceId: "item1" }),
      }),
    );
  });

  it("detailOf merges the wrapped entity with its sibling families (worlds GET shape)", () => {
    // Regression: detailOf once returned only obj.world, discarding the
    // sibling locations/cast/… — the editor then seeded empty families and the
    // next save erased the world's real rows.
    const parsed = detailOf(worldDetailSchema, "world").parse({
      world: { id: "w1", name: "Harborfall" },
      locations: [{ id: "wl1", locationId: "loc1", name: "Quay", description: "", ambient: {}, tags: [], overrides: {} }],
      cast: [{ id: "cast1", characterId: "c1", name: "Maya", role: "companion", startWorldLocationId: null, avatarImageId: null }],
      loreChunks: [{ id: "l1", title: "The Flood" }],
      links: [],
      items: [],
    });
    expect(parsed.id).toBe("w1");
    expect(parsed.locations).toHaveLength(1);
    expect(parsed.locations[0]?.locationId).toBe("loc1");
    expect(parsed.cast).toHaveLength(1);
    expect(parsed.loreChunks).toHaveLength(1);
  });

  it("detailOf still accepts a bare entity", () => {
    const parsed = detailOf(worldDetailSchema, "world").parse({ id: "w2", name: "Bare" });
    expect(parsed.id).toBe("w2");
  });
});

describe("draft schemas", () => {
  it("emptyCharacterDraft is schema-valid and fully defaulted", () => {
    const draft = emptyCharacterDraft();
    expect(draft.name).toBe("");
    expect(draft.profile.attributes).toEqual([]);
    expect(draft.suggestedItems).toEqual([]);
  });

  it("emptyWorldDraft is schema-valid", () => {
    const draft = emptyWorldDraft();
    expect(draft.locations).toEqual([]);
    expect(draft.style.directives).toEqual([]);
  });

  it("parses a partial world draft, dropping broken sections only", () => {
    const draft = worldDraftSchema.parse({
      name: "Mistward",
      locations: [{ name: "Quay", links: ["Market"] }, 17],
      loreChunks: "nope",
    });
    expect(draft.name).toBe("Mistward");
    expect(draft.locations).toHaveLength(1);
    expect(draft.locations[0]?.links).toEqual(["Market"]);
    expect(draft.loreChunks).toEqual([]);
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
