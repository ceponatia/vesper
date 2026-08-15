import { eq } from "drizzle-orm";
import { db, imageReferences, images } from "../db";
import {
  classifyImageFailure,
  generateChecked,
  isDemoMode,
  narrativeModelId,
  sceneComposerModelId,
} from "../ai";
import { renderAttemptMeta, renderImageIntent } from "./render-intent";
import { logDiagnostics } from "@/server/log";
import { diag, DiagnosticCollector, teeSink, type Diagnostic, type DiagnosticSink } from "@/contracts/diagnostics";
import {
  attemptReferenceCount,
  type IdentityReferenceProvenance,
  type ImageLoraRenderBinding,
  IMAGE_TARGET_ASPECT,
  type ImageProviderFailure,
  type ImageReferenceRole,
  type ImageRenderReference,
  type ProviderRenderResult,
  referenceCapacity,
  type ResolvedImageAttempt,
  type ResolvedImageProfile,
  routeSceneAttempts,
  type SceneAttemptId,
  type SceneReferenceMode,
  type SceneRenderRequest,
  type SceneVisualReference,
  type SceneVisualReferenceKind,
} from "@vesper/image-core";
import type { SceneGenState } from "@/contracts/state/scene-gen";
import { imageMeta, runImagePipeline, type ImageEntityKind } from "./assets";
import { monogramSvg } from "./monogram";
import {
  buildSceneComposerPrompt,
  type SceneComposerContext,
  sceneComposerSystem,
  type SceneSpec,
  sceneSpecSchema,
} from "./prompts-scene-composer";
import { heuristicFocalName, resolveScenePlan, type SceneRenderPlan } from "./prompts-scene-plan";
import { buildSceneRenderPrompt } from "./prompts-scene-render";

export type SceneComposeInput = SceneComposerContext & { sink?: DiagnosticSink };

/**
 * Compose a validated render plan from the current scene context.
 *
 * TWO model calls at most, on two models (scene-composition.plan.md slice 2, owner ruling
 * 2026-08-10). The primary runs on the composer's own seam and is asked with **no fallback**
 * on purpose: `generateChecked` answers a missing fallback with the schema's own defaults,
 * which parse cleanly and would look exactly like a successful composition — the refusal
 * would be invisible and the second model would never be asked. Reading `degraded` is what
 * makes a refusal or a schema miss visible enough to retry.
 *
 * The retry is the chat's narrative model (the approved fallback: already trusted with this
 * repo's most explicit text), and it carries the heuristic fallback, so the terminal degrade
 * stays today's deterministic spec — never a failed render.
 */
export async function composeSceneSpec(input: SceneComposeInput): Promise<SceneRenderPlan> {
  const { sink, ...context } = input;
  const fallback = (): SceneSpec => heuristicSceneSpec(context);
  const request = {
    schema: sceneSpecSchema,
    system: sceneComposerSystem(context.embodiedViewer === true),
    prompt: buildSceneComposerPrompt(context),
    code: "images.scene_composer",
    sink,
  };
  const primary = await generateChecked({ ...request, modelId: sceneComposerModelId() });
  if (!primary.degraded && primary.value) return resolveScenePlan(primary.value, context, sink);
  // Demo mode degrades every model call by design, so a second one buys nothing but noise —
  // and the primary's own `.degraded` diagnostic has already said what happened.
  if (isDemoMode()) return resolveScenePlan(fallback(), context, sink);
  sink?.push(
    diag("info", "images.scene_composer.model_fallback", `scene composer degraded on ${sceneComposerModelId()} — retrying on ${narrativeModelId()}`, {
      context: { primary: sceneComposerModelId(), fallback: narrativeModelId() },
    }),
  );
  const retry = await generateChecked({ ...request, modelId: narrativeModelId(), fallback });
  return resolveScenePlan(retry.value ?? fallback(), context, sink);
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
  /**
   * A library LoRA the CALLER already resolved against `profile`'s model,
   * version and task (`resolveIntimateSceneLoraRoute` — the intimate-scene
   * route, and the only source of one today).
   *
   * Passed rather than resolved here for the reason the lab passes its own: the
   * decision to take the LoRA route is also the decision to swap the model, and
   * both have to be made before the row is reserved, because the row records the
   * model it will run on. Resolving again inside the render would read the
   * library twice and could disagree with the profile that was already chosen.
   *
   * Absent — every render but an intimate staged one — leaves the intent
   * byte-identical to what it was before this field existed.
   */
  resolvedLora?: ImageLoraRenderBinding;
  framing?: "pov" | "selfie";
  flavor?: string;
  /**
   * Identity-pack provenance for the anchors the caller PLANNED to send,
   * persisted on the row's `meta.identityReferences`
   * (image-identity-packs.spec.integration.md §"Render provenance"). Only the
   * flag-on caller supplies it. What persists is narrowed to the references the
   * render actually sent: a refused render (`failedPrecondition`) records none,
   * and a fallback rung or a capacity trim drops the entries whose bytes never
   * reached the provider.
   */
  identityProvenance?: IdentityReferenceProvenance[];
  /**
   * Non-null refuses the render before generation: the row is reserved and
   * failed with this text, no provider is called. The flag-on identity-pack
   * refusal settles here — a scene may not substitute another reference for a
   * blocked pack, and a silent no-reference render would be that substitution
   * with extra steps.
   */
  failedPrecondition?: string | null;
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
  // The model's own capacity, not a literal 3: a two-character cast plus a place
  // is three references on Qwen Edit 2511 and would have been silently trimmed to
  // the old constant on any model that takes more. Callers order people before
  // the place, so a short capacity drops the setting rather than a character.
  const multiCapacity = model ? referenceCapacity(model).max : 1;
  const multiReferences = orderedReferences.slice(0, multiCapacity);

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
          multiReferences: imageRefs.slice(0, multiCapacity).map((reference) => ({
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

  // The reference set one attempt sends — the same selection runSceneProvider
  // makes, restated here because provenance must describe the send, not the plan.
  const sentReferencesFor = (id: SceneAttemptId): ImageRenderReference[] => {
    if (id === "multi_edit") return multiReferences.slice(0, attemptReferenceCount(id, model));
    if (id === "edit" && primaryReference) return [primaryReference];
    return [];
  };
  // `meta.identityReferences` holds provenance ONLY for identity references that
  // reached the provider: nothing on a refused render (the row is failed before
  // any send), and only the surviving attempt's subset when the chain fell back
  // or capacity trimmed the reference list.
  const provenanceFor = (id: SceneAttemptId | undefined): IdentityReferenceProvenance[] => {
    const planned = input.identityProvenance ?? [];
    // `?? null` mirrors runImagePipeline's own precondition read, empty string included.
    if (planned.length === 0 || id === undefined || (input.failedPrecondition ?? null) !== null) return [];
    const sent = new Set(sentReferencesFor(id).map((reference) => reference.sourceImageId));
    return planned.filter((entry) => sent.has(entry.imageId));
  };
  const reservedProvenance = provenanceFor(primary);

  const ctx: SceneAttemptContext = {
    promptFor,
    primaryReference,
    multiReferences,
    focalName: plan.focal?.name ?? "Scene",
    profile,
    ...(input.resolvedLora ? { resolvedLora: input.resolvedLora } : {}),
    attempts: new Map(),
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
          // The RESOLVED shot, for the dev lightbox and probe grading
          // (scene-composition.spec.md §"Prompt emission"). Ids only — the phrasing
          // lives in the registries, and the prompt itself is already on the row.
          // Written once at reserve time: unlike the prompt and model, the camera is
          // the same on every rung, so a fallback needs no correction pass.
          camera: plan.camera,
          ...(plan.staging ? { staging: plan.staging.id } : {}),
          // The LoRA that drew it, by library id — the other half of the
          // provenance `meta.model` starts (the wrapper slug lands there through
          // `modelFor`). The id, never the locator: a locator is completed with a
          // credential on its way to the provider, and an image row is exactly
          // the kind of long-lived record that must never carry one.
          ...(input.resolvedLora ? { lora: input.resolvedLora.id } : {}),
          ...(input.flavor ? { flavor: input.flavor } : {}),
          ...(reservedProvenance.length > 0 ? { identityReferences: reservedProvenance } : {}),
        },
      },
      failedPrecondition: input.failedPrecondition ?? null,
      afterReserve: (asset) => recordImageReferences(asset.id, references, sink),
      produce: async (asset) => {
        const outcome = await executeSceneChain(chain, (id) => runSceneProvider(id, ctx), sink);
        if (!outcome) {
          // The whole chain exhausted. The failed row still records the LAST
          // rung's attempt — the failure its error text describes — so a failed
          // scene keeps its prediction id and provenance. Walked from the deep
          // end because later rungs overwrite nothing: each rung keys its own
          // attempt, and the deepest one recorded is the last that ran.
          const lastAttempt = [...chain]
            .reverse()
            .map((id) => ctx.attempts.get(id))
            .find((attempt) => attempt !== undefined);
          return { ok: false, error: sceneFailureMessage(collected.items), ...renderAttemptMeta(lastAttempt) };
        }
        if (outcome.attemptId !== primary) {
          await correctProviderMeta(
            asset.id,
            promptFor(outcome.attemptId),
            modelFor(outcome.attemptId),
            provenanceFor(outcome.attemptId),
          );
        }
        // The WINNING rung's provenance — the render the stored image came from,
        // never the primary attempt's plan. This merges in the save step, which
        // runs AFTER the fallback correction above rewrote the row, so the two
        // writes never fight: the correction describes the rung, and this is the
        // same rung's attempt record.
        return { ok: true, image: outcome.image, ...renderAttemptMeta(ctx.attempts.get(outcome.attemptId)) };
      },
      onSettled: ({ imageId, status, startedMs }) => input.logResult(imageId, status, startedMs),
      onThrown: ({ imageId, startedMs }) => input.logResult(imageId, "failed", startedMs),
      sink,
    });
    return imageId;
  } finally {
    logDiagnostics("images.scene_render", collected.items, plan.focal?.name ? { focal: plan.focal.name } : undefined);
  }
}

interface SceneAttemptContext {
  promptFor: (id: SceneAttemptId) => string;
  primaryReference: ImageRenderReference | null;
  multiReferences: ImageRenderReference[];
  focalName: string;
  profile: ResolvedImageProfile | null;
  /** The caller-resolved LoRA every rung of this chain carries, when there is one. */
  resolvedLora?: ImageLoraRenderBinding;
  /**
   * Each rung's latest attempt provenance, written by {@link runSceneProvider}.
   * Keyed by rung so the produce step can record the one that actually won —
   * a retry within a rung overwrites, which is correct: the surviving image
   * came from the LAST run of that rung.
   */
  attempts: Map<SceneAttemptId, ResolvedImageAttempt>;
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
      // Every rung carries it: the chain is one model's degradation ladder, so a
      // fallback from the multi-reference rung to the single-anchor one is still
      // the render the LoRA was chosen for. Spread conditionally so a LoRA-free
      // scene hands the renderer the exact object it always did.
      ...(ctx.resolvedLora ? { resolvedLora: ctx.resolvedLora } : {}),
    },
    ctx.sink,
  );
  if (result.attempt) ctx.attempts.set(id, result.attempt);
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

/**
 * Re-stamp the row after a fallback rung won: the prompt and model that actually
 * rendered, and the identity provenance for the references that rung actually
 * sent — an empty set REMOVES `identityReferences`, because the reserve-time
 * value described the primary attempt's send, not this one's.
 */
async function correctProviderMeta(
  assetId: string,
  prompt: string,
  model: string,
  identityReferences: IdentityReferenceProvenance[],
): Promise<void> {
  const [row] = await db().select({ meta: images.meta }).from(images).where(eq(images.id, assetId)).limit(1);
  const meta: Record<string, unknown> = { ...imageMeta(row?.meta), model };
  if (identityReferences.length > 0) meta.identityReferences = identityReferences;
  else delete meta.identityReferences;
  await db().update(images).set({ prompt, meta }).where(eq(images.id, assetId));
}

function sceneFailureMessage(items: readonly Diagnostic[]): string {
  const terminal = [...items]
    .reverse()
    .find((diagnostic) =>
      diagnostic.code === "images.scene_render.all_failed" || diagnostic.code === "images.scene_render.service_outage",
    );
  return terminal?.message ?? "all scene image providers failed";
}

export function shouldGenerateScene(scene: SceneGenState, turnNumber: number, directorWorthIt: boolean): boolean {
  if (scene.interval <= 0) return false;
  if (scene.status === "generating") return false;
  if (directorWorthIt) return true;
  return turnNumber - (scene.lastGeneratedTurn ?? 0) >= scene.interval;
}
