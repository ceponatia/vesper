import type { SceneReferenceMode, SceneVisualReference } from "@/contracts";
import { describeProviderError } from "./errors";
import { veniceEditImage, veniceGenerateImage, veniceMultiEditImage, veniceSceneImageModelId } from "./venice";

/**
 * Provider-capability seam for scene rendering (scene-images.spec.md §4). The
 * capability table is a typed code registry — not a DB table — because every
 * provider is tied to an SDK call in this directory (the `@openrouter`-only
 * boundary), so the data belongs next to the code and can't drift from it.
 *
 * After the 2026-06-19 Flux removal the stack is **Venice/Qwen end-to-end**
 * (OpenRouter left the image stack). The ladder is, by reference mode:
 * - `single` (default): single-reference edit (`venice_edit`) only.
 * - `multi`: multi-reference edit (`venice_multi_edit`, Venice `/image/multi-edit`,
 *   ≤3 uncensored refs) → `venice_edit`.
 * Text-to-image (`venice_generate`) runs ONLY when no reference image exists at
 * all (owner ruling 2026-07-29): it cannot honor a reference, so a failed edit
 * must fail visibly rather than silently painting a different-looking person —
 * what used to be the opt-in `requireReferenceIdentity` flag is now the only
 * behavior. Reference-capable providers are the intended additions here (e.g.
 * self-hosted ComfyUI for >3 refs, spec §7): a new `IMAGE_PROVIDERS` entry + one
 * router clause + a render branch, never a `scene.ts` rewrite.
 */
export const imageProviderIds = ["demo", "venice_edit", "venice_multi_edit", "venice_generate"] as const;
export type ImageProviderId = (typeof imageProviderIds)[number];
/** The AI-backed providers (everything but the images-layer demo monogram). */
export type AiImageProviderId = Exclude<ImageProviderId, "demo">;

export type ImagePolicyMode = "uncensored" | "moderated" | "none";

export interface ImageProviderCaps {
  /** 0 ⇒ text-to-image (ignores references). */
  maxReferenceImages: number;
  supportsReferenceRoles: boolean;
  supportsLocationReference: boolean;
  supportsMask: boolean;
  supportsAdultFictionalNudity: boolean;
  /** Never true — uploaded real-person likenesses are off the NSFW path by policy (§3). */
  supportsUploadedRealPeopleInNsfw: false;
  maxPromptChars: number;
  aspectRatios: readonly string[];
  policyMode: ImagePolicyMode;
}

export const IMAGE_PROVIDERS = {
  demo: {
    maxReferenceImages: 0,
    supportsReferenceRoles: false,
    supportsLocationReference: false,
    supportsMask: false,
    supportsAdultFictionalNudity: false,
    supportsUploadedRealPeopleInNsfw: false,
    maxPromptChars: 0,
    aspectRatios: ["3:4"],
    policyMode: "none",
  },
  venice_edit: {
    maxReferenceImages: 1,
    supportsReferenceRoles: false,
    supportsLocationReference: false,
    supportsMask: false,
    supportsAdultFictionalNudity: true,
    supportsUploadedRealPeopleInNsfw: false,
    maxPromptChars: 1500,
    aspectRatios: ["3:4"],
    policyMode: "uncensored",
  },
  venice_multi_edit: {
    maxReferenceImages: 3,
    supportsReferenceRoles: true,
    supportsLocationReference: true,
    supportsMask: false,
    supportsAdultFictionalNudity: true,
    supportsUploadedRealPeopleInNsfw: false,
    maxPromptChars: 1500,
    aspectRatios: ["3:4"],
    policyMode: "uncensored",
  },
  venice_generate: {
    maxReferenceImages: 0,
    supportsReferenceRoles: false,
    supportsLocationReference: false,
    supportsMask: false,
    supportsAdultFictionalNudity: true,
    supportsUploadedRealPeopleInNsfw: false,
    maxPromptChars: 4000,
    aspectRatios: ["3:4"],
    policyMode: "uncensored",
  },
} as const satisfies Record<ImageProviderId, ImageProviderCaps>;

// --- Routing -------------------------------------------------------------

/** Computable from data the pipeline already produces (spec §4). */
export interface SceneRenderRequest {
  /** Every reference the scene featured; those with an `imageId` can anchor an edit. */
  references: SceneVisualReference[];
  /** Demo mode (no keys) — only the monogram provider runs. */
  demo: boolean;
  /**
   * Reference mode (the session toggle, scene-images.plan.md): `multi` puts the
   * Venice `/image/multi-edit` rung ahead of single-edit; `single`/unset keeps
   * the single-anchor chain.
   */
  mode?: SceneReferenceMode;
}

/**
 * The ordered provider fallback chain for a scene (spec §8.3). Pure — selected
 * from the request against the capability registry.
 *
 * With ≥1 reference image the chain is **edit rungs only** (owner ruling
 * 2026-07-29, formerly the opt-in `requireReferenceIdentity` flag): text-to-image
 * cannot honor a reference, so a failed edit fails the image visibly (a "failed"
 * tile + retry) instead of silently painting a *different-looking* person.
 * Text-to-image is the sole rung only when NO reference image exists.
 *
 * `mode: "multi"` prepends `venice_multi_edit` — but only when ≥2 reference
 * images exist (with one image it would just be a single edit). With fewer, the
 * chain degrades to the single-edit rung, so the toggle never blocks a render.
 */
export function routeSceneProviders(request: SceneRenderRequest): ImageProviderId[] {
  if (request.demo) return ["demo"];
  const referenceImages = request.references.filter((r) => Boolean(r.imageId)).length;
  const ordered: ImageProviderId[] = request.mode === "multi" ? ["venice_multi_edit", "venice_edit"] : ["venice_edit"];
  const chain = ordered.filter((id) => providerCanAttempt(id, referenceImages));
  // No usable reference anchor ⇒ text-to-image is the only path (and the chain
  // is never empty).
  return chain.length > 0 ? chain : ["venice_generate"];
}

function providerCanAttempt(id: ImageProviderId, referenceImages: number): boolean {
  const caps = IMAGE_PROVIDERS[id];
  if (caps.maxReferenceImages === 0) return true; // text-to-image ignores references
  if (caps.maxReferenceImages >= 2) return referenceImages >= 2; // multi-ref needs ≥2 anchors
  return referenceImages >= 1; // single-reference edit needs one anchor image
}

// --- Failure classification + execution ----------------------------------

export type ImageFailureReason = "transient" | "content_rejection" | "other";

export interface ImageProviderFailure {
  reason: ImageFailureReason;
  message: string;
}

export interface ProviderRenderResult {
  ok: boolean;
  image?: Buffer;
  failure?: ImageProviderFailure;
}

const CONTENT_REJECTION = /moderation|sexual content|nsfw|safe[_ ]?mode|content policy|flagged|disallowed|prohibited|violation/;
const TRANSIENT =
  /timeout|timed out|abort|econn|etimedout|enotfound|socket hang up|network|fetch failed|rate limit|too many requests|\b(429|500|502|503|504)\b|temporarily/;

/**
 * Map a failure to a retry class (spec §8.3): a content rejection must NOT retry
 * (it only fails again — fall down the ladder); a transient error may retry.
 * Reuses `describeProviderError` to recover any real upstream message.
 */
export function classifyImageFailure(err: unknown): ImageFailureReason {
  const message = describeProviderError(err).toLowerCase();
  if (CONTENT_REJECTION.test(message)) return "content_rejection";
  if (TRANSIENT.test(message)) return "transient";
  return "other";
}

export interface ImageRenderInput {
  prompt: string;
  /** Single-reference edit (`venice_edit`): the lone identity anchor. */
  reference?: Buffer;
  /** Multi-reference edit (`venice_multi_edit`): 1–3 ordered references (first = base). */
  references?: Buffer[];
}

/**
 * Run one AI-backed provider. Never throws — classifies any failure so the
 * executor can decide retry-vs-fallback. The demo monogram is rendered in the
 * images layer (it has no SDK call and would create an import cycle here).
 */
export async function executeImageProvider(id: AiImageProviderId, input: ImageRenderInput): Promise<ProviderRenderResult> {
  switch (id) {
    case "venice_edit":
      return renderVeniceEdit(input);
    case "venice_multi_edit":
      return renderVeniceMultiEdit(input);
    case "venice_generate":
      return renderVeniceGenerate(input);
  }
}

async function renderVeniceEdit(input: ImageRenderInput): Promise<ProviderRenderResult> {
  if (!input.reference) {
    return { ok: false, failure: { reason: "other", message: "venice_edit requires a reference image" } };
  }
  const edit = await veniceEditImage({ prompt: input.prompt, reference: input.reference });
  return fromVenice(edit, "venice edit returned no image");
}

async function renderVeniceMultiEdit(input: ImageRenderInput): Promise<ProviderRenderResult> {
  const references = input.references ?? [];
  if (references.length < 2) {
    return { ok: false, failure: { reason: "other", message: "venice_multi_edit requires at least two reference images" } };
  }
  const edit = await veniceMultiEditImage({ prompt: input.prompt, references });
  return fromVenice(edit, "venice multi-edit returned no image");
}

async function renderVeniceGenerate(input: ImageRenderInput): Promise<ProviderRenderResult> {
  // The scene t2i default (Chroma) — resolved through the shared key registry so this
  // call and scene.ts's meta.model label can never disagree. This rung only runs
  // when no reference image exists (the chat strip's t2i style-swap pick is gone).
  const generated = await veniceGenerateImage({ prompt: input.prompt, aspectRatio: "3:4", model: veniceSceneImageModelId() });
  return fromVenice(generated, "venice generate returned no image");
}

/** Shape a Venice never-throws result into a classified provider result. */
function fromVenice(result: { ok: boolean; image?: Buffer; error?: string }, noImageMessage: string): ProviderRenderResult {
  if (result.ok && result.image) return { ok: true, image: result.image };
  const message = result.error ?? noImageMessage;
  return { ok: false, failure: { reason: classifyImageFailure(message), message } };
}
