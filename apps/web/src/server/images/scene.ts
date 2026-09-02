import { eq } from "drizzle-orm";
import { db, imageReferences, images } from "../db";
import {
  classifyImageFailure,
  composerDisablesReasoning,
  composerFallbackModelId,
  generateChecked,
  isDemoMode,
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
import {
  buildCharacterPromptProgram,
  characterPromptTransport,
  type CharacterPromptProgram,
  type CharacterPromptReference,
  type CharacterPromptTransport,
} from "./character-prompt-program";
import { characterSceneImageOperation } from "@/contracts/images/character-digest";
import { monogramSvg } from "./monogram";
import type { SceneSubjectVisualSlice } from "./scene-subject-visual";
import {
  buildSceneComposerPrompt,
  type SceneComposerContext,
  sceneComposerSystem,
  type SceneSpec,
  sceneSpecSchema,
} from "./prompts-scene-composer";
import { heuristicFocalName, resolveScenePlan, type SceneRenderPlan } from "./prompts-scene-plan";
import { lowerScenePlan } from "./scene-lowering";

export type SceneComposeInput = SceneComposerContext & {
  sink?: DiagnosticSink;
  /**
   * The conversation's admin-set composer model (`character_chats.scene_composer_model`,
   * a curated `SCENE_COMPOSER_MODELS` id). Empty/absent/unknown ⇒ the curated default,
   * which is what every chat that has never been switched sends — so this is additive
   * and the untouched path is byte-identical.
   */
  composerModel?: string | null;
};

/**
 * Compose a validated render plan from the current scene context.
 *
 * TWO model calls at most, on two models (owner ruling
 * 2026-08-10). The primary runs on the composer's own seam and is asked with **no fallback**
 * on purpose: `generateChecked` answers a missing fallback with the schema's own defaults,
 * which parse cleanly and would look exactly like a successful composition — the refusal
 * would be invisible and the second model would never be asked. Reading `degraded` is what
 * makes a refusal or a schema miss visible enough to retry.
 *
 * The retry is the approved refusal fallback (`composerFallbackModelId` — a model already
 * trusted with this repo's most explicit text, and guaranteed not to be the primary itself),
 * and it carries the heuristic fallback, so the terminal degrade stays today's deterministic
 * spec — never a failed render.
 */
export async function composeSceneSpec(input: SceneComposeInput): Promise<SceneRenderPlan> {
  const { sink, composerModel, ...context } = input;
  const fallback = (): SceneSpec => heuristicSceneSpec(context);
  const request = {
    schema: sceneSpecSchema,
    system: sceneComposerSystem(context.embodiedViewer === true),
    prompt: buildSceneComposerPrompt(context),
    code: "images.scene_composer",
    sink,
  };
  // Resolved ONCE: the id is read four times below (the call, the diagnostic, its context,
  // and the fallback's collision check), and re-resolving would let a mid-compose default
  // change split the ladder across two models nobody chose.
  const primaryModelId = sceneComposerModelId(composerModel);
  const primary = await generateChecked({
    ...request,
    modelId: primaryModelId,
    disableReasoning: composerDisablesReasoning(primaryModelId),
  });
  if (!primary.degraded && primary.value) return resolveScenePlan(primary.value, context, sink);
  // Demo mode degrades every model call by design, so a second one buys nothing but noise —
  // and the primary's own `.degraded` diagnostic has already said what happened.
  if (isDemoMode()) return resolveScenePlan(fallback(), context, sink);
  const fallbackModelId = composerFallbackModelId(primaryModelId);
  sink?.push(
    diag("info", "images.scene_composer.model_fallback", `scene composer degraded on ${primaryModelId} — retrying on ${fallbackModelId}`, {
      context: { primary: primaryModelId, fallback: fallbackModelId },
    }),
  );
  const retry = await generateChecked({
    ...request,
    modelId: fallbackModelId,
    fallback,
    // Resolved for the RUNG, not inherited from the primary: the fallback is an Aion
    // endpoint, which rejects `reasoning:{enabled:false}` outright.
    disableReasoning: composerDisablesReasoning(fallbackModelId),
  });
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

/**
 * The light a time of day implies, for a plan whose lighting nobody wrote.
 *
 * Exported for the staged-scene lab lane, which has no composer to ask and no
 * chat to read one off: an admin who states `night` and no lighting gets the
 * same phrase the chat lane's own fallback spec would have produced, rather than
 * a second table saying nearly the same thing. Anything outside the four words
 * falls through to the neutral phrase, which is why both callers can pass free
 * text at it.
 */
export function heuristicLighting(timeOfDay: string | undefined): string {
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
  flavor?: string;
  /**
   * Identity-pack provenance for the anchors the caller PLANNED to send,
   * persisted on the row's `meta.identityReferences`. Only the
   * flag-on caller supplies it. What persists is narrowed to the references the
   * render actually sent: a refused render (`failedPrecondition`) records none,
   * and a fallback rung or a capacity trim drops the entries whose bytes never
   * reached the provider.
   */
  identityProvenance?: IdentityReferenceProvenance[];
  /**
   * The app-owned `meta.visualState` fragment from the visual image digest
   * (image-lane-consolidation Stages 3–4) — `{ visualState: <provenance> }`. One
   * record however many people the scene draws: the cast seam
   * (`scene-subject-visual.ts` §"One render, N cuts") folds each subject's cut
   * into a single provenance carrying one `subjects[]` entry per person. Merged
   * into the row's reserve-time meta as a SIBLING of the package-owned render
   * provenance, so a failed or refused render still records which visual moment
   * fed it.
   */
  visualStateMeta?: Record<string, unknown>;
  /**
   * Every person this render draws, as their own realized cut, in cast order
   * (issue #256).
   *
   * The scene's ONLY prompt input. Present for the chat scene caller, which
   * commits one cut per present cast member; absent, there is nothing to compile
   * a program from, every provider rung is dropped and the render fails — the
   * scene has no second prompt system to draw from.
   *
   * The WHOLE cast, not the focal alone: a two-person scene compiles a program
   * that states both people, binds each identity reference to its own subject
   * and asserts a subject count of two. Handing over one cut would compile a
   * prompt describing one woman for a payload carrying two faces.
   */
  cast?: readonly SceneSubjectVisualSlice[];
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
 *
 * The compiled prompt program is the whole of the scene's words. Every rung that
 * reaches a provider carries one, and a rung that compiles none is dropped from
 * the ladder rather than handed a second description assembled somewhere else —
 * see the per-rung compile below for why one prompt system is the point and not
 * an economy.
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
  // Which cast member each identity image shows, recorded as the render
  // references are built rather than re-derived by index afterwards: a reference
  // whose bytes never loaded is dropped here, so the two lists do not stay
  // aligned. The scene reference carries the library entity id, so this is a
  // read rather than a guess — and on an ensemble render a guess is the claim
  // that both photographs show the same woman.
  const subjectByReference = new Map<ImageRenderReference, string>();
  const orderedReferences = imageRefs.flatMap((reference): ImageRenderReference[] => {
    const buffer = reference.imageId ? input.referenceBuffers.get(reference.imageId) : undefined;
    if (!buffer) return [];
    const rendered: ImageRenderReference = {
      role: sceneReferenceRole(reference.kind),
      buffer,
      ...(reference.imageId ? { sourceImageId: reference.imageId } : {}),
      ...(reference.name ? { name: reference.name } : {}),
    };
    if (reference.kind === "character" && reference.entityId !== undefined) {
      subjectByReference.set(rendered, reference.entityId);
    }
    return [rendered];
  });
  const primaryReference = orderedReferences[0] ?? null;
  // The model's own capacity, not a literal 3: a two-character cast plus a place
  // is three references on Qwen Edit 2511 and would have been silently trimmed to
  // the old constant on any model that takes more. Callers order people before
  // the place, so a short capacity drops the setting rather than a character.
  const multiCapacity = model ? referenceCapacity(model).max : 1;
  const multiReferences = orderedReferences.slice(0, multiCapacity);

  // The row's `sourceImageId` and `meta.referenceName` — which stored image this
  // render was anchored on. A provenance read, not a prompt one: the prompt's
  // account of its references comes from the compiled program, which plans them
  // itself rather than trusting this list's order.
  const anchorRef = imageRefs[0];

  /** Stored on the image row for provider/model auditability. */
  const modelFor = (id: SceneAttemptId): string => (id === "demo" || !model ? "demo" : `replicate/${model.slug}`);

  // The references one rung OFFERS its program — the lane's own list, in the
  // lane's own order, already cut to the model's capacity. Not the send list:
  // the program plans these, and the list it hands back is what the rung sends
  // (`sentReferencesFor`, below).
  const offeredReferencesFor = (id: SceneAttemptId): ImageRenderReference[] => {
    if (id === "multi_edit") return multiReferences.slice(0, attemptReferenceCount(id, model));
    if (id === "edit" && primaryReference) return [primaryReference];
    return [];
  };

  // -------------------------------------------------------------------------
  // The scene's ONE prompt assembly: a compiled program, PER RUNG
  // -------------------------------------------------------------------------
  //
  // Per rung because the rungs are genuinely different renders of one scene: the
  // multi-reference rung composes N faces, the single-reference rung edits one,
  // and the bare rung describes everybody from text with no reference at all.
  // Each states its own reference claims, its own identity-lock spelling (the
  // dialects pick it by reference COUNT) and its own operation kind — and the
  // kind carries the strategy with it, which is why each shape resolves its own
  // binding row.
  //
  // Pure and cheap, so every rung in the chain is compiled up front, before
  // anything is reserved. A rung that produces no program is DROPPED from the
  // chain, whatever stopped it — a compile refusal, no active binding for its
  // (model, task, profile key), no committed cast cut to describe, no resolved
  // profile at all. There is nowhere else for its words to come from, and that
  // is the law rather than a gap: a rung whose program will not compile cannot
  // say honestly what it is about to draw, and a picture assembled from a second
  // description nobody can trace is worse than no picture. The ladder's purpose
  // is that a rung which cannot run hands off to the next one, so a drop costs
  // this render nothing until the drops run out — the render fails when no rung
  // survives.
  //
  // The demo rung is the one rung that needs no program: it draws a monogram
  // from the focal name and never reads a prompt.
  const cast = input.cast ?? [];
  const castCuts = cast.map((slice) => ({
    subjectId: slice.subjectId,
    name: slice.name,
    digest: slice.digest,
    attributes: slice.attributes,
    exposure: slice.exposure,
    realizedBody: slice.realizedBody,
  }));
  // The committed cut this render was asked over — the staleness check's whole
  // meaning. One id for the whole cast by construction: the scene queue mints a
  // job-local cut id per render and hands every member the same one, and the
  // cast merge refuses a cast whose members disagree about it.
  const castReadToken = cast[0]?.cutId ?? "";
  // The intimate permission each rung actually renders under. Per rung rather
  // than per render because a staged arrangement may only travel a route that
  // allows it: the reference-edit rungs render under their anchors' own
  // permission — every character anchor must clear it on the multi rung — and
  // the bare rung under none.
  const allowIntimate = anchorRef?.allowForIntimate ?? false;
  const multiAllowIntimate = imageRefs
    .filter((reference) => reference.kind === "character")
    .every((reference) => reference.allowForIntimate);
  const allowIntimateFor = (id: SceneAttemptId): boolean =>
    id === "multi_edit" ? multiAllowIntimate : id === "edit" ? allowIntimate : false;
  const programFor = (id: SceneAttemptId): CharacterPromptProgram | "dropped" | null => {
    if (id === "demo") return null;
    // Unreachable rather than tolerated: `routeSceneAttempts` routes no provider
    // rung without a model, so a profile-less request arrives with an empty
    // chain and never gets here. Written as a drop anyway because the only other
    // honest option is a rung compiled against a model nobody resolved, and a
    // routing change that made this reachable would then ship that silently.
    if (profile === null) {
      sink.push(
        diag("warn", "images.scene_render.program_unprofiled", `the ${id} rung has no resolved image profile to compile a prompt program against`, {
          context: { attempt: id },
        }),
      );
      return "dropped";
    }
    // No committed cut for anyone in the cast — the digest this scene's words
    // are made of. A render here has people to draw and nothing that says what
    // they look like, so it fails rather than describing them from somewhere
    // else.
    if (castCuts.length === 0) {
      sink.push(
        diag("warn", "images.scene_render.program_castless", `the ${id} rung has no committed cast cut to compile a prompt program from`, {
          context: { attempt: id, model: profile.model.slug, profileKey: profile.profile.key },
        }),
      );
      return "dropped";
    }
    // The scene itself: the setting, the light, the mood, the capture mode, the
    // staged arrangement and what each person is doing, lowered into the typed
    // inputs the program compiles. Per rung, because the staging gate is.
    const scene = lowerScenePlan({
      plan,
      cast: cast.map((slice) => ({ subjectId: slice.subjectId, name: slice.name })),
      allowIntimate: allowIntimateFor(id),
      sink,
    });
    // The intimate route swapped this render onto the LoRA wrapper before the
    // profile arrived here, so `profile.model.slug` is already the model the
    // provider will be called with and resolution needs no special case: the
    // wrapper carries its own binding and its own delta-edit dialect.
    const kind = id === "generate" ? "generate" : "edit";
    const offered = offeredReferencesFor(id);
    const program = buildCharacterPromptProgram({
      lane: "scene",
      task: "scene",
      profile,
      bindingProfileKey: profile.profile.key,
      bindingStrategy: kind === "edit" ? "instruction_edit" : "text_to_image_description",
      cuts: castCuts,
      scene: scene.scene,
      location: scene.location,
      camera: scene.camera,
      // The rung's intimate permission, spent a second time: the lowering spent
      // it on the staged arrangement, and this spends it on the cast's exposed
      // anatomy. The uncensored reference-edit rungs state it; the bare-prompt
      // fallback and a content-rejection retry compile the cut alone.
      intimateReveal: allowIntimateFor(id),
      read: { kind: "committed_cut", token: castReadToken },
      references: offered.map((reference): CharacterPromptReference => {
        const subjectId = subjectByReference.get(reference);
        return { reference, ...(subjectId === undefined ? {} : { subjectId }) };
      }),
      // The cast size the render ASSERTS — what arms the single-subject
      // integrity guard on a solo shot and tells the anatomy guards how many
      // bodies to defend on an ensemble one.
      operation: () => characterSceneImageOperation({ subjectCount: castCuts.length, kind }),
      // A scene of named people with a lost identity or morphology anchor draws
      // strangers. This is the ONE place that refusal is decided: the cast seam
      // refuses only a cut it cannot assemble at all, and the adapter's
      // join-level check here is what turns a lost required anchor into a dropped
      // rung rather than a render of somebody else.
      refuseOnMissingRequired: true,
      sink,
    });
    if (program.kind === "compiled") return program;
    if (program.kind === "refused") {
      sink.push(
        diag("warn", "images.scene_render.program_refused", `the ${id} rung's prompt program refused: ${program.refusal}`, {
          context: { attempt: id, code: program.code, ...program.context },
        }),
      );
      return "dropped";
    }
    // `unbound` — no active row for this model, task and job shape. The binding
    // table is where a scene's words are authorized, so an endpoint missing from
    // it is an endpoint this lane may not speak for, and the seam's own answer
    // names the three coordinates an operator has to go add a row for.
    sink.push(
      diag("warn", "images.scene_render.program_unbound", `the ${id} rung has no active prompt binding to compile against`, {
        context: { attempt: id, model: program.modelSlug, task: program.task, profileKey: program.profileKey },
      }),
    );
    return "dropped";
  };

  const programs = new Map<SceneAttemptId, CharacterPromptProgram | "dropped" | null>(
    chain.map((id) => [id, programFor(id)]),
  );
  const compiledFor = (id: SceneAttemptId): CharacterPromptProgram | null => {
    const program = programs.get(id);
    return program === undefined || program === "dropped" ? null : program;
  };
  /**
   * The references one rung SENDS: its compiled program's own planned list, in
   * the program's send order.
   *
   * ONE source for the payload and the prompt. The program numbers its slots
   * from this list, so sending it — rather than re-deriving a list here that
   * happens to reduce to the same order — is what makes "Image 2" name the image
   * at slot 2 by construction. The transport plans the list once more on the way
   * out, and planning an already-planned list is a fixed point, so nothing
   * downstream can move a slot the prompt has named. Empty for the demo rung,
   * which sends nothing.
   */
  const sentReferencesFor = (id: SceneAttemptId): readonly ImageRenderReference[] =>
    compiledFor(id)?.sentReferences ?? [];
  // The letters the demo rung draws. Resolved once and shared with the attempt
  // context so the row's prompt and the picture cannot name different people.
  const monogramLabel = plan.focal?.name || "Scene";
  /**
   * The prompt channels one rung sends on.
   *
   * The demo rung is the only rung a runnable chain can hold with no compiled
   * program, so the first argument is only ever spent there — and what it spends
   * is the monogram label, which is what makes the stored row describe the
   * picture that was drawn rather than a request nobody made.
   */
  const transportFor = (id: SceneAttemptId): CharacterPromptTransport => {
    const compiled = compiledFor(id);
    return compiled === null ? { prompt: monogramLabel } : characterPromptTransport(compiled);
  };
  const runnableChain = chain.filter((id) => programs.get(id) !== "dropped");
  if (runnableChain.length < chain.length) {
    sink.push(
      diag("warn", "images.scene_render.rungs_dropped", "a rung was dropped because it compiled no prompt program", {
        context: { dropped: chain.filter((id) => programs.get(id) === "dropped") },
      }),
    );
  }

  // An empty chain means the resolved model cannot serve this render at all
  // (edit-only, no usable reference), or no rung compiled a program. Reserve
  // nothing and fail the row with a message naming the model, rather than
  // silently rendering something else.
  const primary = runnableChain[0];
  if (!primary) {
    sink.push(
      diag("error", "images.scene_render.no_attempt", "the selected image model cannot render this scene", {
        context: { model: model?.slug ?? null, references: references.length, routed: chain.length },
      }),
    );
  }
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

  // The PRIMARY rung's compiled program — the render the reserve-time row
  // describes. Rung-specific, so a fallback rung winning replaces it in the
  // correction pass below.
  const reservedProgram = primary ? compiledFor(primary) : null;

  const ctx: SceneAttemptContext = {
    transportFor,
    referencesFor: sentReferencesFor,
    focalName: monogramLabel,
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
        // No runnable rung means nothing will be asked of a provider, so there
        // is no prompt to record: the column defaults to empty and the row is a
        // failed render whose `no_attempt` diagnostic carries the cause. Writing
        // a prompt no rung would have sent is the one thing this must not do.
        prompt: primary ? transportFor(primary).prompt : "",
        sourceImageId: anchorRef?.imageId,
        meta: {
          demo,
          focalName: plan.focal?.name ?? null,
          referenceName: anchorRef?.name ?? null,
          model: primary ? modelFor(primary) : "none",
          // The RESOLVED shot, for the dev lightbox and probe grading. Ids only
          // — the phrasing
          // lives in the registries, and the prompt itself is already on the row.
          // Written once at reserve time: unlike the prompt and model, the camera is
          // the same on every rung, so a fallback needs no correction pass.
          camera: plan.camera,
          ...(plan.staging ? { staging: plan.staging.id } : {}),
          // App-owned visual provenance (`meta.visualState`), beside the shot
          // facts above. Reserve-time like the camera: the digest describes the
          // committed cut the render was asked over, which no rung or failure
          // changes — so it needs no fallback correction pass and survives a
          // refused or failed row.
          ...(input.visualStateMeta ?? {}),
          // The LoRA that drew it, by library id — the other half of the
          // provenance `meta.model` starts (the wrapper slug lands there through
          // `modelFor`). The id, never the locator: a locator is completed with a
          // credential on its way to the provider, and an image row is exactly
          // the kind of long-lived record that must never carry one.
          ...(input.resolvedLora ? { lora: input.resolvedLora.id } : {}),
          ...(input.flavor ? { flavor: input.flavor } : {}),
          ...(reservedProvenance.length > 0 ? { identityReferences: reservedProvenance } : {}),
          // The compiled program's own provenance, beside the visual provenance
          // it was compiled from. Written at reserve time against the PRIMARY
          // rung; unlike the camera and the visual provenance it IS
          // rung-specific — each rung states its own references and operation
          // kind — so a fallback rung winning replaces it in the correction pass
          // below. The stored record always describes the rung the row's prompt
          // and model describe. Absent only on the demo rung and on a row with
          // no runnable rung at all, neither of which asks a provider for
          // anything.
          ...(reservedProgram?.meta ?? {}),
        },
      },
      failedPrecondition: input.failedPrecondition ?? null,
      afterReserve: (asset) => recordImageReferences(asset.id, references, sink),
      produce: async (asset) => {
        const outcome = await executeSceneChain(runnableChain, (id) => runSceneProvider(id, ctx), sink);
        if (!outcome) {
          // The whole chain exhausted. The failed row still records the LAST
          // rung's attempt — the failure its error text describes — so a failed
          // scene keeps its prediction id and provenance. Walked from the deep
          // end because later rungs overwrite nothing: each rung keys its own
          // attempt, and the deepest one recorded is the last that ran.
          const lastAttempt = [...runnableChain]
            .reverse()
            .map((id) => ctx.attempts.get(id))
            .find((attempt) => attempt !== undefined);
          return { ok: false, error: sceneFailureMessage(collected.items), ...renderAttemptMeta(lastAttempt) };
        }
        if (outcome.attemptId !== primary) {
          // The reserve-time program described the PRIMARY rung's request, and
          // this correction is about to make the row describe the winning rung
          // — so the winning rung's own program provenance replaces it, and the
          // corrected row never pairs one rung's prompt with another rung's
          // world state and program fingerprint. Already compiled: every rung's
          // program was built before the row was reserved.
          await correctProviderMeta(
            asset.id,
            transportFor(outcome.attemptId).prompt,
            modelFor(outcome.attemptId),
            provenanceFor(outcome.attemptId),
            compiledFor(outcome.attemptId)?.meta,
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
  transportFor: (id: SceneAttemptId) => CharacterPromptTransport;
  /** The rung's compiled program's planned send list — the slots its prompt describes. */
  referencesFor: (id: SceneAttemptId) => readonly ImageRenderReference[];
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
 * Run one rung of the chain. The references it sends are its compiled program's
 * own planned list — the slots the prompt describes — so a rung can neither hand
 * the provider an image its text does not account for nor number one the
 * payload does not carry. No capacity slice here: the list the program was
 * offered was already cut to the model's own capacity, and planning trimmed the
 * rest.
 */
async function runSceneProvider(id: SceneAttemptId, ctx: SceneAttemptContext): Promise<ProviderRenderResult> {
  if (id === "demo") return { ok: true, image: monogramSvg(ctx.focalName || "Scene") };
  if (!ctx.profile) return { ok: false, failure: { reason: "other", message: "no image model is registered" } };

  const result = await renderImageIntent(
    {
      profile: ctx.profile,
      // Prompt and any compiled negative in one decision. This lane never sets
      // `promptSegments`: every rung that reaches a provider carries a compiled
      // program, so the transport is always that program's positive text and its
      // exclusions, and there is no second channel for them to disagree with.
      ...ctx.transportFor(id),
      references: [...ctx.referencesFor(id)],
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
 * value described the primary attempt's send, not this one's. The prompt-program
 * provenance follows the same rule: when the reserve recorded one, the winning
 * rung's own fragment replaces it wholesale (its keys overwrite the stale
 * record), so the row never carries the primary rung's world state and program
 * fingerprint beside this rung's prompt and model.
 */
async function correctProviderMeta(
  assetId: string,
  prompt: string,
  model: string,
  identityReferences: IdentityReferenceProvenance[],
  program?: Record<string, unknown>,
): Promise<void> {
  const [row] = await db().select({ meta: images.meta }).from(images).where(eq(images.id, assetId)).limit(1);
  const meta: Record<string, unknown> = { ...imageMeta(row?.meta), model, ...(program ?? {}) };
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
