import { DEFAULT_AVATAR_IMAGE_MODEL, type AvatarImageModel } from "@/contracts";

const VENICE_BASE = "https://api.venice.ai/api/v1";

/**
 * Default Venice image models, overridable per-deploy via env. After the
 * 2026-06-19 Flux removal Venice/Qwen is the default for every image lane
 * (scene-images.plan.md). Qwen-Image-2 is the uncensored text-to-image model
 * (portrait + entity generate); its edit sibling (`qwen-image-2-edit`) backs
 * portrait variants AND single-reference scene images;
 * `qwen-edit-uncensored` backs the multi-reference `/image/multi-edit` path.
 * Centralized here so the API call and the `images.meta.model` label can never
 * drift — the label sites import these helpers rather than re-deriving the default.
 */
export const VENICE_DEFAULT_IMAGE_MODEL = "qwen-image-2";
export const VENICE_DEFAULT_EDIT_MODEL = "qwen-image-2-edit";
export const VENICE_DEFAULT_MULTI_EDIT_MODEL = "qwen-edit-uncensored";

/** Resolved text-to-image model id (`VENICE_IMAGE_MODEL` env → default). */
export function veniceImageModelId(): string {
  return process.env.VENICE_IMAGE_MODEL || VENICE_DEFAULT_IMAGE_MODEL;
}

/** Resolved image-edit model id (`VENICE_IMAGE_EDIT_MODEL` env → default). */
export function veniceEditModelId(): string {
  return process.env.VENICE_IMAGE_EDIT_MODEL || VENICE_DEFAULT_EDIT_MODEL;
}

/** Resolved multi-reference edit model id (`VENICE_MULTI_EDIT_MODEL` env → default). */
export function veniceMultiEditModelId(): string {
  return process.env.VENICE_MULTI_EDIT_MODEL || VENICE_DEFAULT_MULTI_EDIT_MODEL;
}

/**
 * Map a portrait-studio model key (the pure `avatarImageModels` vocabulary) to a
 * concrete Venice text-to-image model id (scene-images.spec.md §5). `qwen` honors
 * the `VENICE_IMAGE_MODEL` env override; the rest are fixed ids re-verifiable at
 * the live `GET /models?type=image` catalog. A wrong/retired id degrades to a
 * failed image row (never a crash), so onboarding a model is a one-line edit here.
 */
const VENICE_T2I_MODEL_IDS: Record<Exclude<AvatarImageModel, "qwen">, string> = {
  lustify: "lustify-v8",
  chroma: "chroma",
  illustrious: "wai-Illustrious",
  turbo: "z-image-turbo",
};

export function veniceT2IModelId(model: AvatarImageModel): string {
  return model === "qwen" ? veniceImageModelId() : VENICE_T2I_MODEL_IDS[model];
}

/**
 * The scene render ladder's text-to-image model (the `venice_generate` rung — the
 * no-usable-anchor fallback): resolves the shared default pick (Chroma, owner ruling
 * 2026-07-10) through the same key registry as the portrait studio, so the two lanes'
 * defaults can never drift. Centralized here so the API call (`renderVeniceGenerate`)
 * and the `images.meta.model` label (`scene.ts`) agree by construction.
 */
export function veniceSceneImageModelId(): string {
  return veniceT2IModelId(DEFAULT_AVATAR_IMAGE_MODEL);
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
  /** Explicit Venice model id; defaults to `veniceImageModelId()` (Qwen-Image-2). */
  model?: string;
}

export interface VeniceGenerateResult {
  ok: boolean;
  image?: Buffer;
  error?: string;
}

/**
 * Text-to-image generation (docs/images.md): Venice's uncensored image models
 * (`qwen-image-2` by default — "uncensored" is `safe_mode` off, the codebase
 * default; `model` overridable per call via the portrait-studio model picker,
 * `veniceT2IModelId`). This is the only text-to-image backend now (Flux/OpenRouter
 * was removed); it also backs avatar + entity images and the scene t2i fallback.
 * Never throws — failures degrade to an error string the caller turns into a
 * failed image row, exactly like veniceEditImage.
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
        model: request.model ?? veniceImageModelId(),
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

export interface VeniceMultiEditRequest {
  /** Composition instruction (POV rule, identity lock, per-reference roles). */
  prompt: string;
  /** 1–3 reference images. The FIRST is the base canvas; the rest are edit
   * layers/refs (Venice `/image/multi-edit`, scene-images.spec.md §5). */
  references: Buffer[];
}

/**
 * Multi-reference image edit (Venice `POST /image/multi-edit`, spec §5): the
 * only hosted, uncensored, multi-reference path — `qwen-edit-uncensored` +
 * `safe_mode:false`, 1–3 reference images in one call. Identity-preservation
 * quality across multiple NSFW refs is unproven (validate before depending on
 * it). The `images` array caps at 3; extra refs are dropped by the caller. The
 * model param is **`modelId`** here (the `/image/multi-edit` schema; `model` is
 * the single-edit endpoint's field). Never throws — failures degrade to an error
 * string like `veniceEditImage`.
 */
export async function veniceMultiEditImage(request: VeniceMultiEditRequest): Promise<VeniceEditResult> {
  if (!hasVenice()) return { ok: false, error: "VENICE_API_KEY not configured" };
  const references = request.references.slice(0, 3);
  if (references.length === 0) return { ok: false, error: "multi-edit requires at least one reference image" };
  try {
    const response = await fetch(`${VENICE_BASE}/image/multi-edit`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.VENICE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        modelId: veniceMultiEditModelId(),
        prompt: request.prompt,
        images: references.map((ref) => ref.toString("base64")),
        output_format: "webp",
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
