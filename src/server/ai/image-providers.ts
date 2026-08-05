import type { ChatSceneProvider, SceneReferenceMode, SceneVisualReference } from "@/contracts";
import { describeProviderError } from "./errors";
import { replicateEditImage, replicateGenerateImage } from "./replicate";
import { veniceEditImage, veniceGenerateImage, veniceMultiEditImage, veniceSceneImageModelId } from "./venice";

/**
 * Provider-capability seam for scene rendering (scene-images.spec.md §4).
 * Provider/model names stay at this infrastructure boundary; domain callers ask
 * for a stored provider family plus reference mode and get an ordered chain.
 */
export const imageProviderIds = [
  "demo",
  "venice_edit",
  "venice_multi_edit",
  "venice_generate",
  "replicate_edit",
  "replicate_multi_edit",
  "replicate_generate",
] as const;
export type ImageProviderId = (typeof imageProviderIds)[number];
export type AiImageProviderId = Exclude<ImageProviderId, "demo">;

export type ImagePolicyMode = "uncensored" | "moderated" | "none";

export interface ImageProviderCaps {
  /** 0 ⇒ text-to-image (ignores references). */
  maxReferenceImages: number;
  supportsReferenceRoles: boolean;
  supportsLocationReference: boolean;
  supportsMask: boolean;
  supportsAdultFictionalNudity: boolean;
  /** Never true — uploaded real-person likenesses are off the NSFW path by policy. */
  supportsUploadedRealPeopleInNsfw: false;
  maxPromptChars: number;
  aspectRatios: readonly string[];
  policyMode: ImagePolicyMode;
}

const commonEditCaps = {
  supportsMask: false,
  supportsAdultFictionalNudity: true,
  supportsUploadedRealPeopleInNsfw: false,
  maxPromptChars: 1_500,
  aspectRatios: ["3:4"],
  policyMode: "uncensored",
} as const;

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
    ...commonEditCaps,
    maxReferenceImages: 1,
    supportsReferenceRoles: false,
    supportsLocationReference: false,
  },
  venice_multi_edit: {
    ...commonEditCaps,
    maxReferenceImages: 3,
    supportsReferenceRoles: true,
    supportsLocationReference: true,
  },
  venice_generate: {
    maxReferenceImages: 0,
    supportsReferenceRoles: false,
    supportsLocationReference: false,
    supportsMask: false,
    supportsAdultFictionalNudity: true,
    supportsUploadedRealPeopleInNsfw: false,
    maxPromptChars: 4_000,
    aspectRatios: ["3:4"],
    policyMode: "uncensored",
  },
  replicate_edit: {
    ...commonEditCaps,
    maxReferenceImages: 1,
    supportsReferenceRoles: false,
    supportsLocationReference: false,
  },
  replicate_multi_edit: {
    ...commonEditCaps,
    maxReferenceImages: 3,
    supportsReferenceRoles: true,
    supportsLocationReference: true,
  },
  replicate_generate: {
    maxReferenceImages: 0,
    supportsReferenceRoles: false,
    supportsLocationReference: false,
    supportsMask: false,
    supportsAdultFictionalNudity: true,
    supportsUploadedRealPeopleInNsfw: false,
    maxPromptChars: 4_000,
    aspectRatios: ["3:4"],
    policyMode: "uncensored",
  },
} as const satisfies Record<ImageProviderId, ImageProviderCaps>;

// --- Routing -------------------------------------------------------------

export interface SceneRenderRequest {
  references: SceneVisualReference[];
  demo: boolean;
  mode?: SceneReferenceMode;
  /** Stored chat/model choice; absent preserves the pre-Replicate Venice default. */
  provider?: ChatSceneProvider;
}

/**
 * With a usable identity reference, only edit rungs are returned. A selected
 * provider never silently falls across to the other provider or to unrelated
 * text-to-image output: failures remain visible and retryable.
 */
export function routeSceneProviders(request: SceneRenderRequest): ImageProviderId[] {
  if (request.demo) return ["demo"];
  const referenceImages = request.references.filter((reference) => Boolean(reference.imageId)).length;
  const provider = request.provider ?? "venice";
  const ordered: ImageProviderId[] =
    provider === "replicate"
      ? request.mode === "multi"
        ? ["replicate_multi_edit", "replicate_edit"]
        : ["replicate_edit"]
      : request.mode === "multi"
        ? ["venice_multi_edit", "venice_edit"]
        : ["venice_edit"];
  const chain = ordered.filter((id) => providerCanAttempt(id, referenceImages));
  if (chain.length > 0) return chain;
  return [provider === "replicate" ? "replicate_generate" : "venice_generate"];
}

function providerCanAttempt(id: ImageProviderId, referenceImages: number): boolean {
  const caps = IMAGE_PROVIDERS[id];
  if (caps.maxReferenceImages === 0) return true;
  if (caps.maxReferenceImages >= 2) return referenceImages >= 2;
  return referenceImages >= 1;
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

export function classifyImageFailure(err: unknown): ImageFailureReason {
  const message = describeProviderError(err).toLowerCase();
  if (CONTENT_REJECTION.test(message)) return "content_rejection";
  if (TRANSIENT.test(message)) return "transient";
  return "other";
}

export interface ImageRenderInput {
  prompt: string;
  reference?: Buffer;
  references?: Buffer[];
}

/** Run one AI-backed provider and classify its never-throws result. */
export async function executeImageProvider(id: AiImageProviderId, input: ImageRenderInput): Promise<ProviderRenderResult> {
  switch (id) {
    case "venice_edit":
      return renderVeniceEdit(input);
    case "venice_multi_edit":
      return renderVeniceMultiEdit(input);
    case "venice_generate":
      return renderVeniceGenerate(input);
    case "replicate_edit":
      return renderReplicateEdit(input, false);
    case "replicate_multi_edit":
      return renderReplicateEdit(input, true);
    case "replicate_generate":
      return renderReplicateGenerate(input);
  }
}

async function renderVeniceEdit(input: ImageRenderInput): Promise<ProviderRenderResult> {
  if (!input.reference) return missingReference("venice_edit", false);
  return fromProvider(
    await veniceEditImage({ prompt: input.prompt, reference: input.reference }),
    "venice edit returned no image",
  );
}

async function renderVeniceMultiEdit(input: ImageRenderInput): Promise<ProviderRenderResult> {
  const references = input.references ?? [];
  if (references.length < 2) return missingReference("venice_multi_edit", true);
  return fromProvider(await veniceMultiEditImage({ prompt: input.prompt, references }), "venice multi-edit returned no image");
}

async function renderVeniceGenerate(input: ImageRenderInput): Promise<ProviderRenderResult> {
  return fromProvider(
    await veniceGenerateImage({ prompt: input.prompt, aspectRatio: "3:4", model: veniceSceneImageModelId() }),
    "venice generate returned no image",
  );
}

async function renderReplicateEdit(input: ImageRenderInput, multi: boolean): Promise<ProviderRenderResult> {
  const references = multi ? (input.references ?? []) : input.reference ? [input.reference] : [];
  if (references.length < (multi ? 2 : 1)) return missingReference(multi ? "replicate_multi_edit" : "replicate_edit", multi);
  return fromProvider(
    await replicateEditImage({ prompt: input.prompt, references, aspectRatio: "3:4" }),
    "replicate edit returned no image",
  );
}

async function renderReplicateGenerate(input: ImageRenderInput): Promise<ProviderRenderResult> {
  return fromProvider(
    await replicateGenerateImage({ prompt: input.prompt, aspectRatio: "3:4" }),
    "replicate generate returned no image",
  );
}

function missingReference(id: ImageProviderId, multi: boolean): ProviderRenderResult {
  return {
    ok: false,
    failure: { reason: "other", message: `${id} requires at least ${multi ? "two reference images" : "one reference image"}` },
  };
}

function fromProvider(
  result: { ok: boolean; image?: Buffer; error?: string },
  noImageMessage: string,
): ProviderRenderResult {
  if (result.ok && result.image) return { ok: true, image: result.image };
  const message = result.error || noImageMessage;
  return { ok: false, failure: { reason: classifyImageFailure(message), message } };
}
