import type { ImageModel } from "@vesper/image-core";

export const FAL_QWEN3_TEXT_SLUG = "alibaba/qwen-image-3/text-to-image";
export const FAL_QWEN3_EDIT_SLUG = "alibaba/qwen-image-3/edit";

/**
 * fal does not expose immutable weights/version ids for these managed endpoints.
 * These markers identify the endpoint schema Vesper captured and reviewed on
 * 2026-09-11; they are reproducibility/provenance markers, not provider weight
 * hashes.
 */
export const FAL_QWEN3_TEXT_SCHEMA_REVISION = "fal-qwen3-text-schema-2026-09-11";
export const FAL_QWEN3_EDIT_SCHEMA_REVISION = "fal-qwen3-edit-schema-2026-09-11";

const FAL_RUN_HOST = "https://fal.run";
const DEFAULT_TIMEOUT_MS = 300_000;

type Qwen3ResolutionTier = "1K" | "2K";

export interface FalPreparedReference {
  bytes: Buffer;
  mediaType: string;
}

export interface FalImageRequest {
  prompt: string;
  references?: readonly FalPreparedReference[];
  /** Aspect selected by Vesper's shared shape resolver, e.g. `3:4`. */
  aspect?: string | null;
  /** Provider-shaped values already validated by the profile/compiler. */
  controlInput?: Readonly<Record<string, unknown>>;
  timeoutMs?: number | null;
  /** Vesper's captured schema revision; fal itself has no immutable version pin. */
  versionId?: string | null;
}

export interface FalImageResult {
  ok: boolean;
  image?: Buffer;
  error?: string;
  predictionId?: string;
  executedVersionId?: string;
  sentReferenceCount?: number;
}

interface FalImageResponse {
  images?: Array<{ url?: string }>;
  seed?: number;
}

export function isFalQwen3Slug(slug: string): boolean {
  return slug === FAL_QWEN3_TEXT_SLUG || slug === FAL_QWEN3_EDIT_SLUG;
}

export function hasFal(): boolean {
  return Boolean(process.env.FAL_API_KEY?.trim());
}

/** Whether this deployment has at least one image transport configured. */
export function hasAnyImageProvider(): boolean {
  return hasFal() || Boolean(process.env.REPLICATE_API_TOKEN?.trim());
}

/**
 * Build the exact fal request body. Kept pure so the provider contract can be
 * regression-tested without spend.
 */
export function falQwen3Payload(model: ImageModel, request: FalImageRequest): Record<string, unknown> {
  const references = [...(request.references ?? [])];
  if (model.slug === FAL_QWEN3_TEXT_SLUG && references.length > 0) {
    throw new Error(`${FAL_QWEN3_TEXT_SLUG} does not accept reference images`);
  }
  if (model.slug === FAL_QWEN3_EDIT_SLUG && (references.length < 1 || references.length > 3)) {
    throw new Error(`${FAL_QWEN3_EDIT_SLUG} requires 1 to 3 reference images`);
  }
  if (!isFalQwen3Slug(model.slug)) throw new Error(`unsupported fal image model: ${model.slug}`);

  const controls = { ...(request.controlInput ?? {}) };
  const tier = resolutionTier(controls["image_size"]);
  // `image_size` is a normalized Vesper 1K/2K tier in controlInput, not a raw
  // fal value. Consume it here, then write fal's actual {width,height} object.
  delete controls["image_size"];

  const input: Record<string, unknown> = {
    // Vesper owns the prompt and safety posture. These defaults are deliberately
    // explicit instead of relying on fal's current defaults (both are true).
    enable_safety_checker: false,
    enable_prompt_expansion: false,
    num_images: 1,
    output_format: "png",
    ...model.extraInput,
    ...controls,
    prompt: request.prompt,
    image_size: qwen3ImageSize(request.aspect, tier),
  };

  if (model.slug === FAL_QWEN3_EDIT_SLUG) {
    input.image_urls = references.map((reference) =>
      `data:${reference.mediaType};base64,${reference.bytes.toString("base64")}`,
    );
  }
  return input;
}

/**
 * Run one of Vesper's two fal Qwen Image 3 endpoint rows through fal's synchronous
 * inference API. The rest of Vesper still receives the same small result shape
 * it gets from Replicate, so provider choice remains below the render-intent seam.
 */
export async function runFalQwen3ImageModel(
  model: ImageModel,
  request: FalImageRequest,
): Promise<FalImageResult> {
  const key = process.env.FAL_API_KEY?.trim();
  if (!key) return { ok: false, error: "FAL_API_KEY not configured" };

  let body: Record<string, unknown>;
  try {
    body = falQwen3Payload(model, request);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }

  const timeoutMs = Math.max(30_000, Math.min(request.timeoutMs ?? DEFAULT_TIMEOUT_MS, 900_000));
  let response: Response;
  try {
    response = await fetch(`${FAL_RUN_HOST}/${model.slug}`, {
      method: "POST",
      headers: {
        Authorization: `Key ${key}`,
        "Content-Type": "application/json",
        // Vesper downloads and owns the resulting asset; do not retain the
        // prompt/input JSON in fal request history.
        "X-Fal-Store-IO": "0",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }

  const requestId = response.headers.get("x-fal-request-id")?.trim() || undefined;
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    return {
      ok: false,
      ...(requestId ? { predictionId: requestId } : {}),
      error: detail.trim() || `fal returned HTTP ${String(response.status)}`,
    };
  }

  let decoded: FalImageResponse;
  try {
    decoded = (await response.json()) as FalImageResponse;
  } catch (error) {
    return {
      ok: false,
      ...(requestId ? { predictionId: requestId } : {}),
      error: `fal returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const outputUrl = decoded.images?.[0]?.url;
  if (!outputUrl) {
    return {
      ok: false,
      ...(requestId ? { predictionId: requestId } : {}),
      error: "fal returned no image URL",
    };
  }

  try {
    const image = await downloadFalImage(outputUrl, timeoutMs);
    return {
      ok: true,
      image,
      ...(requestId ? { predictionId: requestId } : {}),
      ...(request.versionId ? { executedVersionId: request.versionId } : {}),
      sentReferenceCount: request.references?.length ?? 0,
    };
  } catch (error) {
    return {
      ok: false,
      ...(requestId ? { predictionId: requestId } : {}),
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function resolutionTier(value: unknown): Qwen3ResolutionTier {
  return value === "2K" ? "2K" : "1K";
}

/**
 * Convert Vesper's independent aspect + 1K/2K tier into fal's custom ImageSize.
 * No aspect is the bench's native-shape case; choosing a resolution necessarily
 * names a shape, so its neutral default is square.
 */
export function qwen3ImageSize(
  aspect: string | null | undefined,
  tier: Qwen3ResolutionTier,
): { width: number; height: number } {
  const longEdge = tier === "2K" ? 2048 : 1024;
  const ratio = parseAspectRatio(aspect ?? "1:1") ?? 1;
  if (ratio >= 1) {
    return { width: longEdge, height: Math.max(512, Math.round(longEdge / ratio)) };
  }
  return { width: Math.max(512, Math.round(longEdge * ratio)), height: longEdge };
}

function parseAspectRatio(value: string): number | null {
  const match = /^(\d+):(\d+)$/.exec(value.trim());
  if (!match) return null;
  const width = Number(match[1]);
  const height = Number(match[2]);
  return width > 0 && height > 0 ? width / height : null;
}

async function downloadFalImage(url: string, timeoutMs: number): Promise<Buffer> {
  if (url.startsWith("data:")) {
    const comma = url.indexOf(",");
    if (comma < 0) throw new Error("fal returned a malformed data URL");
    const header = url.slice(0, comma);
    const payload = url.slice(comma + 1);
    return Buffer.from(payload, header.endsWith(";base64") ? "base64" : "utf8");
  }
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`could not download fal image (HTTP ${String(response.status)})`);
  return Buffer.from(await response.arrayBuffer());
}
