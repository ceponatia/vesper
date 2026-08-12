import { describe, expect, it } from "vitest";
import type { ImageModelControlBindings } from "../capabilities/image-model-capabilities";
import {
  applyImageLoraPromptAdditions,
  effectiveImageLoraSelection,
  evaluateImageLoraForRender,
  imageLoraCreateRequestSchema,
  imageLoraSchema,
  imageLoraUpdateRequestSchema,
  isValidImageLoraLocator,
  redactImageLoraLocator,
  type EvaluateImageLoraForRenderInput,
  type ImageLora,
} from "./image-loras";

/**
 * The library's whole job is to refuse. A LoRA is a pointer to somebody else's
 * weights file, so almost every case here is about something NOT being sent — and
 * about which of the two codes says so, because "this LoRA is not for this job"
 * and "this model has no LoRA input" send an operator to different screens.
 */

const HF_LOCATOR = "flymy-ai/qwen-image-edit-2509-inscene-lora";
const MODEL_SLUG = "qwen/qwen-image-edit-plus-lora";
const VERSION = "b37d69a6b94414c96cc4ecb16660b472bb62284f2293d4b65537c09b8500e200";

function lora(over: Record<string, unknown> = {}): ImageLora {
  return imageLoraSchema.parse({
    id: "lora-1",
    label: "In Scene",
    locatorType: "huggingface_repo",
    locator: HF_LOCATOR,
    compatibleModelSlugs: [MODEL_SLUG],
    defaultScale: 1,
    minimumScale: 0,
    maximumScale: 2,
    allowedTasks: ["variant"],
    ...over,
  });
}

/** The live Qwen LoRA binding, as the probe records it. */
function bindings(over: Partial<ImageModelControlBindings> = {}): ImageModelControlBindings {
  return {
    loraWeights: { field: "lora_weights", type: "string" },
    loraScale: { field: "lora_scale", type: "number", minimum: 0, maximum: 4 },
    ...over,
  };
}

function evaluate(over: Partial<EvaluateImageLoraForRenderInput> = {}) {
  return evaluateImageLoraForRender({
    lora: lora(),
    modelSlug: MODEL_SLUG,
    versionId: VERSION,
    task: "variant",
    bindings: bindings(),
    ...over,
  });
}

describe("imageLoraSchema", () => {
  it("round-trips a full row", () => {
    const row = {
      id: "lora-2",
      label: "Ink Wash",
      locatorType: "https_url" as const,
      locator: "https://cdn.example.invalid/loras/ink-wash.safetensors",
      compatibleModelSlugs: [MODEL_SLUG],
      compatibleVersionIds: [VERSION],
      defaultScale: 0.85,
      minimumScale: 0.25,
      maximumScale: 1.5,
      triggerWords: ["ink wash", "sumi-e"],
      promptPrefix: "Ink wash painting.",
      promptSuffix: "Loose brushwork throughout.",
      allowedTasks: ["variant" as const, "scene" as const],
      enabled: true,
      builtin: false,
    };
    expect(imageLoraSchema.parse(row)).toEqual(row);
  });

  it("defaults every collection and both prompt additions so a sparse row still parses", () => {
    const parsed = imageLoraSchema.parse({
      id: "lora-3",
      label: "Sparse",
      locatorType: "huggingface_repo",
      locator: HF_LOCATOR,
      defaultScale: 1,
      minimumScale: 1,
      maximumScale: 1,
    });
    expect(parsed.compatibleModelSlugs).toEqual([]);
    expect(parsed.compatibleVersionIds).toEqual([]);
    expect(parsed.triggerWords).toEqual([]);
    expect(parsed.allowedTasks).toEqual([]);
    expect(parsed.promptPrefix).toBeNull();
    expect(parsed.promptSuffix).toBeNull();
    expect(parsed.enabled).toBe(true);
    expect(parsed.builtin).toBe(false);
  });

  it("does not share its defaulted collections between two parsed rows", () => {
    // Zod hands a default back without cloning it, so a literal `[]` would be one
    // array instance on every row and pushing a trigger word onto one library entry
    // would rewrite them all.
    const first = imageLoraSchema.parse({
      id: "a",
      label: "A",
      locatorType: "huggingface_repo",
      locator: HF_LOCATOR,
      defaultScale: 1,
      minimumScale: 1,
      maximumScale: 1,
    });
    const second = imageLoraSchema.parse({
      id: "b",
      label: "B",
      locatorType: "huggingface_repo",
      locator: HF_LOCATOR,
      defaultScale: 1,
      minimumScale: 1,
      maximumScale: 1,
    });
    expect(first.triggerWords).not.toBe(second.triggerWords);
    first.triggerWords.push("mine");
    first.compatibleModelSlugs.push(MODEL_SLUG);
    expect(second.triggerWords).toEqual([]);
    expect(second.compatibleModelSlugs).toEqual([]);
  });

  it("normalizes an emptied prompt addition to null rather than storing a blank", () => {
    const parsed = imageLoraSchema.parse({
      id: "c",
      label: "C",
      locatorType: "huggingface_repo",
      locator: HF_LOCATOR,
      defaultScale: 1,
      minimumScale: 1,
      maximumScale: 1,
      promptPrefix: "   ",
    });
    expect(parsed.promptPrefix).toBeNull();
  });
});

describe("isValidImageLoraLocator", () => {
  it("accepts an HTTPS URL, including one carrying signed query parameters", () => {
    expect(isValidImageLoraLocator("https_url", "https://cdn.example.invalid/l.safetensors")).toBe(true);
    expect(isValidImageLoraLocator("https_url", "https://cdn.example.invalid/l.safetensors?sig=abc&exp=1")).toBe(true);
  });

  it("refuses plaintext HTTP and a URL carrying credentials", () => {
    // Weights fetched over HTTP are weights anyone on the path can replace, and a
    // credential in a locator is a credential in the database and on the admin page.
    expect(isValidImageLoraLocator("https_url", "http://cdn.example.invalid/l.safetensors")).toBe(false);
    expect(isValidImageLoraLocator("https_url", "https://user:pass@cdn.example.invalid/l.safetensors")).toBe(false);
    expect(isValidImageLoraLocator("https_url", "not a url at all")).toBe(false);
    expect(isValidImageLoraLocator("https_url", HF_LOCATOR)).toBe(false);
  });

  it("accepts a two-segment owner/repo slug", () => {
    expect(isValidImageLoraLocator("huggingface_repo", HF_LOCATOR)).toBe(true);
    expect(isValidImageLoraLocator("huggingface_repo", "owner_1/repo.v2-final")).toBe(true);
  });

  it("refuses anything that is not exactly owner/repo", () => {
    expect(isValidImageLoraLocator("huggingface_repo", "owner/repo/extra")).toBe(false);
    expect(isValidImageLoraLocator("huggingface_repo", "https://huggingface.co/owner/repo")).toBe(false);
    expect(isValidImageLoraLocator("huggingface_repo", "owner repo/name")).toBe(false);
    expect(isValidImageLoraLocator("huggingface_repo", "owner")).toBe(false);
    expect(isValidImageLoraLocator("huggingface_repo", "-owner/repo")).toBe(false);
    expect(isValidImageLoraLocator("huggingface_repo", "owner/repo-")).toBe(false);
    expect(isValidImageLoraLocator("huggingface_repo", "owner/repo?token=abc")).toBe(false);
  });

  it("is the same rule the row parser enforces", () => {
    const refused = imageLoraSchema.safeParse({
      id: "x",
      label: "X",
      locatorType: "https_url",
      locator: HF_LOCATOR,
      defaultScale: 1,
      minimumScale: 1,
      maximumScale: 1,
    });
    expect(refused.success).toBe(false);
  });
});

describe("redactImageLoraLocator", () => {
  it("strips a URL's query string and fragment so a signed locator never reaches a log", () => {
    expect(redactImageLoraLocator("https://cdn.example.invalid/l.safetensors?sig=secret#frag")).toBe(
      "https://cdn.example.invalid/l.safetensors",
    );
  });

  it("strips embedded credentials too", () => {
    expect(redactImageLoraLocator("https://user:pass@cdn.example.invalid/l.safetensors")).toBe(
      "https://cdn.example.invalid/l.safetensors",
    );
  });

  it("passes a repo slug through unchanged, and never throws on an unparseable locator", () => {
    expect(redactImageLoraLocator(HF_LOCATOR)).toBe(HF_LOCATOR);
    expect(redactImageLoraLocator("")).toBe("");
  });
});

describe("scale invariants", () => {
  const base = {
    id: "s",
    label: "S",
    locatorType: "huggingface_repo" as const,
    locator: HF_LOCATOR,
  };

  it("refuses a triple whose default sits outside its own range", () => {
    expect(imageLoraSchema.safeParse({ ...base, defaultScale: 0.2, minimumScale: 0.5, maximumScale: 2 }).success).toBe(
      false,
    );
    expect(imageLoraSchema.safeParse({ ...base, defaultScale: 3, minimumScale: 0, maximumScale: 2 }).success).toBe(false);
  });

  it("refuses a scale outside the absolute 0–4 band the provider binding publishes", () => {
    expect(imageLoraSchema.safeParse({ ...base, defaultScale: 5, minimumScale: 0, maximumScale: 5 }).success).toBe(false);
    expect(imageLoraSchema.safeParse({ ...base, defaultScale: -1, minimumScale: -1, maximumScale: 2 }).success).toBe(
      false,
    );
  });

  it("refuses a non-finite scale", () => {
    expect(
      imageLoraSchema.safeParse({ ...base, defaultScale: Number.NaN, minimumScale: 0, maximumScale: 2 }).success,
    ).toBe(false);
    expect(
      imageLoraSchema.safeParse({ ...base, defaultScale: Number.POSITIVE_INFINITY, minimumScale: 0, maximumScale: 4 })
        .success,
    ).toBe(false);
  });

  it("accepts an ordered triple at the band's edges", () => {
    expect(imageLoraSchema.safeParse({ ...base, defaultScale: 0, minimumScale: 0, maximumScale: 4 }).success).toBe(true);
  });
});

describe("evaluateImageLoraForRender", () => {
  it("binds the row's locator at its default scale when everything agrees", () => {
    const result = evaluate({
      lora: lora({ promptPrefix: "Ink wash painting.", triggerWords: ["sumi-e"] }),
    });
    expect(result).toEqual({
      ok: true,
      binding: {
        id: "lora-1",
        label: "In Scene",
        locator: HF_LOCATOR,
        scale: 1,
        promptPrefix: "Ink wash painting.",
        promptSuffix: null,
        triggerWords: ["sumi-e"],
      },
    });
  });

  it("honours a requested scale inside the curated range", () => {
    const result = evaluate({ requestedScale: 1.75 });
    expect(result.ok && result.binding.scale).toBe(1.75);
  });

  it("reports a switched-off row as unreachable rather than incompatible", () => {
    // Nothing about the JOB is wrong — the operator turned the row off, and the fix
    // is on the library screen, not the profile.
    const result = evaluate({ lora: lora({ enabled: false }) });
    expect(result).toMatchObject({ ok: false, code: "image_lora.unreachable_configuration" });
  });

  it("refuses a model the LoRA was not trained against", () => {
    const result = evaluate({ modelSlug: "qwen/qwen-image-edit-2511" });
    expect(result).toMatchObject({ ok: false, code: "image_lora.incompatible" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("qwen/qwen-image-edit-2511");
  });

  it("refuses every model when the compatibility list is empty", () => {
    // Empty is "unfinished row", never "any model": a LoRA is trained against one
    // base model and produces noise on another.
    const result = evaluate({ lora: lora({ compatibleModelSlugs: [] }) });
    expect(result).toMatchObject({ ok: false, code: "image_lora.incompatible" });
  });

  it("compares base slug to base slug, so a pinned row still matches", () => {
    expect(evaluate({ modelSlug: `${MODEL_SLUG}:${VERSION}` }).ok).toBe(true);
    expect(evaluate({ lora: lora({ compatibleModelSlugs: [`${MODEL_SLUG}:${VERSION}`] }) }).ok).toBe(true);
  });

  it("treats an empty version list as any version of a compatible slug", () => {
    expect(evaluate({ versionId: null }).ok).toBe(true);
    expect(evaluate({ versionId: "some-other-version" }).ok).toBe(true);
  });

  it("cannot verify a version-pinned LoRA on a render that names no version", () => {
    // A row listing exact versions is a reviewer saying this LoRA does NOT survive a
    // version change, so an unnameable version is unverifiable rather than merely
    // unlisted — a different code, and a different fix.
    const result = evaluate({ lora: lora({ compatibleVersionIds: [VERSION] }), versionId: null });
    expect(result).toMatchObject({ ok: false, code: "image_lora.unreachable_configuration" });
  });

  it("refuses a version the row does not list, and accepts one it does", () => {
    const refused = evaluate({ lora: lora({ compatibleVersionIds: [VERSION] }), versionId: "another-version" });
    expect(refused).toMatchObject({ ok: false, code: "image_lora.incompatible" });
    expect(evaluate({ lora: lora({ compatibleVersionIds: [VERSION] }) }).ok).toBe(true);
  });

  it("refuses a task the row does not allow", () => {
    const result = evaluate({ task: "portrait" });
    expect(result).toMatchObject({ ok: false, code: "image_lora.incompatible" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("portrait");
  });

  it("refuses a requested scale outside the curated range instead of clamping it", () => {
    // Sending 2 where 3 was asked for renders something nobody configured under a
    // record claiming 3 was requested.
    expect(evaluate({ requestedScale: 3 })).toMatchObject({ ok: false, code: "image_lora.incompatible" });
    expect(evaluate({ lora: lora({ minimumScale: 0.5 }), requestedScale: 0.1 })).toMatchObject({
      ok: false,
      code: "image_lora.incompatible",
    });
  });

  it("refuses a version that exposes only one of the two LoRA inputs", () => {
    // A locator with no scale beside it runs at the model's own default strength,
    // which is a different render from the one the record claims.
    expect(evaluate({ bindings: bindings({ loraScale: undefined }) })).toMatchObject({
      ok: false,
      code: "image_lora.unreachable_configuration",
    });
    expect(evaluate({ bindings: bindings({ loraWeights: undefined }) })).toMatchObject({
      ok: false,
      code: "image_lora.unreachable_configuration",
    });
    expect(evaluate({ bindings: {} })).toMatchObject({
      ok: false,
      code: "image_lora.unreachable_configuration",
    });
  });

  it("refuses a curated scale the version's own binding will not accept", () => {
    // The curated band is a rail on the CONFIGURATION; the authoritative range is
    // whatever the active version declared, and a value outside it is a provider
    // rejection waiting to be paid for.
    const result = evaluate({
      lora: lora({ maximumScale: 4 }),
      requestedScale: 3,
      bindings: bindings({ loraScale: { field: "lora_scale", type: "number", minimum: 0, maximum: 2 } }),
    });
    expect(result).toMatchObject({ ok: false, code: "image_lora.unreachable_configuration" });
  });

  it("refuses a stored locator that no longer passes validation, without leaking its query string", () => {
    // A row written before this rule tightened. The message names the redacted
    // locator, never the signed original.
    const stale: ImageLora = { ...lora(), locatorType: "https_url", locator: "http://cdn.invalid/l.bin?sig=secret" };
    const result = evaluate({ lora: stale });
    expect(result).toMatchObject({ ok: false, code: "image_lora.unreachable_configuration" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("http://cdn.invalid/l.bin");
      expect(result.message).not.toContain("secret");
    }
  });
});

describe("applyImageLoraPromptAdditions", () => {
  const binding = {
    id: "lora-1",
    label: "In Scene",
    locator: HF_LOCATOR,
    scale: 1,
    promptPrefix: null as string | null,
    promptSuffix: null as string | null,
    triggerWords: [] as string[],
  };

  it("returns the prompt untouched when there is no binding", () => {
    expect(applyImageLoraPromptAdditions("a warm room", undefined)).toBe("a warm room");
    expect(applyImageLoraPromptAdditions("a warm room", null)).toBe("a warm room");
  });

  it("returns the prompt untouched when the binding carries no additions", () => {
    expect(applyImageLoraPromptAdditions("a warm room", binding)).toBe("a warm room");
  });

  it("weaves the prefix before and the suffix after the compiled prompt", () => {
    const woven = applyImageLoraPromptAdditions("a warm room", {
      ...binding,
      promptPrefix: "Ink wash painting.",
      promptSuffix: "Loose brushwork.",
    });
    expect(woven).toBe("Ink wash painting.\n\na warm room\n\nLoose brushwork.");
  });

  it("appends only the trigger words the assembled text does not already contain", () => {
    const woven = applyImageLoraPromptAdditions("a Sumi-E study of a warm room", {
      ...binding,
      triggerWords: ["sumi-e", "ink wash"],
    });
    // Matching is case-insensitive: "Sumi-E" in the prompt is the trigger for every
    // purpose the model has, and repeating it reads as emphasis nobody asked for.
    expect(woven).toBe("a Sumi-E study of a warm room\n\nink wash");
  });

  it("finds a trigger word supplied by the prefix, not only by the prompt", () => {
    const woven = applyImageLoraPromptAdditions("a warm room", {
      ...binding,
      promptPrefix: "Ink wash painting.",
      triggerWords: ["ink wash"],
    });
    expect(woven).toBe("Ink wash painting.\n\na warm room");
  });

  it("appends every missing trigger word as one comma-joined line", () => {
    const woven = applyImageLoraPromptAdditions("a warm room", {
      ...binding,
      triggerWords: ["sumi-e", "ink wash", "sumi-e"],
    });
    expect(woven).toBe("a warm room\n\nsumi-e, ink wash");
  });
});

describe("effectiveImageLoraSelection", () => {
  it("prefers the request's own selection over the profile's stored default", () => {
    expect(effectiveImageLoraSelection({ lora: { id: "stored" } }, { lora: { id: "requested", scale: 1.2 } })).toEqual({
      id: "requested",
      scale: 1.2,
    });
  });

  it("falls back to the profile's stored default", () => {
    expect(effectiveImageLoraSelection({ lora: { id: "stored" } }, {})).toEqual({ id: "stored" });
    expect(effectiveImageLoraSelection({ lora: { id: "stored" } }, undefined)).toEqual({ id: "stored" });
  });

  it("finds no selection when neither layer names one, and never throws on an unreadable blob", () => {
    expect(effectiveImageLoraSelection({}, {})).toBeUndefined();
    expect(effectiveImageLoraSelection(undefined, undefined)).toBeUndefined();
    expect(effectiveImageLoraSelection("not an object", undefined)).toBeUndefined();
    expect(effectiveImageLoraSelection({ lora: { scale: 2 } }, undefined)).toBeUndefined();
  });
});

describe("admin request schemas", () => {
  const create = {
    label: "Ink Wash",
    locatorType: "https_url" as const,
    locator: "https://cdn.example.invalid/loras/ink-wash.safetensors",
    defaultScale: 1,
    minimumScale: 0,
    maximumScale: 2,
  };

  it("defaults a create request's collections and enables the row", () => {
    const parsed = imageLoraCreateRequestSchema.parse(create);
    expect(parsed.compatibleModelSlugs).toEqual([]);
    expect(parsed.allowedTasks).toEqual([]);
    expect(parsed.enabled).toBe(true);
    expect(parsed.promptSuffix).toBeNull();
  });

  it("applies the same locator and scale rules as the row parser", () => {
    expect(imageLoraCreateRequestSchema.safeParse({ ...create, locator: HF_LOCATOR }).success).toBe(false);
    expect(imageLoraCreateRequestSchema.safeParse({ ...create, minimumScale: 1.5 }).success).toBe(false);
  });

  it("accepts a partial update and leaves absent fields absent", () => {
    const parsed = imageLoraUpdateRequestSchema.parse({ enabled: false });
    expect(parsed).toEqual({ enabled: false });
    expect(Object.keys(parsed)).toEqual(["enabled"]);
  });

  it("judges the scale triple only when the whole triple arrives", () => {
    // One field at a time is exactly how a stored triple goes out of order, which is
    // why the service re-checks the MERGED row; this schema can only see what it was sent.
    expect(imageLoraUpdateRequestSchema.safeParse({ minimumScale: 3 }).success).toBe(true);
    expect(
      imageLoraUpdateRequestSchema.safeParse({ minimumScale: 3, defaultScale: 1, maximumScale: 4 }).success,
    ).toBe(false);
  });

  it("judges a locator only when its type arrives with it", () => {
    expect(imageLoraUpdateRequestSchema.safeParse({ locator: HF_LOCATOR }).success).toBe(true);
    expect(imageLoraUpdateRequestSchema.safeParse({ locatorType: "https_url", locator: HF_LOCATOR }).success).toBe(
      false,
    );
  });
});
