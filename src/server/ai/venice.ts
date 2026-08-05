import { DEFAULT_AVATAR_IMAGE_MODEL, type VeniceAvatarImageModel } from "@/contracts";

const VENICE_BASE = "https://api.venice.ai/api/v1";

/**
 * Default Venice image models, overridable per-deploy via env. Qwen-Image-2 is
 * the Venice text-to-image model; its edit sibling backs portrait variants and
 * both single- and multi-reference scene images.
 */
export const VENICE_DEFAULT_IMAGE_MODEL = "qwen-image-2";
export const VENICE_DEFAULT_EDIT_MODEL = "qwen-image-2-edit";
export const VENICE_DEFAULT_MULTI_EDIT_MODEL = "qwen-image-2-edit";

export function veniceImageModelId(): string {
  return process.env.VENICE_IMAGE_MODEL || VENICE_DEFAULT_IMAGE_MODEL;
}

export function veniceEditModelId(): string {
  return process.env.VENICE_IMAGE_EDIT_MODEL || VENICE_DEFAULT_EDIT_MODEL;
}

export function veniceMultiEditModelId(): string {
  return process.env.VENICE_MULTI_EDIT_MODEL || VENICE_DEFAULT_MULTI_EDIT_MODEL;
}

/** Map only Venice-backed portrait keys to concrete Venice model ids. */
const VENICE_T2I_MODEL_IDS: Record<Exclude<VeniceAvatarImageModel, "qwen">, string> = {
  lustify: "lustify-v8",
  chroma: "chroma",
  illustrious: "wai-Illustrious",
  turbo: "z-image-turbo",
};

export function veniceT2IModelId(model: VeniceAvatarImageModel): string {
  return model === "qwen" ? veniceImageModelId() : VENICE_T2I_MODEL_IDS[model];
}

/** The no-reference scene fallback remains the shared Venice default (Chroma). */
export function veniceSceneImageModelId(): string {
  return veniceT2IModelId(DEFAULT_AVATAR_IMAGE_MODEL);
}

export function hasVenice(): boolean {
  return Boolean(process.env.VENICE_API_KEY);
}

export interface VeniceEditRequest {
  prompt: string;
  reference: Buffer;
}

export interface VeniceImageResult {
  ok: boolean;
  image?: Buffer;
  error?: string;
}

export type VeniceEditResult = VeniceImageResult;
export type VeniceGenerateResult = VeniceImageResult;

export function unwrapVeniceImage(result: VeniceImageResult, fallback: string): Buffer {
  if (!result.ok || !result.image) throw new Error(result.error || fallback);
  return result.image;
}

/** Single-reference image edit. Never throws. */
export async function veniceEditImage(request: VeniceEditRequest): Promise<VeniceEditResult> {
  if (!hasVenice()) return { ok: false, error: "VENICE_API_KEY not configured" };
  return veniceImageCall("/image/edit", {
    model: veniceEditModelId(),
    prompt: request.prompt,
    image: request.reference.toString("base64"),
    safe_mode: process.env.VENICE_SAFE_MODE === "true",
  });
}

export interface VeniceGenerateRequest {
  prompt: string;
  aspectRatio?: string;
  model?: string;
}

/** Venice text-to-image generation. Never throws. */
export async function veniceGenerateImage(request: VeniceGenerateRequest): Promise<VeniceGenerateResult> {
  if (!hasVenice()) return { ok: false, error: "VENICE_API_KEY not configured" };
  return veniceImageCall("/image/generate", {
    model: request.model ?? veniceImageModelId(),
    prompt: request.prompt,
    aspect_ratio: request.aspectRatio ?? "3:4",
    format: "webp",
    safe_mode: process.env.VENICE_SAFE_MODE === "true",
  });
}

export interface VeniceMultiEditRequest {
  prompt: string;
  references: Buffer[];
}

/** Multi-reference Venice edit (one to three ordered references). Never throws. */
export async function veniceMultiEditImage(request: VeniceMultiEditRequest): Promise<VeniceEditResult> {
  if (!hasVenice()) return { ok: false, error: "VENICE_API_KEY not configured" };
  const references = request.references.slice(0, 3);
  if (references.length === 0) return { ok: false, error: "multi-edit requires at least one reference image" };
  return veniceImageCall("/image/multi-edit", {
    modelId: veniceMultiEditModelId(),
    prompt: request.prompt,
    images: references.map((ref) => ref.toString("base64")),
    output_format: "webp",
    resolution: "2K",
    aspect_ratio: "3:4",
    safe_mode: process.env.VENICE_SAFE_MODE === "true",
  });
}

/** Shared Venice transport and response decoder. */
async function veniceImageCall(path: string, payload: Record<string, unknown>): Promise<VeniceImageResult> {
  try {
    const response = await fetch(`${VENICE_BASE}${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.VENICE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
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
