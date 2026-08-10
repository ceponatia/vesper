import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { probeReplicateModel } from "./replicate-probe";

const originalToken = process.env.REPLICATE_API_TOKEN;

beforeEach(() => {
  process.env.REPLICATE_API_TOKEN = "test-token";
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (originalToken === undefined) delete process.env.REPLICATE_API_TOKEN;
  else process.env.REPLICATE_API_TOKEN = originalToken;
});

/** Build an OpenAPI blob shaped like Replicate's, with enums resolved via $ref. */
function openapi(input: {
  properties: Record<string, unknown>;
  required?: string[];
  enums?: Record<string, string[]>;
}) {
  const schemas: Record<string, unknown> = {
    Input: { properties: input.properties, required: input.required ?? ["prompt"] },
  };
  for (const [name, values] of Object.entries(input.enums ?? {})) schemas[name] = { enum: values };
  return { components: { schemas } };
}

const enumRef = (name: string) => ({ allOf: [{ $ref: `#/components/schemas/${name}` }] });
const uri = { type: "string", format: "uri" };
const uriArray = (description = "") => ({ type: "array", items: uri, description });

/** Stub fetch, recording the URLs asked for. */
function stubFetch(byUrl: (url: string) => unknown, calls: string[] = []) {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: string | URL | Request) => {
      const url = String(input);
      calls.push(url);
      const body = byUrl(url);
      if (body === undefined) return Promise.resolve(new Response(null, { status: 404 }));
      return Promise.resolve(Response.json(body));
    }),
  );
  return calls;
}

describe("probeReplicateModel", () => {
  it("derives the reference field, arity and cap from the schema", async () => {
    stubFetch(() => ({
      name: "seedream-4.5",
      latest_version: {
        id: "v1",
        openapi_schema: openapi({
          properties: {
            prompt: { type: "string" },
            image_input: uriArray("Input image(s). List of 1-14 images for single or multi-reference generation."),
            aspect_ratio: enumRef("aspect_ratio"),
          },
          enums: { aspect_ratio: ["1:1", "3:4", "16:9"] },
        }),
      },
    }));

    const result = await probeReplicateModel("bytedance/seedream-4.5");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.probe).toMatchObject({
      referenceField: "image_input",
      referenceArity: "array",
      // No maxItems in the schema — read out of the field's prose, per the spec.
      maxReferences: 14,
      canEdit: true,
      canGenerate: true,
      aspectMode: "aspect_ratio",
      supportedAspects: ["1:1", "3:4", "16:9"],
    });
  });

  it("marks a model whose reference input is REQUIRED as edit-only", async () => {
    stubFetch(() => ({
      name: "qwen-image-edit-2511",
      latest_version: {
        id: "v1",
        openapi_schema: openapi({
          properties: { prompt: { type: "string" }, image: uriArray() },
          required: ["prompt", "image"],
        }),
      },
    }));

    const result = await probeReplicateModel("qwen/qwen-image-edit-2511");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // This is what keeps the model out of the new-portrait picker with nobody flagging it.
    expect(result.probe.canGenerate).toBe(false);
    expect(result.probe.canEdit).toBe(true);
  });

  it("tells a single-URI reference from an array one under the same field name", async () => {
    stubFetch(() => ({
      name: "qwen-image-2512",
      latest_version: {
        id: "v1",
        openapi_schema: openapi({ properties: { prompt: { type: "string" }, image: uri } }),
      },
    }));

    const result = await probeReplicateModel("qwen/qwen-image-2512");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.probe.referenceArity).toBe("single");
    expect(result.probe.maxReferences).toBe(1);
  });

  it("falls back to the size enum when a model has no aspect_ratio input", async () => {
    stubFetch(() => ({
      name: "wan-2.7-image-pro",
      latest_version: {
        id: "v1",
        openapi_schema: openapi({
          properties: { prompt: { type: "string" }, images: uriArray("up to 9 images"), size: enumRef("size") },
          // Tier names carry no shape and must not become aspect options.
          enums: { size: ["1K", "2K", "1536*2048", "1024*768"] },
        }),
      },
    }));

    const result = await probeReplicateModel("wan-video/wan-2.7-image-pro");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.probe.aspectMode).toBe("size");
    expect(result.probe.supportedAspects).toEqual(["1536*2048", "1024*768"]);
    expect(result.probe.maxReferences).toBe(9);
  });

  it("pins extraInput only to keys the model actually declares", async () => {
    // Replicate rejects unknown inputs, so a safety toggle must never be
    // introduced on a model that has no such field.
    stubFetch(() => ({
      name: "no-toggles",
      latest_version: {
        id: "v1",
        openapi_schema: openapi({ properties: { prompt: { type: "string" } } }),
      },
    }));

    const result = await probeReplicateModel("acme/no-toggles");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.probe.extraInput).toEqual({});
  });

  it("reports whether the model is official, defaulting to community", async () => {
    // This decides HOW the model can be run: the bare-slug predictions endpoint
    // is official-only, so a community model's row must be pinned to a version
    // or every render 404s. A missing field is treated as community, because
    // pinning an official model still runs while the reverse does not.
    stubFetch(() => ({
      name: "flux-dev",
      is_official: true,
      latest_version: { id: "v-official", openapi_schema: openapi({ properties: { prompt: { type: "string" } } }) },
    }));
    const official = await probeReplicateModel("black-forest-labs/flux-dev");
    expect(official.ok && official.probe.isOfficial).toBe(true);

    stubFetch(() => ({
      name: "juggernaut-xl-v9",
      is_official: false,
      latest_version: { id: "v-community", openapi_schema: openapi({ properties: { prompt: { type: "string" } } }) },
    }));
    const community = await probeReplicateModel("lucataco/juggernaut-xl-v9");
    expect(community.ok && community.probe.isOfficial).toBe(false);

    stubFetch(() => ({
      name: "mystery",
      latest_version: { id: "v-unknown", openapi_schema: openapi({ properties: { prompt: { type: "string" } } }) },
    }));
    const absent = await probeReplicateModel("acme/mystery");
    expect(absent.ok && absent.probe.isOfficial).toBe(false);
  });

  it("registers a model whose description is null", async () => {
    // Replicate sends `"description": null` for a model with no blurb. Rejecting
    // the record over it refused two otherwise-fine models
    // (`nsfw-api/pony-realism-v2.3`, `nsfw-api/realvis-hyper-lora`).
    stubFetch(() => ({
      name: "realvis-hyper-lora",
      owner: "nsfw-api",
      description: null,
      latest_version: {
        id: "v1",
        openapi_schema: openapi({
          properties: {
            prompt: { type: "string" },
            reference_image: { type: "string", format: "uri", description: null },
          },
          required: ["prompt", "reference_image"],
        }),
      },
    }));

    const result = await probeReplicateModel("nsfw-api/realvis-hyper-lora");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.probe.referenceField).toBe("reference_image");
    expect(result.probe.canGenerate).toBe(false);
  });

  it("prefers a named identity input over a control image declared before it", async () => {
    // nsfw-api/sdxl-pulid declares `depth_image` ahead of `reference_image`, so
    // plain property order picks the ControlNet depth input — and every render
    // would hand a character's portrait to a depth converter, producing a
    // silhouette-shaped stranger with nothing in the payload looking wrong.
    stubFetch(() => ({
      name: "sdxl-pulid",
      latest_version: {
        id: "v1",
        openapi_schema: openapi({
          properties: {
            prompt: { type: "string" },
            depth_image: { type: "string", format: "uri", description: "converted to a depth map" },
            reference_image: { type: "string", format: "uri", description: "a face to use as reference" },
          },
          required: ["prompt"],
        }),
      },
    }));

    const result = await probeReplicateModel("nsfw-api/sdxl-pulid");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.probe.referenceField).toBe("reference_image");
    expect(result.probe.referenceArity).toBe("single");
    // Only `prompt` is required, so it can still run with no reference at all.
    expect(result.probe.canGenerate).toBe(true);
  });

  it("falls back to a control image only when nothing better is declared", async () => {
    stubFetch(() => ({
      name: "depth-only",
      latest_version: {
        id: "v1",
        openapi_schema: openapi({
          properties: { prompt: { type: "string" }, depth_image: { type: "string", format: "uri" } },
        }),
      },
    }));

    const result = await probeReplicateModel("someone/depth-only");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.probe.referenceField).toBe("depth_image");
    expect(result.probe.canEdit).toBe(true);
  });

  it("switches off a watermark the model would otherwise apply", async () => {
    // Juggernaut XL v9 defaults `apply_watermark` to true, which would mark
    // every image Vesper renders on it.
    stubFetch(() => ({
      name: "juggernaut-xl-v9",
      latest_version: {
        id: "v1",
        openapi_schema: openapi({
          properties: {
            prompt: { type: "string" },
            apply_watermark: { type: "boolean", default: true },
            disable_safety_checker: { type: "boolean", default: false },
          },
        }),
      },
    }));

    const result = await probeReplicateModel("lucataco/juggernaut-xl-v9");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.probe.extraInput).toEqual({ apply_watermark: false, disable_safety_checker: true });
  });

  describe("pinned versions", () => {
    const versionSchema = openapi({
      properties: { prompt: { type: "string" }, image_input: uriArray("up to 4 images") },
    });

    it("reads the PINNED version's schema, not latest_version's", async () => {
      // The whole point of pinning is that latest can drift; probing latest
      // would store capability columns describing a schema we never run.
      const calls: string[] = [];
      stubFetch((url) => {
        if (url.endsWith("/versions/abc123")) return { id: "abc123", openapi_schema: versionSchema };
        // If the probe asks for the bare model record, it is reading the wrong thing.
        return {
          name: "pinned",
          latest_version: {
            id: "latest",
            openapi_schema: openapi({ properties: { prompt: { type: "string" }, images: uriArray() } }),
          },
        };
      }, calls);

      const result = await probeReplicateModel("acme/pinned:abc123");
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(calls.some((url) => url.endsWith("/versions/abc123"))).toBe(true);
      expect(result.probe.referenceField).toBe("image_input");
      expect(result.probe.maxReferences).toBe(4);
      expect(result.probe.versionId).toBe("abc123");
    });

    it("reports a missing version distinctly from a missing model", async () => {
      stubFetch(() => undefined);
      const result = await probeReplicateModel("acme/pinned:nope");
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toContain("no version nope");
    });
  });

  describe("rejections", () => {
    it("rejects a path that is not owner/name", async () => {
      for (const bad of ["justname", "a/b/c", "a/b:c:d"]) {
        const result = await probeReplicateModel(bad);
        expect(result.ok).toBe(false);
      }
    });

    it("rejects a model with no prompt input", async () => {
      stubFetch(() => ({
        name: "upscaler",
        latest_version: { id: "v1", openapi_schema: openapi({ properties: { image: uri }, required: [] }) },
      }));
      const result = await probeReplicateModel("acme/upscaler");
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toContain("no \"prompt\" input");
    });

    it("rejects a model Replicate does not have", async () => {
      stubFetch(() => undefined);
      const result = await probeReplicateModel("acme/ghost");
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toContain("no model called acme/ghost");
    });

    it("fails clearly with no token", async () => {
      delete process.env.REPLICATE_API_TOKEN;
      const result = await probeReplicateModel("acme/anything");
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toContain("REPLICATE_API_TOKEN not configured");
    });
  });
});
