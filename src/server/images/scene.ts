import { eq } from "drizzle-orm";
import { db, imageReferences, images } from "../db";
import {
  classifyImageFailure,
  generateChecked,
  isDemoMode,
  toolModelId,
} from "../ai";
import { renderImageIntent, type ImageRenderReference } from "./render-intent";
import { log } from "@/server/log";
import { diag, DiagnosticCollector, teeSink, type Diagnostic, type DiagnosticSink } from "@/contracts/diagnostics";
import {
  attemptReferenceCount,
  IMAGE_TARGET_ASPECT,
  type ImageProviderFailure,
  type ImageReferenceRole,
  type ProviderRenderResult,
  type ResolvedImageProfile,
  routeSceneAttempts,
  type SceneAttemptId,
  type SceneRenderRequest,
  type SceneVisualReference,
  type SceneVisualReferenceKind,
} from "@vesper/image-core";
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
  /** The resolved scene profile and its model; null when none is offered. */
  profile?: ResolvedImageProfile | null;
  framing?: "pov" | "selfie";
  flavor?: string;
  logResult: (imageId: string, status: string, startedMs: number) => void;
  sink?: DiagnosticSink;
}

/**
 * Shared attempt-chain core for scene renders. ONE model runs the whole chain —
 * the chain is its degradation ladder (multi-reference → single-reference →
 * bare prompt), not a hop between vendors. A referenced edit never degrades to
 * an unrelated text-to-image person, and a failure on the chosen model stays
 * visible rather than being papered over by a different one.
 */
export async function renderResolvedScene(input: RenderResolvedSceneInput): Promise<string> {
  const demo = isDemoMode();
  const { plan, references, linkage } = input;
  const mode = input.mode ?? "single";
  const collected = new DiagnosticCollector();
  const sink: DiagnosticSink = input.sink ? teeSink(input.sink, collected) : collected;
  const profile = input.profile ?? null;
  const model = profile?.model ?? null;
  const request: SceneRenderRequest = { references, demo, mode, model };
  const chain = routeSceneAttempts(request);

  // Ordered reference SPECS, not bare buffers: the chain's rungs send different
  // subsets, and a subset of anonymous buffers cannot say whether the one it
  // kept is the character or the room. The role travels with the bytes from here
  // on, which is what lets the render intent report a dropped location instead
  // of "reference 2".
  const imageRefs = references.filter((reference) => Boolean(reference.imageId));
  const orderedReferences = imageRefs.flatMap((reference): ImageRenderReference[] => {
    const buffer = reference.imageId ? input.referenceBuffers.get(reference.imageId) : undefined;
    if (!buffer) return [];
    return [
      {
        role: sceneReferenceRole(reference.kind),
        buffer,
        ...(reference.imageId ? { sourceImageId: reference.imageId } : {}),
        ...(reference.name ? { name: reference.name } : {}),
      },
    ];
  });
  const primaryReference = orderedReferences[0] ?? null;
  const multiReferences = orderedReferences.slice(0, 3);

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
    multiReferences.length >= 2
      ? buildSceneRenderPrompt(plan, {
          allowIntimate: multiAllowIntimate,
          multiReferences: imageRefs.slice(0, 3).map((reference) => ({
            name: reference.name ?? "",
            kind: reference.kind,
          })),
          framing,
        })
      : editPrompt;

  const promptFor = (id: SceneAttemptId): string =>
    id === "multi_edit" ? multiPrompt : id === "edit" ? editPrompt : textPrompt;
  /** Stored on the image row for provider/model auditability. */
  const modelFor = (id: SceneAttemptId): string => (id === "demo" || !model ? "demo" : `replicate/${model.slug}`);

  // An empty chain means the resolved model cannot serve this render at all
  // (edit-only, no usable reference). Reserve nothing and fail the row with a
  // message naming the model, rather than silently rendering something else.
  const primary = chain[0];
  if (!primary) {
    sink.push(
      diag("error", "images.scene_render.no_attempt", "the selected image model cannot render this scene", {
        context: { model: model?.slug ?? null, references: references.length },
      }),
    );
  }

  const ctx: SceneAttemptContext = {
    promptFor,
    primaryReference,
    multiReferences,
    focalName: plan.focal?.name ?? "Scene",
    profile,
    sink,
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
        prompt: primary ? promptFor(primary) : textPrompt,
        sourceImageId: anchorRef?.imageId,
        meta: {
          demo,
          focalName: plan.focal?.name ?? null,
          referenceName: anchorRef?.name ?? null,
          model: primary ? modelFor(primary) : "none",
          ...(input.flavor ? { flavor: input.flavor } : {}),
        },
      },
      afterReserve: (asset) => recordImageReferences(asset.id, references, sink),
      produce: async (asset) => {
        const outcome = await executeSceneChain(chain, (id) => runSceneProvider(id, ctx), sink);
        if (!outcome) return { ok: false, error: sceneFailureMessage(collected.items) };
        if (outcome.attemptId !== primary) {
          await correctProviderMeta(asset.id, promptFor(outcome.attemptId), modelFor(outcome.attemptId));
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

interface SceneAttemptContext {
  promptFor: (id: SceneAttemptId) => string;
  primaryReference: ImageRenderReference | null;
  multiReferences: ImageRenderReference[];
  focalName: string;
  profile: ResolvedImageProfile | null;
  sink?: DiagnosticSink;
}

/**
 * The render-intent role one scene reference plays.
 *
 * The scene vocabulary predates the profile layer's and is narrower in one place
 * and wider in another, so the mapping is written out rather than assumed:
 * `character` is the identity anchor the edit must preserve, and `layout` has no
 * counterpart of its own — it is a spatial control image, which is what the
 * `control` role reserves. Only `character` and `location` are produced today.
 */
function sceneReferenceRole(kind: SceneVisualReferenceKind): ImageReferenceRole {
  switch (kind) {
    case "character":
      return "identity";
    case "location":
      return "location";
    case "style":
      return "style";
    case "pose":
      return "pose";
    case "layout":
      return "control";
  }
}

export interface SceneRenderOutcome {
  attemptId: SceneAttemptId;
  image: Buffer;
}

const MAX_TRANSIENT_RETRIES = 1;

/** Walk the ordered attempt chain with one same-attempt transient retry. */
export async function executeSceneChain(
  chain: SceneAttemptId[],
  run: (id: SceneAttemptId) => Promise<ProviderRenderResult>,
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
      if (result.ok && result.image) return { attemptId: id, image: result.image };
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

/**
 * Run one rung of the chain. The reference count comes from the model's own
 * capacity (`attemptReferenceCount`) rather than a fixed slice, so a
 * single-reference model on a `multi_edit` rung sends one image instead of
 * handing the provider three and having two silently dropped.
 */
async function runSceneProvider(id: SceneAttemptId, ctx: SceneAttemptContext): Promise<ProviderRenderResult> {
  if (id === "demo") return { ok: true, image: monogramSvg(ctx.focalName || "Scene") };
  if (!ctx.profile) return { ok: false, failure: { reason: "other", message: "no image model is registered" } };

  const wanted = attemptReferenceCount(id, ctx.profile.model);
  const references =
    id === "multi_edit"
      ? ctx.multiReferences.slice(0, wanted)
      : id === "edit" && ctx.primaryReference
        ? [ctx.primaryReference]
        : [];

  const result = await renderImageIntent(
    {
      profile: ctx.profile,
      prompt: ctx.promptFor(id),
      references,
      target: { aspectRatio: IMAGE_TARGET_ASPECT },
    },
    ctx.sink,
  );
  if (result.ok && result.image) return { ok: true, image: result.image };
  const message = result.error ?? `${ctx.profile.model.slug} returned no image`;
  return { ok: false, failure: { reason: classifyImageFailure(message), message } };
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
