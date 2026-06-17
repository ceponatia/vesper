import { generateImage } from "ai";
import type { SceneVisualReference } from "@/contracts";
import { describeImageGenError } from "./errors";
import { imageModel } from "./provider";
import { veniceEditImage } from "./venice";

/**
 * Provider-capability seam for scene rendering (scene-images.spec.md §4). The
 * capability table is a typed code registry — not a DB table — because every
 * provider is tied to an SDK call in this directory (the `@openrouter`-only
 * boundary), so the data belongs next to the code and can't drift from it.
 *
 * Today the ladder is: reference-edit (Venice/Qwen, uncensored, single ref) →
 * text-to-image (Flux on OpenRouter, moderated) → (demo monogram, handled in
 * the images layer). Multi-reference / reference-sheet providers are reserved
 * for the §5/§6 spikes: adding one is a new `IMAGE_PROVIDERS` entry + one router
 * clause + a render branch, never a `scene.ts` rewrite.
 */
export const imageProviderIds = ["demo", "venice_edit", "flux_openrouter"] as const;
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
  flux_openrouter: {
    maxReferenceImages: 0,
    supportsReferenceRoles: false,
    supportsLocationReference: false,
    supportsMask: false,
    supportsAdultFictionalNudity: false,
    supportsUploadedRealPeopleInNsfw: false,
    maxPromptChars: 4000,
    aspectRatios: ["3:4"],
    policyMode: "moderated",
  },
} as const satisfies Record<ImageProviderId, ImageProviderCaps>;

// --- Routing -------------------------------------------------------------

/**
 * A caller's explicit image-model family pick (the character-chat picker, mirroring
 * the portrait studio's Flux/Qwen choice). `qwen` ⇒ the uncensored Venice/Qwen
 * reference-edit path (the default ladder); `flux` ⇒ the moderated OpenRouter
 * text-to-image path only. Unset ⇒ the default ladder.
 */
export type SceneImageModel = "flux" | "qwen";

/** Computable from data the pipeline already produces (spec §4). */
export interface SceneRenderRequest {
  /** Every reference the scene featured; those with an `imageId` can anchor an edit. */
  references: SceneVisualReference[];
  /** Demo mode (no keys) — only the monogram provider runs. */
  demo: boolean;
  /** Optional explicit model-family pick (character-chat picker); unset ⇒ default ladder. */
  prefer?: SceneImageModel;
}

/**
 * The ordered provider fallback chain for a scene (spec §8.3). Pure — selected
 * from the request against the capability registry. Reference-edit providers
 * need ≥1 reference image; text-to-image providers always attempt (they ignore
 * references). Future multi-reference rungs slot in ahead of `venice_edit` here.
 *
 * An explicit `prefer: "flux"` forces the moderated text-to-image path only —
 * the uncensored edit rung is skipped (the user opted out of it). `prefer:
 * "qwen"` (and the unset default) keep the full uncensored-first ladder.
 */
export function routeSceneProviders(request: SceneRenderRequest): ImageProviderId[] {
  if (request.demo) return ["demo"];
  if (request.prefer === "flux") return ["flux_openrouter"];
  const referenceImages = request.references.filter((r) => Boolean(r.imageId)).length;
  const ordered: ImageProviderId[] = ["venice_edit", "flux_openrouter"];
  const chain = ordered.filter((id) => providerCanAttempt(id, referenceImages));
  // Flux text-to-image is always a valid last rung even with no reference.
  return chain.length > 0 ? chain : ["flux_openrouter"];
}

function providerCanAttempt(id: ImageProviderId, referenceImages: number): boolean {
  const caps = IMAGE_PROVIDERS[id];
  if (caps.maxReferenceImages === 0) return true; // text-to-image ignores references
  return referenceImages >= 1; // reference-edit needs at least one anchor image
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

const CONTENT_REJECTION = /moderation|sexual content|nsfw|safe[_ ]?mode|content policy|flagged|disallowed|prohibited/;
const TRANSIENT =
  /timeout|timed out|abort|econn|etimedout|enotfound|socket hang up|network|fetch failed|rate limit|too many requests|\b(429|500|502|503|504)\b|temporarily/;

/**
 * Map a failure to a retry class (spec §8.3): a content rejection must NOT retry
 * (it only fails again — fall down the ladder); a transient error may retry.
 * Reuses `describeImageGenError` to recover the real upstream message hidden
 * behind OpenRouter's generic "Invalid JSON response".
 */
export function classifyImageFailure(err: unknown): ImageFailureReason {
  const message = describeImageGenError(err).toLowerCase();
  if (CONTENT_REJECTION.test(message)) return "content_rejection";
  if (TRANSIENT.test(message)) return "transient";
  return "other";
}

export interface ImageRenderInput {
  prompt: string;
  /** Required for reference-edit providers; ignored by text-to-image. */
  reference?: Buffer;
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
    case "flux_openrouter":
      return renderFluxText(input);
  }
}

async function renderVeniceEdit(input: ImageRenderInput): Promise<ProviderRenderResult> {
  if (!input.reference) {
    return { ok: false, failure: { reason: "other", message: "venice_edit requires a reference image" } };
  }
  const edit = await veniceEditImage({ prompt: input.prompt, reference: input.reference });
  if (edit.ok && edit.image) return { ok: true, image: edit.image };
  const message = edit.error ?? "venice edit returned no image";
  return { ok: false, failure: { reason: classifyImageFailure(message), message } };
}

async function renderFluxText(input: ImageRenderInput): Promise<ProviderRenderResult> {
  try {
    const result = await generateImage({ model: imageModel(), prompt: input.prompt, aspectRatio: "3:4" });
    return { ok: true, image: Buffer.from(result.image.uint8Array) };
  } catch (err) {
    return { ok: false, failure: { reason: classifyImageFailure(err), message: describeImageGenError(err) } };
  }
}
