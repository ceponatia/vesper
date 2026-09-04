import { afterEach, describe, expect, it, vi } from "vitest";
import { createReplicateClient } from "./client";
import { DEFAULT_PREDICTION_TIMEOUT_MS } from "./config";
import type { ProbeResult } from "./probe";

/**
 * The probe runs on the SAME configured client rendering uses — it used to read
 * `REPLICATE_API_TOKEN` independently, which meant one process could probe with
 * one credential and render with another.
 */

afterEach(() => {
  vi.unstubAllGlobals();
});

const client = (apiToken: string | null = "test-token") =>
  createReplicateClient({ apiToken, safetyCheckerDisabled: true, predictionTimeoutMs: DEFAULT_PREDICTION_TIMEOUT_MS });

const probeReplicateModel = (slug: string): Promise<ProbeResult> => client().probeReplicateModel(slug);

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
      name: "likereality-pony-v1",
      is_official: false,
      latest_version: { id: "v-community", openapi_schema: openapi({ properties: { prompt: { type: "string" } } }) },
    }));
    const community = await probeReplicateModel("aisha-ai-official/likereality-pony-v1");
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
    // the record over it refused two otherwise-fine community models when this
    // was first hit (owner report 2026-08-05).
    stubFetch(() => ({
      name: "hyper-identity",
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

    const result = await probeReplicateModel("nsfw-api/hyper-identity");
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
    // The numbered-reference path owns the field now, so it must NOT double as
    // a dedicated input — one provider field, one transport.
    expect(result.probe.advancedCapabilities.additionalImageInputs).toEqual([]);
  });

  it("switches off a watermark the model would otherwise apply", async () => {
    // SDXL-family community wrappers commonly default `apply_watermark` to true,
    // which would mark every image Vesper renders on one.
    stubFetch(() => ({
      name: "sdxl-community",
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

    const result = await probeReplicateModel("someone/sdxl-community");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.probe.extraInput).toEqual({ apply_watermark: false, disable_safety_checker: true });
  });

  describe("advanced capabilities", () => {
    it("derives both LoRA bindings, with the range the schema declared", async () => {
      // The Qwen edit family's real LoRA shape, trimmed to the fields this case is
      // about. A locator sent to a field the active version does not declare is a
      // provider rejection at spend time, so the field names come from the schema
      // and are stored with the version they were read from.
      stubFetch(() => ({
        name: "qwen-image-edit-2511",
        latest_version: {
          id: "v1",
          openapi_schema: openapi({
            properties: {
              prompt: { type: "string" },
              image: uriArray(),
              lora_weights: { type: "string", default: "", description: "Pass a Hugging Face repo slug" },
              lora_scale: { type: "number", default: 1, minimum: 0, maximum: 4 },
            },
          }),
        },
      }));

      const result = await probeReplicateModel("qwen/qwen-image-edit-2511");
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.probe.advancedCapabilities.controls).toEqual({
        loraWeights: { field: "lora_weights", type: "string" },
        loraScale: { field: "lora_scale", type: "number", minimum: 0, maximum: 4 },
      });
      // EVERY declared input name, sorted — the allowlist providerOverrides
      // validation reads, which fails closed while this is empty.
      expect(result.probe.advancedCapabilities.knownInputFields).toEqual([
        "image",
        "lora_scale",
        "lora_weights",
        "prompt",
      ]);
      // `image` is the primary reference and no alias-table field is declared,
      // so the Qwen edit family stays on the numbered-primary path: a pose or
      // depth map travels as an ordinary reference, never a dedicated input.
      expect(result.probe.advancedCapabilities.additionalImageInputs).toEqual([]);
    });

    it("records no bindings for a version that declares none of the known aliases", async () => {
      // `qwen/qwen-image-edit-2511` — absent stays absent: a slot is derived only
      // when the schema declares a field of the expected type under a known name,
      // so a spartan schema keeps the inert control set (and with it, today's
      // payload) however often it is re-probed.
      stubFetch(() => ({
        name: "qwen-image-edit-2511",
        latest_version: {
          id: "v1",
          openapi_schema: openapi({ properties: { prompt: { type: "string" }, image: uriArray() } }),
        },
      }));

      const result = await probeReplicateModel("qwen/qwen-image-edit-2511");
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.probe.advancedCapabilities.controls).toEqual({});
      expect(result.probe.advancedCapabilities.knownInputFields).toEqual(["image", "prompt"]);
    });

    it("derives every known alias the schema declares, ranges and enums carried verbatim", async () => {
      stubFetch(() => ({
        name: "full-controls",
        latest_version: {
          id: "v1",
          openapi_schema: openapi({
            properties: {
              prompt: { type: "string" },
              image: uriArray(),
              seed: { type: "integer", minimum: 0, maximum: 2147483647 },
              negative_prompt: { type: "string" },
              guidance: { type: "number", minimum: 0, maximum: 20 },
              num_inference_steps: { type: "integer", minimum: 1, maximum: 50 },
              strength: { type: "number", minimum: 0, maximum: 1 },
              num_outputs: { type: "integer", minimum: 1, maximum: 4 },
              thinking_mode: { type: "boolean", default: false },
              sequential_image_generation: enumRef("sequential_image_generation"),
              image_set_mode: { type: "boolean", default: false },
              size: enumRef("size"),
              width: { type: "integer", minimum: 64, maximum: 4096 },
              height: { type: "integer", minimum: 64, maximum: 4096 },
            },
            enums: {
              sequential_image_generation: ["disabled", "auto"],
              size: ["1K", "2K", "4K", "custom"],
            },
          }),
        },
      }));

      const result = await probeReplicateModel("acme/full-controls");
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.probe.advancedCapabilities.controls).toEqual({
        seed: { field: "seed", type: "integer", minimum: 0, maximum: 2147483647 },
        negativePrompt: { field: "negative_prompt", type: "string" },
        guidance: { field: "guidance", type: "number", minimum: 0, maximum: 20 },
        steps: { field: "num_inference_steps", type: "integer", minimum: 1, maximum: 50 },
        editStrength: { field: "strength", type: "number", minimum: 0, maximum: 1 },
        outputCount: { field: "num_outputs", type: "integer", minimum: 1, maximum: 4 },
        thinkingMode: { field: "thinking_mode", type: "boolean" },
        sequentialMode: { field: "sequential_image_generation", type: "enum", enumValues: ["disabled", "auto"] },
        coherentSet: { field: "image_set_mode", type: "boolean" },
        resolutionTier: { field: "size", type: "enum", enumValues: ["1K", "2K", "4K", "custom"] },
        customWidth: { field: "width", type: "integer", minimum: 64, maximum: 4096 },
        customHeight: { field: "height", type: "integer", minimum: 64, maximum: 4096 },
      });
      // Sorted and COMPLETE — the whole Input schema, not just the bound aliases.
      expect(result.probe.advancedCapabilities.knownInputFields).toEqual(
        [
          "height",
          "guidance",
          "image",
          "image_set_mode",
          "negative_prompt",
          "num_inference_steps",
          "num_outputs",
          "prompt",
          "seed",
          "sequential_image_generation",
          "size",
          "strength",
          "thinking_mode",
          "width",
        ].sort(),
      );
    });

    it("keeps a seed's declared numeric type apart from integer", async () => {
      // The mapper refuses a fractional value on an integer binding, so the
      // probe must record the type the provider declared, not flatten it.
      stubFetch(() => ({
        name: "number-seed",
        latest_version: {
          id: "v1",
          openapi_schema: openapi({
            properties: { prompt: { type: "string" }, seed: { type: "number" } },
          }),
        },
      }));

      const result = await probeReplicateModel("acme/number-seed");
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      // No declared bounds ⇒ no invented ones.
      expect(result.probe.advancedCapabilities.controls.seed).toEqual({ field: "seed", type: "number" });
    });

    it("walks the guidance alias chain in order, and binds a model that publishes only the middle spelling", async () => {
      // `guidance_scale` was missing from the chain, and its absence was silent:
      // a model publishing that spelling probed to NO guidance binding, so the
      // control simply was not offered on the bench — no refusal, no drop entry,
      // nothing to read. The repo's own fixtures already model such a model
      // (render-fingerprint.test.ts binds guidance to `guidance_scale`).
      stubFetch(() => ({
        name: "every-guidance",
        latest_version: {
          id: "v1",
          openapi_schema: openapi({
            properties: {
              prompt: { type: "string" },
              guidance: { type: "number", minimum: 0, maximum: 10 },
              guidance_scale: { type: "number", minimum: 0, maximum: 20 },
              cfg: { type: "number", minimum: 0, maximum: 30 },
            },
          }),
        },
      }));
      const every = await probeReplicateModel("acme/every-guidance");
      expect(every.ok && every.probe.advancedCapabilities.controls.guidance).toEqual({
        field: "guidance",
        type: "number",
        minimum: 0,
        maximum: 10,
      });

      stubFetch(() => ({
        name: "guidance-scale-only",
        latest_version: {
          id: "v1",
          openapi_schema: openapi({
            properties: { prompt: { type: "string" }, guidance_scale: { type: "number", minimum: 0, maximum: 20 } },
          }),
        },
      }));
      const scaleOnly = await probeReplicateModel("acme/guidance-scale-only");
      expect(scaleOnly.ok && scaleOnly.probe.advancedCapabilities.controls.guidance).toEqual({
        field: "guidance_scale",
        type: "number",
        minimum: 0,
        maximum: 20,
      });

      stubFetch(() => ({
        name: "cfg-only",
        latest_version: {
          id: "v1",
          openapi_schema: openapi({
            properties: { prompt: { type: "string" }, cfg: { type: "number", minimum: 0, maximum: 30 } },
          }),
        },
      }));
      const cfgOnly = await probeReplicateModel("acme/cfg-only");
      expect(cfgOnly.ok && cfgOnly.probe.advancedCapabilities.controls.guidance).toEqual({
        field: "cfg",
        type: "number",
        minimum: 0,
        maximum: 30,
      });

      // `true_cfg_scale` is deliberately NOT a fourth alias, and this pins the
      // ruling rather than the omission: on a CFG-distilled checkpoint it is a
      // DIFFERENT quantity from the embedded guidance above, running an order of
      // magnitude higher. Binding both to one normalized name would leave a run
      // record unable to say which knob moved.
      stubFetch(() => ({
        name: "true-cfg-only",
        latest_version: {
          id: "v1",
          openapi_schema: openapi({
            properties: { prompt: { type: "string" }, true_cfg_scale: { type: "number", minimum: 1, maximum: 10 } },
          }),
        },
      }));
      const trueCfgOnly = await probeReplicateModel("acme/true-cfg-only");
      expect(trueCfgOnly.ok && trueCfgOnly.probe.advancedCapabilities.controls.guidance).toBeUndefined();
    });

    it("binds the accelerated sampling path as a control while keeping it pinned in the raw bag", async () => {
      // `qwen/qwen-image-edit-2511`'s real shape, and the pairing that makes this
      // control safe to add. `go_fast` becomes a normalized `fastMode` binding
      // AND stays a pinned `extraInput` constant with a reserved descriptor —
      // not a contradiction, because a mapped control overlays `extraInput` on
      // the way out. The typed control opens; the raw provider bag stays shut.
      // Dropping the pin instead would change every production payload on the
      // model whose reviewed policy exists to keep this path off.
      stubFetch(() => ({
        name: "qwen-image-edit-2511",
        latest_version: {
          id: "v1",
          openapi_schema: openapi({
            properties: {
              prompt: { type: "string" },
              image: uriArray(),
              go_fast: {
                type: "boolean",
                default: true,
                description: "Run faster predictions with additional optimizations.",
              },
            },
            required: ["prompt", "image"],
          }),
        },
      }));

      const result = await probeReplicateModel("qwen/qwen-image-edit-2511");
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.probe.advancedCapabilities.controls.fastMode).toEqual({ field: "go_fast", type: "boolean" });
      expect(result.probe.extraInput).toMatchObject({ go_fast: true });
      expect(
        result.probe.advancedCapabilities.providerInputs.find((input) => input.field === "go_fast"),
      ).toMatchObject({ type: "boolean", reserved: true });
    });

    it("derives a resolution tier only from a tier-bearing size ENUM, never a free string", async () => {
      // A free-string `size` gives the mapper nothing to validate a tier against,
      // and an enum of pixel pairs alone offers no tier to ask for.
      const probeSize = async (size: unknown, enums?: Record<string, string[]>) => {
        stubFetch(() => ({
          name: "size-model",
          latest_version: {
            id: "v1",
            openapi_schema: openapi({ properties: { prompt: { type: "string" }, size }, ...(enums ? { enums } : {}) }),
          },
        }));
        const result = await probeReplicateModel("acme/size-model");
        expect(result.ok).toBe(true);
        return result.ok ? result.probe.advancedCapabilities.controls.resolutionTier : undefined;
      };

      // Wan's real mix — tiers beside pixel pairs still counts, values verbatim.
      expect(await probeSize(enumRef("size"), { size: ["1K", "2K", "1536*2048"] })).toEqual({
        field: "size",
        type: "enum",
        enumValues: ["1K", "2K", "1536*2048"],
      });
      expect(await probeSize({ type: "string" })).toBeUndefined();
      expect(await probeSize(enumRef("size"), { size: ["1536*2048", "1024*768"] })).toBeUndefined();
    });

    it("skips an enum whose members are not all strings", async () => {
      // A filtered enum would record an accepted set that differs from the
      // provider's — a value judged valid here could still be rejected at spend
      // time — so a partially-string enum derives nothing. Mixed members can't
      // travel through the `enums` helper (it types strings), so the referenced
      // schema is stubbed directly.
      stubFetch(() => ({
        name: "mixed-enum",
        latest_version: {
          id: "v1",
          openapi_schema: {
            components: {
              schemas: {
                Input: {
                  properties: {
                    prompt: { type: "string" },
                    sequential_image_generation: enumRef("sequential_image_generation"),
                  },
                  required: ["prompt"],
                },
                sequential_image_generation: { enum: ["disabled", 2] },
              },
            },
          },
        },
      }));

      const result = await probeReplicateModel("acme/mixed-enum");
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.probe.advancedCapabilities.controls.sequentialMode).toBeUndefined();
    });

    it("omits a range the schema did not declare, and ignores a LoRA field of the wrong type", async () => {
      // Absent bounds mean "the provider declared none", never "unbounded" — writing
      // a made-up range would refuse values the model accepts. And a `lora_weights`
      // that is not a string is not the binding this derivation knows how to send.
      stubFetch(() => ({
        name: "odd-lora",
        latest_version: {
          id: "v1",
          openapi_schema: openapi({
            properties: {
              prompt: { type: "string" },
              lora_weights: { type: "array", items: { type: "string" } },
              lora_scale: { type: "number", default: 1 },
            },
          }),
        },
      }));

      const result = await probeReplicateModel("acme/odd-lora");
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.probe.advancedCapabilities.controls).toEqual({
        loraScale: { field: "lora_scale", type: "number" },
      });
    });

    it("derives dedicated inputs and reserved descriptors for the Vesper SDXL renderer's shape", async () => {
      // The real input schema of packages/image-sd/deployment/predict.py — the
      // shape the Image Generator's advanced form is built from. Everything the
      // render path owns must come back reserved, so the only field an admin can
      // set freely here is `recipe`.
      stubFetch(() => ({
        name: "sdxl-renderer",
        latest_version: {
          id: "v1",
          openapi_schema: openapi({
            properties: {
              prompt: { type: "string", description: "What to render." },
              negative_prompt: { type: "string", description: "What to avoid." },
              reference_image: { type: "string", format: "uri", description: "Identity reference for PuLID." },
              depth_image: { type: "string", format: "uri", description: "An already-preprocessed depth map." },
              pose_image: { type: "string", format: "uri", description: "An already-preprocessed pose skeleton." },
              lora_weights: { type: "string", description: "URL of one character LoRA." },
              lora_scale: { type: "number", minimum: 0, maximum: 2 },
              seed: { type: "integer", minimum: 0 },
              width: { type: "integer", default: 1024 },
              height: { type: "integer", default: 1024 },
              recipe: { type: "string", default: "identity_v1", description: "Which frozen recipe to run, by id." },
            },
            required: ["prompt"],
          }),
        },
      }));

      const result = await probeReplicateModel("vesper/sdxl-renderer");
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const caps = result.probe.advancedCapabilities;
      // Both ControlNet inputs, sorted by field; `reference_image` is the
      // primary reference and must never appear here.
      expect(caps.additionalImageInputs).toEqual([
        { roleHint: "depth", binding: { field: "depth_image", arity: "single", required: false } },
        { roleHint: "pose", binding: { field: "pose_image", arity: "single", required: false } },
      ]);
      // One descriptor per declared field, sorted, with the render path's
      // claims marked: prompt, primary reference, dedicated inputs, and every
      // control-bound field (width/height are customWidth/customHeight).
      expect(caps.providerInputs.map((input) => `${input.field}:${input.reserved ? "reserved" : "open"}`)).toEqual([
        "depth_image:reserved",
        "height:reserved",
        "lora_scale:reserved",
        "lora_weights:reserved",
        "negative_prompt:reserved",
        "pose_image:reserved",
        "prompt:reserved",
        "recipe:open",
        "reference_image:reserved",
        "seed:reserved",
        "width:reserved",
      ]);
      expect(caps.providerInputs.find((input) => input.field === "recipe")).toEqual({
        field: "recipe",
        type: "string",
        required: false,
        default: "identity_v1",
        description: "Which frozen recipe to run, by id.",
        reserved: false,
      });
      // Declared range and default carried verbatim; requiredness from required[].
      expect(caps.providerInputs.find((input) => input.field === "lora_scale")).toEqual({
        field: "lora_scale",
        type: "number",
        required: false,
        minimum: 0,
        maximum: 2,
        reserved: true,
      });
      expect(caps.providerInputs.find((input) => input.field === "prompt")).toMatchObject({
        type: "string",
        required: true,
      });
    });

    it("classifies only alias-table URI fields as dedicated inputs, never unknown ones", async () => {
      const longDescription = "x".repeat(600);
      stubFetch(() => ({
        name: "controlnet-stack",
        latest_version: {
          id: "v1",
          openapi_schema: openapi({
            properties: {
              prompt: { type: "string" },
              image: uri,
              style_image: { type: "string", format: "uri", description: longDescription },
              canny_image: uri,
              edge_image: uri,
              mask: uri,
              control_image: { type: "array", items: uri, maxItems: 2 },
            },
            required: ["prompt", "mask"],
          }),
        },
      }));

      const result = await probeReplicateModel("acme/controlnet-stack");
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.probe.referenceField).toBe("image");
      // Sorted by field; one binding PER ROLE — canny and edge both resolve to
      // the edge role and the alphabetically-first optional alias wins, since
      // the planner and forms only ever fill one binding per role; arity and
      // maxItems carried verbatim, required propagated from required[].
      expect(result.probe.advancedCapabilities.additionalImageInputs).toEqual([
        { roleHint: "edge", binding: { field: "canny_image", arity: "single", required: false } },
        { roleHint: "control", binding: { field: "control_image", arity: "array", required: false, maxItems: 2 } },
        { roleHint: "mask", binding: { field: "mask", arity: "single", required: true } },
      ]);
      // `style_image` is URI-typed but unnamed by the alias table, so it stays
      // unbound — reported as an open uri descriptor (its runaway description
      // capped at 500 so one verbose provider cannot fail the whole record),
      // never guessed into a role.
      expect(result.probe.advancedCapabilities.providerInputs.find((input) => input.field === "style_image")).toEqual({
        field: "style_image",
        type: "uri",
        required: false,
        description: "x".repeat(500),
        reserved: false,
      });
      const mask = result.probe.advancedCapabilities.providerInputs.find((input) => input.field === "mask");
      expect(mask).toMatchObject({ type: "uri", required: true, reserved: true });
      // The deduped-away edge alias stays RESERVED in the descriptors: it is
      // still a structural image field, and the raw provider bag must never be
      // the path that writes one.
      const edge = result.probe.advancedCapabilities.providerInputs.find((input) => input.field === "edge_image");
      expect(edge).toMatchObject({ type: "uri", reserved: true });
    });

    it("prefers a required alias over an optional one when a role is declared twice", async () => {
      // `mask` and `mask_image` both name the mask role. Recording both would
      // leave the required one permanently unfillable (the planner fills one
      // binding per role), so the required alias must be the one recorded.
      stubFetch(() => ({
        name: "double-mask",
        latest_version: {
          id: "v1",
          openapi_schema: openapi({
            properties: {
              prompt: { type: "string" },
              image: uri,
              mask: uri,
              mask_image: uri,
            },
            required: ["prompt", "mask_image"],
          }),
        },
      }));
      const result = await probeReplicateModel("acme/double-mask");
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.probe.advancedCapabilities.additionalImageInputs).toEqual([
        { roleHint: "mask", binding: { field: "mask_image", arity: "single", required: true } },
      ]);
    });

    it("derives an identical record however the provider orders its properties", async () => {
      // Re-probing an unchanged schema must produce a byte-identical capability
      // record — the version diff reads equality, and a derivation that leaked
      // property declaration order would report phantom changes on every probe.
      const properties: Record<string, unknown> = {
        prompt: { type: "string" },
        reference_image: uri,
        depth_image: uri,
        pose_image: uri,
        recipe: { type: "string", default: "identity_v1" },
      };
      const probeWith = async (ordered: Record<string, unknown>) => {
        stubFetch(() => ({
          name: "sdxl-renderer",
          latest_version: { id: "v1", openapi_schema: openapi({ properties: ordered, required: ["prompt"] }) },
        }));
        const result = await probeReplicateModel("vesper/sdxl-renderer");
        expect(result.ok).toBe(true);
        return result.ok ? result.probe.advancedCapabilities : undefined;
      };

      const forward = await probeWith(properties);
      const reversed = await probeWith(Object.fromEntries(Object.entries(properties).reverse()));
      expect(JSON.stringify(reversed)).toBe(JSON.stringify(forward));
    });
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

    it("fails clearly on an unconfigured client, without asking the network", async () => {
      const network = vi.fn();
      vi.stubGlobal("fetch", network);
      const result = await client(null).probeReplicateModel("acme/anything");
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toContain("REPLICATE_API_TOKEN not configured");
      expect(network).not.toHaveBeenCalled();
    });

    it("sends the configured client's credential rather than reading one", async () => {
      const headers: Array<Record<string, string> | undefined> = [];
      vi.stubGlobal(
        "fetch",
        vi.fn((_input: string | URL | Request, init?: RequestInit) => {
          headers.push(init?.headers as Record<string, string> | undefined);
          return Promise.resolve(new Response(null, { status: 404 }));
        }),
      );
      await client("probe-credential").probeReplicateModel("acme/anything");
      expect(headers[0]).toMatchObject({ Authorization: "Bearer probe-credential" });
    });
  });
});
