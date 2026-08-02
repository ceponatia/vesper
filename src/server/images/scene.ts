import { eq } from "drizzle-orm";
import { db, imageReferences, images } from "../db";
import {
  describeProviderError,
  executeImageProvider,
  generateChecked,
  isDemoMode,
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
import type { SceneVisualReference } from "@/contracts/images/scene-reference";
import type { SceneGenState, SceneReferenceMode } from "@/contracts/state/scene-gen";
import { createImageAsset, failImage, imageMeta, saveImageBuffer, type ImageEntityKind } from "./assets";
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

/**
 * Scene composer (docs/images.md step 1): the tool model picks the focal
 * character (and any others in frame) from the present-NPC roster + recent
 * narration, then resolveScenePlan clamps every name to that roster and
 * forces every outfit from occlusion-filtered wardrobe state — prose lies,
 * and absent characters never appear. An empty roster composes a
 * location-only shot, which is a legitimate output, not an error.
 */
export async function composeSceneSpec(input: SceneComposeInput): Promise<SceneRenderPlan> {
  const { sink, ...context } = input;
  const fallback = (): SceneSpec => heuristicSceneSpec(context);
  const { value } = await generateChecked({
    schema: sceneSpecSchema,
    // The embodied rules are the chat lane's opt-in; the session lane never sets it and
    // gets the byte-identical disembodied prompt (scene-pov-embodiment.plan.md §Lane scope).
    system: sceneComposerSystem(context.embodiedViewer === true),
    prompt: buildSceneComposerPrompt(context),
    modelId: toolModelId(),
    code: "images.scene_composer",
    sink,
    fallback,
  });
  return resolveScenePlan(value ?? fallback(), context, sink);
}

/** Deterministic spec (demo mode / degraded fallback): heuristic focal, everyone else present in frame. */
function heuristicSceneSpec(context: SceneComposerContext): SceneSpec {
  const focalName = heuristicFocalName(context.present, context.recentNarration ?? []);
  const focal = context.present.find((c) => c.name === focalName);
  return sceneSpecSchema.parse({
    focalCharacter: focalName,
    pose: focal ? focal.posture || "standing naturally, relaxed" : "",
    activity: focal?.activity ?? "",
    others: context.present
      .filter((c) => c.name !== focalName)
      .map((c) => ({ name: c.name, action: [c.posture, c.activity].filter(Boolean).join("; ") })),
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

/** Where a rendered scene image is filed: a library-entity (character-chat) scene. */
export interface SceneAssetLinkage {
  ownerId: string;
  /** Library-entity scenes (character chat) set these. */
  entityKind?: ImageEntityKind;
  entityId?: string;
  /** Chat scenes also carry their conversation + anchor message (slice 9 inline moments). */
  chatId?: string;
  anchorMessageId?: string;
}

export interface RenderResolvedSceneInput {
  plan: SceneRenderPlan;
  /** Every reference the scene features; those carrying an `imageId` are identity anchors. */
  references: SceneVisualReference[];
  /** Reference asset bytes keyed by `imageId` (for the edit providers); empty ⇒ text-to-image. */
  referenceBuffers: Map<string, Buffer>;
  linkage: SceneAssetLinkage;
  /** Reference mode (the session toggle); `multi` prepends the Venice multi-edit rung. */
  mode?: SceneReferenceMode;
  /**
   * Shot framing (chat-selfies.plan.md): "selfie" swaps the player-POV rule for
   * the subject's-own-camera framing block on every route. Absent ⇒ player POV.
   */
  framing?: "pov" | "selfie";
  /** Asset flavor stamped on `meta.flavor` (e.g. "selfie") — distinguishes render treatments downstream. */
  flavor?: string;
  /** Where to log the outcome (a character event). */
  logResult: (imageId: string, status: string, startedMs: number) => void;
  sink?: DiagnosticSink;
}

/**
 * The provider-chain core shared by every scene render (docs/images.md step 2),
 * decoupled from where the references came from and where the asset is filed
 * (`linkage`). The character-chat path (`renderCharacterSceneImage`,
 * images/character-scene.ts) resolves its own references/anchor, then hands off here.
 *
 * The provider router picks an ordered fallback chain run with the reason-keyed
 * retry policy (spec §8.3): transient → retry once, content rejection → next rung
 * — Venice multi-edit (mode `multi`) → single-reference edit; text-to-image runs
 * ONLY when no reference image exists (owner ruling 2026-07-29 — a failed edit
 * fails visibly, never a different-looking t2i person). Every reference is
 * persisted to `image_references`. Failures mark the row failed and return its
 * id — callers are never blocked by image work.
 */
export async function renderResolvedScene(input: RenderResolvedSceneInput): Promise<string> {
  const demo = isDemoMode();
  const { plan, references, linkage } = input;
  const mode = input.mode ?? "single";
  // Scene-render diagnostics — above all the provider fallback that records WHY
  // an identity-locked edit dropped to text-to-image (Venice rejecting an
  // explicit prompt, a transient outage) — were black-holed: no caller threads a
  // sink, so a scene image silently losing its reference likeness left no trace.
  // Tee every diagnostic into a collector and drain it to the server log below.
  const collected = new DiagnosticCollector();
  const sink: DiagnosticSink = input.sink ? teeSink(input.sink, collected) : collected;
  // Fail-visible by construction: with any reference image present the router
  // returns edit rungs only, so a failed edit fails the image (a "failed" tile +
  // the ever-present Generate button = retry) rather than silently painting a
  // different-looking text-to-image person.
  const request: SceneRenderRequest = { references, demo, mode };
  const chain = routeSceneProviders(request);

  // The image-bearing references, in send order (focal char, other chars,
  // location). The first is the single-edit anchor; the first ≤3 (with their
  // buffers) are the multi-edit reference set.
  const imageRefs = references.filter((r) => Boolean(r.imageId));
  const orderedBuffers = imageRefs.flatMap((r) => {
    const buffer = r.imageId ? input.referenceBuffers.get(r.imageId) : undefined;
    return buffer ? [buffer] : [];
  });
  const primaryBuffer = orderedBuffers[0] ?? null;
  const multiBuffers = orderedBuffers.slice(0, 3);

  // The uncensored edit paths get identity-lock + (exposure-gated) intimate
  // anatomy; the text-to-image fallback gets neither. `allowForIntimate` defaults
  // permissive today; the deferred uploaded-avatar guard (spec §3) flips it for
  // uploaded provenance, and every reference-edit prompt below respects it.
  const anchorRef = imageRefs[0];
  const allowIntimate = anchorRef?.allowForIntimate ?? false;
  // Multi-edit identity-locks several people at once, so ALL of its featured
  // character refs must clear the intimate gate, not just the primary.
  const multiAllowIntimate = imageRefs.filter((r) => r.kind === "character").every((r) => r.allowForIntimate);

  const framing = input.framing;
  const textPrompt = buildSceneRenderPrompt(plan, { framing });
  const editPrompt = anchorRef
    ? buildSceneRenderPrompt(plan, { referenceName: anchorRef.name, allowIntimate, framing })
    : textPrompt;
  const multiPrompt =
    multiBuffers.length >= 2
      ? buildSceneRenderPrompt(plan, {
          allowIntimate: multiAllowIntimate,
          multiReferences: imageRefs.slice(0, 3).map((r) => ({ name: r.name ?? "", kind: r.kind })),
          framing,
        })
      : editPrompt;
  const promptFor = (id: ImageProviderId): string =>
    id === "venice_multi_edit" ? multiPrompt : id === "venice_edit" ? editPrompt : textPrompt;
  const modelFor = (id: ImageProviderId): string =>
    id === "demo"
      ? "demo"
      : id === "venice_multi_edit"
        ? `venice/${veniceMultiEditModelId()}`
        : id === "venice_edit"
          ? `venice/${veniceEditModelId()}`
          : `venice/${veniceSceneImageModelId()}`;

  const primary = chain[0] ?? "venice_generate";
  const asset = await createImageAsset({
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
  });
  await recordImageReferences(asset.id, references, sink);

  const ctx: SceneAttemptContext = {
    promptFor,
    primaryBuffer,
    multiBuffers,
    focalName: plan.focal?.name ?? "Scene",
  };
  const started = Date.now();
  try {
    const outcome = await executeSceneChain(chain, (id) => runSceneProvider(id, ctx), sink);
    if (!outcome) {
      // Surface the real upstream cause on the row so the failed tile explains
      // why (e.g. a Venice edit content-rejection), not a generic placeholder.
      await failImage(asset.id, sceneFailureMessage(collected.items));
      input.logResult(asset.id, "failed", started);
      return asset.id;
    }
    // A fallback rung won — correct the recorded prompt + model to what ran.
    if (outcome.providerId !== primary) {
      await correctProviderMeta(asset.id, promptFor(outcome.providerId), modelFor(outcome.providerId));
    }
    const saved = await saveImageBuffer(asset.id, outcome.image, sink);
    input.logResult(asset.id, saved?.status ?? "failed", started);
  } catch (err) {
    const message = describeProviderError(err);
    await failImage(asset.id, message);
    input.logResult(asset.id, "failed", started);
  } finally {
    drainSceneDiagnostics(collected.items, plan.focal?.name ?? null);
  }
  return asset.id;
}

interface SceneAttemptContext {
  promptFor: (id: ImageProviderId) => string;
  /** Single-edit identity anchor (the first image-bearing reference). */
  primaryBuffer: Buffer | null;
  /** Ordered ≤3 reference buffers for the multi-edit rung. */
  multiBuffers: Buffer[];
  focalName: string;
}

export interface SceneRenderOutcome {
  providerId: ImageProviderId;
  image: Buffer;
}

/** One transient retry on the same provider before falling to the next rung. */
const MAX_TRANSIENT_RETRIES = 1;

/**
 * Walk the provider fallback chain with the reason-keyed retry policy (spec
 * §8.3): a transient failure retries once on the same provider; a content
 * rejection (or anything else) drops straight to the next rung with an info
 * diagnostic. When every rung failed transiently, warn of a possible outage.
 * The provider runner is injected so the policy is unit-testable in isolation.
 */
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
  // Terminal diagnostic so a wholly-failed chain is never silent — in particular
  // a single-rung identity-locked edit (character chat) that content-rejects has
  // no fallback hop to log, yet is exactly the failure the user needs to see.
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

/** Dispatch one rung: the demo monogram lives in this (images) layer; AI-backed providers run through the gateway. */
async function runSceneProvider(id: ImageProviderId, ctx: SceneAttemptContext): Promise<ProviderRenderResult> {
  if (id === "demo") return { ok: true, image: monogramSvg(ctx.focalName || "Scene") };
  return executeImageProvider(id, {
    prompt: ctx.promptFor(id),
    reference: id === "venice_edit" ? (ctx.primaryBuffer ?? undefined) : undefined,
    references: id === "venice_multi_edit" ? ctx.multiBuffers : undefined,
  });
}

/** Persist the scene's references to the join table (spec §4). Never throws — a write failure degrades to a diagnostic. */
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
        references.map((r) => ({
          sceneImageId,
          kind: r.kind,
          entityId: r.entityId ?? null,
          role: r.role ?? null,
          source: r.source ?? null,
          imageId: r.imageId ?? null,
          name: r.name ?? "",
        })),
      );
  } catch (err) {
    sink?.push(
      diag("error", "images.scene_render.references_write_failed", err instanceof Error ? err.message : String(err)),
    );
  }
}

/** Correct the recorded prompt + model when a fallback rung (not the primary) produced the image. */
async function correctProviderMeta(assetId: string, prompt: string, model: string): Promise<void> {
  const [row] = await db().select({ meta: images.meta }).from(images).where(eq(images.id, assetId)).limit(1);
  await db()
    .update(images)
    .set({ prompt, meta: { ...imageMeta(row?.meta), model } })
    .where(eq(images.id, assetId));
}

/** The user-facing reason a whole render chain failed, drawn from the terminal diagnostic the chain pushed. */
function sceneFailureMessage(items: readonly Diagnostic[]): string {
  const terminal = [...items]
    .reverse()
    .find((d) => d.code === "images.scene_render.all_failed" || d.code === "images.scene_render.service_outage");
  return terminal?.message ?? "all scene image providers failed";
}

/**
 * Surface scene-render diagnostics to the server log. Otherwise silent: the
 * load-bearing one is `images.scene_render.provider_fallback`, which records WHY
 * an identity-locked edit dropped to text-to-image (e.g. the Venice edit
 * endpoint rejecting an explicit prompt, or a transient outage) — the cause of a
 * scene image that no longer resembles its reference avatar. The success path
 * pushes nothing, so this stays quiet unless a fallback or failure occurred.
 */
function drainSceneDiagnostics(items: readonly Diagnostic[], focalName: string | null): void {
  for (const d of items) {
    const data = { code: d.code, ...(focalName ? { focal: focalName } : {}), ...(d.context ? { context: d.context } : {}) };
    if (d.severity === "error") log.error("images.scene_render", d.message, data);
    else if (d.severity === "warn") log.warn("images.scene_render", d.message, data);
    else log.info("images.scene_render", d.message, data);
  }
}

/**
 * Pure trigger helper (docs/images.md §Scene images): periodic every
 * `interval` turns, or on the director's imageMoment flag. `interval` 0
 * disables automatic generation entirely (manual requests bypass this);
 * an in-flight generation is never stacked.
 */
export function shouldGenerateScene(scene: SceneGenState, turnNumber: number, directorWorthIt: boolean): boolean {
  if (scene.interval <= 0) return false;
  if (scene.status === "generating") return false;
  if (directorWorthIt) return true;
  return turnNumber - (scene.lastGeneratedTurn ?? 0) >= scene.interval;
}
