const VENICE_BASE = "https://api.venice.ai/api/v1";

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
        model: process.env.VENICE_IMAGE_EDIT_MODEL || "qwen-edit-uncensored",
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
   * models (qwen-image) reject width/height — they take aspect_ratio only. */
  aspectRatio?: string;
}

export interface VeniceGenerateResult {
  ok: boolean;
  image?: Buffer;
  error?: string;
}

/**
 * Text-to-image generation (docs/images.md): Venice's uncensored image models
 * (`qwen-image` by default — "uncensored" is `safe_mode` off, the codebase
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
        model: process.env.VENICE_IMAGE_MODEL || "qwen-image",
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
