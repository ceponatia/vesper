const VENICE_BASE = "https://api.venice.ai/api/v1";

/**
 * Default Venice image models, overridable per-deploy via env. Qwen-Image-2 is
 * the uncensored text-to-image model (portrait regenerate); its edit sibling
 * (`qwen-image-2-edit`) backs portrait variants AND scene images. Centralized
 * here so the API call and the `images.meta.model` label can never drift — the
 * label sites import these helpers rather than re-deriving the default.
 */
export const VENICE_DEFAULT_IMAGE_MODEL = "qwen-image-2";
export const VENICE_DEFAULT_EDIT_MODEL = "qwen-image-2-edit";

/** Resolved text-to-image model id (`VENICE_IMAGE_MODEL` env → default). */
export function veniceImageModelId(): string {
  return process.env.VENICE_IMAGE_MODEL || VENICE_DEFAULT_IMAGE_MODEL;
}

/** Resolved image-edit model id (`VENICE_IMAGE_EDIT_MODEL` env → default). */
export function veniceEditModelId(): string {
  return process.env.VENICE_IMAGE_EDIT_MODEL || VENICE_DEFAULT_EDIT_MODEL;
}

export function hasVenice(): boolean {
  return Boolean(process.env.VENICE_API_KEY);
}

export interface VeniceEditRequest {
  /** Edit instruction; callers prepend the identity-lock block for portraits. */
  prompt: string;
  /** Reference image bytes (png/webp/jpeg). */
  reference: Buffer;
}

export interface VeniceEditResult {
  ok: boolean;
  image?: Buffer;
  error?: string;
}

/** Single-reference image edit (docs/images.md). Never throws. */
export async function veniceEditImage(request: VeniceEditRequest): Promise<VeniceEditResult> {
  if (!hasVenice()) return { ok: false, error: "VENICE_API_KEY not configured" };
  try {
    const response = await fetch(`${VENICE_BASE}/image/edit`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.VENICE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: veniceEditModelId(),
        prompt: request.prompt,
        image: request.reference.toString("base64"),
        safe_mode: process.env.VENICE_SAFE_MODE === "true",
      }),
      signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      return { ok: false, error: `venice ${response.status}: ${body.slice(0, 300)}` };
    }
    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      const data = (await response.json()) as { images?: string[] };
      const b64 = data.images?.[0];
      if (!b64) return { ok: false, error: "venice returned no image" };
      return { ok: true, image: Buffer.from(stripDataUrl(b64), "base64") };
    }
    return { ok: true, image: Buffer.from(await response.arrayBuffer()) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export interface VeniceGenerateRequest {
  /** Text-to-image prompt. */
  prompt: string;
  /** Output aspect ratio; defaults to a 3:4 portrait. Venice's aspect-ratio
   * models (qwen-image-2) reject width/height — they take aspect_ratio only. */
  aspectRatio?: string;
}

export interface VeniceGenerateResult {
  ok: boolean;
  image?: Buffer;
  error?: string;
}

/**
 * Text-to-image generation (docs/images.md): Venice's uncensored image models
 * (`qwen-image-2` by default — "uncensored" is `safe_mode` off, the codebase
 * default). The Flux path goes through OpenRouter; this is the alternative the
 * portrait studio offers. Never throws — failures degrade to an error string
 * the caller turns into a failed image row, exactly like veniceEditImage.
 */
export async function veniceGenerateImage(request: VeniceGenerateRequest): Promise<VeniceGenerateResult> {
  if (!hasVenice()) return { ok: false, error: "VENICE_API_KEY not configured" };
  try {
    const response = await fetch(`${VENICE_BASE}/image/generate`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.VENICE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: veniceImageModelId(),
        prompt: request.prompt,
        aspect_ratio: request.aspectRatio ?? "3:4",
        format: "webp",
        safe_mode: process.env.VENICE_SAFE_MODE === "true",
      }),
      signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      return { ok: false, error: `venice ${response.status}: ${body.slice(0, 300)}` };
    }
    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      const data = (await response.json()) as { images?: string[] };
      const b64 = data.images?.[0];
      if (!b64) return { ok: false, error: "venice returned no image" };
      return { ok: true, image: Buffer.from(stripDataUrl(b64), "base64") };
    }
    return { ok: true, image: Buffer.from(await response.arrayBuffer()) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function stripDataUrl(value: string): string {
  const comma = value.indexOf(",");
  return value.startsWith("data:") && comma !== -1 ? value.slice(comma + 1) : value;
}
