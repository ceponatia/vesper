import { describe, expect, it } from "vitest";
import {
  fluxKleinBase,
  fluxKleinBaseLora,
  fluxKleinCivitaiDistilledLora,
  fluxKleinDistilled,
  fluxKontextDev,
  qwenImage2512,
  qwenImage3Edit,
  qwenImage3TextToImage,
  qwenImageEdit2511,
  seedream45,
  seedream5Lite,
} from "./families";
import { adapterForImageModel } from "./registry";
import {
  CIVITAI_FLUX2_KLEIN4B_SLUG,
  FAL_QWEN3_EDIT_SLUG,
  FAL_QWEN3_TEXT_SLUG,
  imageModelProvider,
} from "./provider";

/**
 * Adapter resolution.
 *
 * Replicate rows may carry `owner/name:version`, while fal Qwen Image 3 rows are
 * exact operation endpoints with a third path segment and Civitai uses a
 * Vesper-owned exact provider identity. The registry must resolve all forms
 * without prefix inheritance: similarly named siblings are separate endpoints
 * and a retired Replicate Qwen 3 slug must not inherit fal behavior.
 *
 * The klein block below (#567) protects the companion requirement: six EXACT
 * Replicate base slugs resolve, `black-forest-labs/flux-2-klein-` is never
 * matched as a prefix, and the unrelated production Flux checkpoints keep
 * answering null.
 */
describe("adapterForImageModel", () => {
  it("resolves every registered Qwen endpoint", () => {
    expect(adapterForImageModel("qwen/qwen-image-edit-2511")).toBe(qwenImageEdit2511);
    expect(adapterForImageModel("qwen/qwen-image-2512")).toBe(qwenImage2512);
    expect(adapterForImageModel("alibaba/qwen-image-3/text-to-image")).toBe(qwenImage3TextToImage);
    expect(adapterForImageModel("alibaba/qwen-image-3/edit")).toBe(qwenImage3Edit);
    expect(
      adapterForImageModel(
        "qwen/qwen-image-edit-2511:2ef4a1e6dbbd5b8f0d8f3cbbd3a1cbee0b1d4c0f6ee1c8ad5b7f2e0c9a3d4b1e",
      ),
    ).toBe(qwenImageEdit2511);
  });

  it("keeps fal generation and edit adapters distinct even while their first semantic sets match", () => {
    expect(qwenImage3TextToImage).not.toBe(qwenImage3Edit);
    expect(qwenImage3TextToImage.capabilities).toEqual(["prompt", "seed", "negativePrompt"]);
    expect(qwenImage3Edit.capabilities).toEqual(qwenImage3TextToImage.capabilities);
  });

  it("declares runtime LoRA capability on the 2511 edit endpoint and not the generators/editors that lack it", () => {
    expect(qwenImageEdit2511.capabilities).toContain("lora");
    expect(qwenImage2512.capabilities).not.toContain("lora");
    expect(qwenImage3TextToImage.capabilities).not.toContain("lora");
    expect(qwenImage3Edit.capabilities).not.toContain("lora");
  });

  it.each([
    "qwen/qwen-image-edit-2511-turbo",
    "qwen/qwen-image-2",
    "qwen/qwen-image-2:266e594fa007032292c211586354fe193d7aa4e675a1eeb0aef0c6a424468ddd",
    // Retired Replicate Qwen Image 3 identities must not inherit the fal endpoint adapters.
    "alibaba/qwen-image-3",
    "alibaba/qwen-image-3-pro",
    // The production Flux checkpoints are a separate, unmigrated family (#340):
    // sharing the word "flux" with klein must not resolve any adapter for them.
    "flux-dev",
    "flux-2-dev",
    "flux-2-pro",
    "aisha-ai-official/nsfw-flux-dev",
    "",
  ])("answers null for %s, which is the ordinary no-special-behavior case", (slug) => {
    expect(adapterForImageModel(slug)).toBeNull();
  });
});

/** #336/#337: exact Seedream endpoint lookup must survive a Replicate pin without matching a sibling by prefix. */
describe("adapterForImageModel: Seedream family", () => {
  it("resolves both exact and pinned endpoint slugs to their distinct compositions", () => {
    const version45 = "9fe3b8282dcb9d9063b05e33210a1432801f7c5a6641db944baefcec4886761a";
    const version5Lite = "eeb2857d94c49a5bcbc9d6c6057416e1d3b1a2735a16e08e4def9bf7ee22ec71";
    expect(adapterForImageModel("bytedance/seedream-4.5")).toBe(seedream45);
    expect(adapterForImageModel(`bytedance/seedream-4.5:${version45}`)).toBe(seedream45);
    expect(adapterForImageModel("bytedance/seedream-5-lite")).toBe(seedream5Lite);
    expect(adapterForImageModel(`bytedance/seedream-5-lite:${version5Lite}`)).toBe(seedream5Lite);
    expect(seedream45).not.toBe(seedream5Lite);
  });

  it.each(["bytedance/seedream-5", "bytedance/seedream-4.5-turbo", "bytedance/seedream-5-lite-turbo"])(
    "does not inherit the Seedream adapter for unregistered sibling %s",
    (slug) => expect(adapterForImageModel(slug)).toBeNull(),
  );
});

describe("adapterForImageModel: FLUX.2 klein (#567)", () => {
  it("resolves all six exact bare Replicate klein slugs, with 4B/9B twins sharing one variant object", () => {
    expect(adapterForImageModel("black-forest-labs/flux-2-klein-4b")).toBe(fluxKleinDistilled);
    expect(adapterForImageModel("black-forest-labs/flux-2-klein-9b")).toBe(fluxKleinDistilled);
    expect(adapterForImageModel("black-forest-labs/flux-2-klein-4b-base")).toBe(fluxKleinBase);
    expect(adapterForImageModel("black-forest-labs/flux-2-klein-9b-base")).toBe(fluxKleinBase);
    expect(adapterForImageModel("black-forest-labs/flux-2-klein-4b-base-lora")).toBe(fluxKleinBaseLora);
    expect(adapterForImageModel("black-forest-labs/flux-2-klein-9b-base-lora")).toBe(fluxKleinBaseLora);
  });

  it("resolves Civitai distilled 4B to its own LoRA-capable adapter", () => {
    expect(adapterForImageModel(CIVITAI_FLUX2_KLEIN4B_SLUG)).toBe(fluxKleinCivitaiDistilledLora);
    expect(fluxKleinCivitaiDistilledLora.capabilities).toContain("lora");
    expect(fluxKleinCivitaiDistilledLora.capabilities).toContain("negativePrompt");
    expect(fluxKleinCivitaiDistilledLora.capabilities).not.toContain("fastMode");
  });

  it("resolves pinned owner/name:version forms through the existing base-slug helper, with no new code", () => {
    expect(
      adapterForImageModel(
        "black-forest-labs/flux-2-klein-4b:9f1c6c9c9a2a4e2fa6b6a4e6c9c1c6c9c9a2a4e2fa6b6a4e6c9c1c6c9c9a2a4e",
      ),
    ).toBe(fluxKleinDistilled);
    expect(
      adapterForImageModel(
        "black-forest-labs/flux-2-klein-9b-base-lora:9f1c6c9c9a2a4e2fa6b6a4e6c9c1c6c9c9a2a4e2fa6b6a4e6c9c1c6c9c9a2a4e",
      ),
    ).toBe(fluxKleinBaseLora);
  });

  it("does not resolve any adapter for a broad flux- prefix, only the exact registered slugs", () => {
    expect(adapterForImageModel("black-forest-labs/flux-2-klein")).toBeNull();
    expect(adapterForImageModel("black-forest-labs/flux-2-klein-4b-turbo")).toBeNull();
    expect(adapterForImageModel("civitai/flux-2-klein-4b-base")).toBeNull();
  });
});

/**
 * FLUX.1 Kontext Dev (#574): a single new endpoint, its own family, sharing
 * no behavior with klein. Protects the same two requirements as the klein
 * block above — the bare and pinned slugs resolve, and the closest-named
 * siblings (the LoRA endpoint, the Pro/Max tiers, the bare family name, and
 * `flux-dev`) resolve nothing.
 */
describe("adapterForImageModel: FLUX.1 Kontext Dev (#574)", () => {
  it("resolves the bare dev slug", () => {
    expect(adapterForImageModel("black-forest-labs/flux-kontext-dev")).toBe(fluxKontextDev);
  });

  it("resolves the pinned owner/name:version form through the existing base-slug helper, with no new code", () => {
    expect(
      adapterForImageModel(
        "black-forest-labs/flux-kontext-dev:85723d503c17da3f9fd9cecfb9987a8bf60ef747fd8f68a25d7636f88260eb59",
      ),
    ).toBe(fluxKontextDev);
  });

  it.each([
    "black-forest-labs/flux-kontext-dev-lora",
    "black-forest-labs/flux-kontext-pro",
    "black-forest-labs/flux-kontext-max",
    "black-forest-labs/flux-kontext",
    "black-forest-labs/flux-dev",
  ])("answers null for the sibling endpoint %s", (slug) => {
    expect(adapterForImageModel(slug)).toBeNull();
  });

  it("is a different object from every klein variant", () => {
    expect(fluxKontextDev).not.toBe(fluxKleinDistilled);
    expect(fluxKontextDev).not.toBe(fluxKleinBase);
    expect(fluxKontextDev).not.toBe(fluxKleinBaseLora);
  });
});

describe("imageModelProvider", () => {
  it("classifies only reviewed exact non-Replicate identities away from Replicate", () => {
    expect(imageModelProvider(CIVITAI_FLUX2_KLEIN4B_SLUG)).toBe("civitai");
    expect(imageModelProvider(FAL_QWEN3_TEXT_SLUG)).toBe("fal");
    expect(imageModelProvider(FAL_QWEN3_EDIT_SLUG)).toBe("fal");
    expect(imageModelProvider("alibaba/qwen-image-3")).toBe("replicate");
    expect(imageModelProvider("qwen/qwen-image-2512:version")).toBe("replicate");
  });
});
