import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type ImageLoraRenderBinding, redactImageLoraLocator } from "@vesper/image-core";
import { civitaiApiToken, loraLocatorNeedsCivitaiToken, withLoraDownloadCredential } from "./lora-credentials";

/**
 * The credential seam: the library stores a public address, the environment
 * holds the key, and the two meet only on the way into a provider payload.
 *
 * What these cases protect is a property, not a helper: nothing Vesper stores or
 * reports may contain the token. So they assert both halves — the completion
 * happens where it must, and the stored locator, the binding it came from, and
 * the redaction every diagnostic uses are all untouched by it.
 */

const TOKEN = "civitai-test-token-value";

/** The seeded row's shape as a resolved binding — a public Civitai download URL. */
const binding = (locator = "https://civitai.com/api/download/models/3160956?type=Model&format=SafeTensor"): ImageLoraRenderBinding => ({
  id: "imglorqwennsfwallinclv20",
  label: "Qwen Image Edit 2511 NSFW all inclusive v2.0",
  locator,
  scale: 1,
  promptPrefix: null,
  promptSuffix: null,
  triggerWords: [],
});

let saved: string | undefined;

beforeEach(() => {
  saved = process.env.CIVITAI_API_TOKEN;
  delete process.env.CIVITAI_API_TOKEN;
});

afterEach(() => {
  if (saved === undefined) delete process.env.CIVITAI_API_TOKEN;
  else process.env.CIVITAI_API_TOKEN = saved;
});

describe("civitaiApiToken", () => {
  it("answers null when the deployment configures none", () => {
    expect(civitaiApiToken()).toBeNull();
  });

  it("reads the environment on every call, so a deployment set after import is seen", () => {
    process.env.CIVITAI_API_TOKEN = TOKEN;
    expect(civitaiApiToken()).toBe(TOKEN);
  });

  it("treats a blank value as unset — an empty secret would build a token= with nothing after it", () => {
    process.env.CIVITAI_API_TOKEN = "   ";
    expect(civitaiApiToken()).toBeNull();
  });
});

describe("loraLocatorNeedsCivitaiToken", () => {
  it("is true for a Civitai download that carries no credential of its own", () => {
    expect(loraLocatorNeedsCivitaiToken(binding().locator)).toBe(true);
  });

  it("is false for a Hugging Face repo slug, which needs nothing from us", () => {
    expect(loraLocatorNeedsCivitaiToken("owner/some-lora")).toBe(false);
  });

  it("is false for any other host", () => {
    expect(loraLocatorNeedsCivitaiToken("https://huggingface.co/owner/repo/resolve/main/x.safetensors")).toBe(false);
  });

  it("is false for a locator that already carries a token — somebody's complete address", () => {
    expect(loraLocatorNeedsCivitaiToken("https://civitai.com/api/download/models/1?token=already")).toBe(false);
  });

  it("does not mistake a lookalike host for Civitai", () => {
    // A suffix match would accept this; hostname equality plus a dotted
    // subdomain does not.
    expect(loraLocatorNeedsCivitaiToken("https://evilcivitai.com/api/download/models/1")).toBe(false);
    expect(loraLocatorNeedsCivitaiToken("https://cdn.civitai.com/api/download/models/1")).toBe(true);
  });
});

describe("withLoraDownloadCredential", () => {
  it("appends the token as a query parameter, leaving the stored parameters intact", () => {
    process.env.CIVITAI_API_TOKEN = TOKEN;
    const stored = binding();
    const sent = withLoraDownloadCredential(stored);
    const url = new URL(sent.locator);
    expect(url.searchParams.get("token")).toBe(TOKEN);
    expect(url.searchParams.get("type")).toBe("Model");
    expect(url.searchParams.get("format")).toBe("SafeTensor");
    expect(url.origin + url.pathname).toBe("https://civitai.com/api/download/models/3160956");
    // The binding it came from is not mutated — the stored locator stays clean
    // for the row, the image row's meta, and every diagnostic.
    expect(stored.locator).not.toContain(TOKEN);
    expect(sent.id).toBe(stored.id);
    expect(sent.scale).toBe(stored.scale);
  });

  it("hands the binding back UNCHANGED (same object) when nothing needs adding", () => {
    process.env.CIVITAI_API_TOKEN = TOKEN;
    const slug = binding("owner/some-lora");
    expect(withLoraDownloadCredential(slug)).toBe(slug);
    const elsewhere = binding("https://huggingface.co/owner/repo/resolve/main/x.safetensors");
    expect(withLoraDownloadCredential(elsewhere)).toBe(elsewhere);
  });

  it("hands it back unchanged when the deployment has no token — degrading, never throwing", () => {
    const stored = binding();
    expect(withLoraDownloadCredential(stored)).toBe(stored);
  });

  it("never lets the token survive redaction — what a diagnostic prints", () => {
    process.env.CIVITAI_API_TOKEN = TOKEN;
    const sent = withLoraDownloadCredential(binding());
    expect(sent.locator).toContain(TOKEN);
    expect(redactImageLoraLocator(sent.locator)).toBe("https://civitai.com/api/download/models/3160956");
    expect(redactImageLoraLocator(sent.locator)).not.toContain(TOKEN);
  });
});
