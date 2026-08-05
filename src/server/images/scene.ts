import { eq } from "drizzle-orm";
import { db, imageReferences, images } from "../db";
import {
  executeImageProvider,
  generateChecked,
  isDemoMode,
  replicateEditModelId,
  replicateImageModelId,
  routeSceneProviders,
  toolModelId,
  veniceEditModelId,
  veniceMultiEditModelId,
  veniceSceneImageModelId,
  type ImageProviderFailure,
  type ImageProviderId,
  type ProviderRenderResult,
  type SceneRenderRequest,
} from "../ai";
import { log } from "@/server/log";
import { diag, DiagnosticCollector, teeSink, type Diagnostic, type DiagnosticSink } from "@/contracts/diagnostics";
import type { ChatSceneProvider } from "@/contracts/images/image-models";
import type { SceneVisualReference } from "@/contracts/images/scene-reference";
import type { SceneGenState, SceneReferenceMode } from "@/contracts/state/scene-gen";
import { imageMeta, runImagePipeline, type ImageEntityKind } from "./assets";
import { monogramSvg } from "./monogram";
import {
  buildSceneComposerPrompt,
  buildSceneRenderPrompt,
  heuristicFocalName,
  resolveScenePlan,
  sceneComposerSystem,
  sceneSpecSchema,
  type SceneComposerContext,
  type SceneRenderPlan,
  type SceneSpec,
} from "./prompts";

export type SceneComposeInput = SceneComposerContext & { sink?: DiagnosticSink };

/** Compose a validated render plan from the current scene context. */
export async function composeSceneSpec(input: SceneComposeInput): Promise<SceneRenderPlan> {
  const { sink, ...context } = input;
  const fallback = (): SceneSpec => heuristicSceneSpec(context);
  const { value } = await generateChecked({
    schema: sceneSpecSchema,
    system: sceneComposerSystem(context.embodiedViewer === true),
    prompt: buildSceneComposerPrompt(context),
    modelId: toolModelId(),
    code: "images.scene_composer",
    sink,
    fallback,
  });
  return resolveScenePlan(value ?? fallback(), context, sink);
}

function heuristicSceneSpec(context: SceneComposerContext): SceneSpec {
  const focalName = heuristicFocalName(context.present, context.recentNarration ?? []);
  const focal = context.present.find((character) => character.name === focalName);
  return sceneSpecSchema.parse({
    focalCharacter: focalName,
    pose: focal ? focal.posture || "standing naturally, relaxed" : "",
    activity: focal?.activity ?? "",
    others: context.present
      .filter((character) => character.name !== focalName)
      .map((character) => ({
        name: character.name,
        action: [character.posture, character.activity].filter(Boolean).join("; "),
      })),
    setting: [context.locationName, context.locationDescription].filter(Boolean).join(" — ").slice(0, 300),
    lighting: heuristicLighting(context.timeOfDay),
  });
}

const TIME_OF_DAY_LIGHTING: Record<string, string> = {
  dawn: "pale dawn light",
  day: "soft natural daylight",
  dusk: "warm dusk light",
  night: "dim night-time lighting",
};

function heuristicLighting(timeOfDay: string | undefined): string {
  return (timeOfDay && TIME_OF_DAY_LIGHTING[timeOfDay]) || "soft natural light";
}

export interface SceneAssetLinkage {
  ownerId: string;
  entityKind?: ImageEntityKind;
  entityId?: string;
  chatId?: string;
  anchorMessageId?: string;
}

export interface RenderResolvedSceneInput {
  plan: SceneRenderPlan;
  references: SceneVisualReference[];
  referenceBuffers: Map<string, Buffer>;
  linkage: SceneAssetLinkage;
  mode?: SceneReferenceMode;
  /** Explicit stored provider choice; absent preserves the Venice default. */
  provider?: ChatSceneProvider;
  framing?: "pov" | "selfie";
  flavor?: string;
  logResult: (imageId: string, status: string, startedMs: number) => void;
  sink?: DiagnosticSink;
}

/**
 * Shared provider-chain core for scene renders. The selected provider family is
 * fixed for the whole attempt: Replicate failures do not silently fall into
 * Venice (or vice versa), and a referenced edit never degrades to an unrelated
 * text-to-image person.
 */
export async function renderResolvedScene(input: RenderResolvedSceneInput): Promise<string> {
  const demo = isDemoMode();
  const { plan, references, linkage } = input;
  const mode = input.mode ?? "single";
  const collected = new DiagnosticCollector();
  const sink: DiagnosticSink = input.sink ? teeSink(input.sink, collected) : collected;
  const request: SceneRenderRequest = {
    references,
    demo,
    mode,
    ...(input.provider ? { provider: input.provider } : {}),
  };
  const chain = routeSceneProviders(request);

  const imageRefs = references.filter((reference) => Boolean(reference.imageId));
  const orderedBuffers = imageRefs.flatMap((reference) => {
    const buffer = reference.imageId ? input.referenceBuffers.get(reference.imageId) : undefined;
    return buffer ? [buffer] : [];
  });
  const primaryBuffer = orderedBuffers[0] ?? null;
  const multiBuffers = orderedBuffers.slice(0, 3);

  const anchorRef = imageRefs[0];
  const allowIntimate = anchorRef?.allowForIntimate ?? false;
  const multiAllowIntimate = imageRefs
    .filter((reference) => reference.kind === "character")
    .every((reference) => reference.allowForIntimate);

  const framing = input.framing;
  const textPrompt = buildSceneRenderPrompt(plan, { framing });
  const editPrompt = anchorRef
    ? buildSceneRenderPrompt(plan, { referenceName: anchorRef.name, allowIntimate, framing })
    : textPrompt;
  const multiPrompt =
    multiBuffers.length >= 2
      ? buildSceneRenderPrompt(plan, {
          allowIntimate: multiAllowIntimate,
          multiReferences: imageRefs.slice(0, 3).map((reference) => ({
            name: reference.name ?? "",
            kind: reference.kind,
          })),
          framing,
        })
      : editPrompt;

  const promptFor = (id: ImageProviderId): string =>
    isMultiEditProvider(id) ? multiPrompt : isSingleEditProvider(id) ? editPrompt : textPrompt;
  const modelFor = (id: ImageProviderId): string => {
    switch (id) {
      case "demo":
        return "demo";
      case "venice_multi_edit":
        return `venice/${veniceMultiEditModelId()}`;
      case "venice_edit":
        return `venice/${veniceEditModelId()}`;
      case "venice_generate":
        return `venice/${veniceSceneImageModelId()}`;
      case "replicate_edit":
      case "replicate_multi_edit":
        return `replicate/${replicateEditModelId()}`;
      case "replicate_generate":
        return `replicate/${replicateImageModelId()}`;
    }
  };

  const primary = chain[0] ?? "venice_generate";
  const ctx: SceneAttemptContext = {
    promptFor,
    primaryBuffer,
    multiBuffers,
    focalName: plan.focal?.name ?? "Scene",
  };

  try {
    const { imageId } = await runImagePipeline({
      asset: {
        ownerId: linkage.ownerId,
        kind: "scene",
        entityKind: linkage.entityKind,
        entityId: linkage.entityId,
        chatId: linkage.chatId,
        anchorMessageId: linkage.anchorMessageId,
        prompt: promptFor(primary),
        sourceImageId: anchorRef?.imageId,
        meta: {
          demo,
          focalName: plan.focal?.name ?? null,
          referenceName: anchorRef?.name ?? null,
          model: modelFor(primary),
          ...(input.flavor ? { flavor: input.flavor } : {}),
        },
      },
      afterReserve: (asset) => recordImageReferences(asset.id, references, sink),
      produce: async (asset) => {
        const outcome = await executeSceneChain(chain, (id) => runSceneProvider(id, ctx), sink);
        if (!outcome) return { ok: false, error: sceneFailureMessage(collected.items) };
        if (outcome.providerId !== primary) {
          await correctProviderMeta(asset.id, promptFor(outcome.providerId), modelFor(outcome.providerId));
        }
        return { ok: true, image: outcome.image };
      },
      onSettled: ({ imageId, status, startedMs }) => input.logResult(imageId, status, startedMs),
      onThrown: ({ imageId, startedMs }) => input.logResult(imageId, "failed", startedMs),
      sink,
    });
    return imageId;
  } finally {
    drainSceneDiagnostics(collected.items, plan.focal?.name ?? null);
  }
}

function isSingleEditProvider(id: ImageProviderId): boolean {
  return id === "venice_edit" || id === "replicate_edit";
}

function isMultiEditProvider(id: ImageProviderId): boolean {
  return id === "venice_multi_edit" || id === "replicate_multi_edit";
}

interface SceneAttemptContext {
  promptFor: (id: ImageProviderId) => string;
  primaryBuffer: Buffer | null;
  multiBuffers: Buffer[];
  focalName: string;
}

export interface SceneRenderOutcome {
  providerId: ImageProviderId;
  image: Buffer;
}

const MAX_TRANSIENT_RETRIES = 1;

/** Walk the ordered provider chain with one same-provider transient retry. */
export async function executeSceneChain(
  chain: ImageProviderId[],
  run: (id: ImageProviderId) => Promise<ProviderRenderResult>,
  sink?: DiagnosticSink,
): Promise<SceneRenderOutcome | null> {
  let sawTransient = false;
  let sawNonTransient = false;
  let lastFailure: ImageProviderFailure | undefined;
  for (let i = 0; i < chain.length; i++) {
    const id = chain[i];
    if (!id) continue;
    let failure: ImageProviderFailure | undefined;
    for (let attempt = 0; attempt <= MAX_TRANSIENT_RETRIES; attempt++) {
      const result = await run(id);
      if (result.ok && result.image) return { providerId: id, image: result.image };
      failure = result.failure ?? { reason: "other", message: "provider returned no image" };
      if (failure.reason === "transient" && attempt < MAX_TRANSIENT_RETRIES) {
        sink?.push(
          diag("info", "images.scene_render.retry", `${id} transient failure — retrying: ${failure.message.slice(0, 160)}`),
        );
        continue;
      }
      break;
    }
    if (!failure) continue;
    lastFailure = failure;
    if (failure.reason === "transient") sawTransient = true;
    else sawNonTransient = true;
    const next = chain[i + 1];
    if (next) {
      sink?.push(
        diag("info", "images.scene_render.provider_fallback", `scene render falling back ${id} → ${next} after ${failure.reason}`, {
          context: { from: id, to: next, reason: failure.reason, message: failure.message.slice(0, 200) },
        }),
      );
    }
  }
  if (lastFailure) {
    const outage = sawTransient && !sawNonTransient;
    sink?.push(
      diag(
        "warn",
        outage ? "images.scene_render.service_outage" : "images.scene_render.all_failed",
        outage
          ? "every scene image provider failed transiently — possible image service outage"
          : `every scene image provider failed: ${lastFailure.message.slice(0, 200)}`,
        { context: { reason: lastFailure.reason, providers: chain } },
      ),
    );
  }
  return null;
}

async function runSceneProvider(id: ImageProviderId, ctx: SceneAttemptContext): Promise<ProviderRenderResult> {
  if (id === "demo") return { ok: true, image: monogramSvg(ctx.focalName || "Scene") };
  return executeImageProvider(id, {
    prompt: ctx.promptFor(id),
    reference: isSingleEditProvider(id) ? (ctx.primaryBuffer ?? undefined) : undefined,
    references: isMultiEditProvider(id) ? ctx.multiBuffers : undefined,
  });
}

async function recordImageReferences(
  sceneImageId: string,
  references: readonly SceneVisualReference[],
  sink?: DiagnosticSink,
): Promise<void> {
  if (references.length === 0) return;
  try {
    await db()
      .insert(imageReferences)
      .values(
        references.map((reference) => ({
          sceneImageId,
          kind: reference.kind,
          entityId: reference.entityId ?? null,
          role: reference.role ?? null,
          source: reference.source ?? null,
          imageId: reference.imageId ?? null,
          name: reference.name ?? "",
        })),
      );
  } catch (err) {
    sink?.push(
      diag("error", "images.scene_render.references_write_failed", err instanceof Error ? err.message : String(err)),
    );
  }
}

async function correctProviderMeta(assetId: string, prompt: string, model: string): Promise<void> {
  const [row] = await db().select({ meta: images.meta }).from(images).where(eq(images.id, assetId)).limit(1);
  await db()
    .update(images)
    .set({ prompt, meta: { ...imageMeta(row?.meta), model } })
    .where(eq(images.id, assetId));
}

function sceneFailureMessage(items: readonly Diagnostic[]): string {
  const terminal = [...items]
    .reverse()
    .find((diagnostic) =>
      diagnostic.code === "images.scene_render.all_failed" || diagnostic.code === "images.scene_render.service_outage",
    );
  return terminal?.message ?? "all scene image providers failed";
}

function drainSceneDiagnostics(items: readonly Diagnostic[], focalName: string | null): void {
  for (const diagnostic of items) {
    const data = {
      code: diagnostic.code,
      ...(focalName ? { focal: focalName } : {}),
      ...(diagnostic.context ? { context: diagnostic.context } : {}),
    };
    if (diagnostic.severity === "error") log.error("images.scene_render", diagnostic.message, data);
    else if (diagnostic.severity === "warn") log.warn("images.scene_render", diagnostic.message, data);
    else log.info("images.scene_render", diagnostic.message, data);
  }
}

export function shouldGenerateScene(scene: SceneGenState, turnNumber: number, directorWorthIt: boolean): boolean {
  if (scene.interval <= 0) return false;
  if (scene.status === "generating") return false;
  if (directorWorthIt) return true;
  return turnNumber - (scene.lastGeneratedTurn ?? 0) >= scene.interval;
}
