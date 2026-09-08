import { and, eq } from "drizzle-orm";
import {
  characterProfileSchema,
  emptyCharacterProfile,
  normalizeReferenceViewTargets,
  outfitItems,
  plannedReferenceViews,
  referenceViewAngleById,
  referenceViewFaceVisibility,
  referenceViewWardrobeById,
  REFERENCE_VIEW_BACKGROUND_CLAUSE,
  REFERENCE_VIEW_GENERATION_VERSION,
  type ReferenceView,
} from "@/contracts";
import { characterChangeContract, characterVariantImageOperation } from "@/contracts/images/character-digest";
import { standaloneCharacterReadToken } from "@/contracts/images/subject-digest";
import { diag, DiagnosticCollector, teeSink, type DiagnosticSink } from "@/contracts/diagnostics";
import { parseOr } from "@/lib/parse";
import { log, logDiagnostics } from "@/server/log";
import {
  classifyImageFailureMessage,
  IMAGE_TARGET_ASPECT,
  type ImageLoraRenderBinding,
  type ResolvedImageProfile,
} from "@vesper/image-core";
import { characters, db } from "../db";
import { hasReplicate, isDemoMode } from "../ai";
import { runImagePipeline } from "./assets";
import { deleteOwnedImage } from "./asset-deletion";
import { loadDefaultWardrobeWithRevisions, type AvatarWardrobeLoad } from "./avatar";
import { toWornInputs } from "./avatar-wardrobe";
import {
  buildCharacterPromptProgram,
  characterPromptTransport,
  characterPromptUnboundRefusal,
  type CharacterPromptProgram,
} from "./character-prompt-program";
import { identityPackRenderReferences } from "./identity-pack-consume";
import { resolveImageProfileForTask } from "./model-profiles";
import { pairProfileWithNsfwLora } from "./nsfw-lora";
import { renderAttemptMeta, renderImageIntent } from "./render-intent";
import { buildStandaloneSubjectCut, standaloneSubjectPromptCut, type StandaloneSubjectCut } from "./standalone-subject-visual";
import {
  failReferenceView,
  finalizeReferenceView,
  readAcceptedPortraitSource,
  reserveReferenceView,
} from "./reference-view-store";

/**
 * **THE REFERENCE VIEW BUILD** — the detached job that turns one accepted
 * portrait into the small sheet of views every later render can anchor to.
 *
 * It is the portrait-variant lane's machinery pointed at a fixed set of cameras.
 * Same cut, same compiled prompt program, same identity pack, same pipeline
 * shell (`variants.ts` is the reference implementation and this file
 * deliberately mirrors it). Four things differ, and all four are the feature:
 *
 * 1. **The camera is the registry's, not the lane's.** Each angle carries its
 *    own `SceneCameraSpec` and camera id, and the cut is built through
 *    `buildStandaloneSubjectCut` DIRECTLY rather than through
 *    `buildStandaloneLaneCut`, whose consent gate is welded shut — a bare view
 *    needs the digest's intimate lane open, which is precisely what that
 *    wrapper refuses to allow any standalone lane.
 * 2. **The wardrobe is an axis.** `clothed` loads the saved outfit exactly as
 *    the variant lane does; `bare` passes NO garments, so the coverage readout
 *    reads fully bare and the adapter's exposure facts state it. No prompt text
 *    anywhere asserts nudity — the coverage does.
 * 3. **A bare view rides the anatomy LoRA**, paired the way the `nsfw_test`
 *    variant kind pairs it, because the scenes that consume these views run on
 *    those weights and a reference rendered on different weights anchors a body
 *    the consumer cannot reproduce.
 * 4. **Nothing here can fail an accept.** Every refusal is a value with a code:
 *    a moderated bare view fails its own row and the other seven carry on, a
 *    character with no accepted portrait builds nothing and says so, and the
 *    job never throws out of itself.
 *
 * The age gate is a GATE, in {@link plannedReferenceViews}, and it runs before
 * anything is reserved — a character whose image age band is not a recognized
 * adult one simply has no bare slots to build. Nothing about it reaches a model.
 */

/** The one live spelling of the diagnostic scope, so the drain and the codes agree. */
const SCOPE = "images.reference_views";

/** A view's render failed. The expected instance is a moderated bare view. */
export const REFERENCE_VIEW_BUILD_FAILED = `${SCOPE}.build_failed`;

export interface BuildReferenceViewsInput {
  /** The heartbeat-live job whose payload owns each target lease. */
  jobId: string;
  characterId: string;
  ownerId: string;
  /** The slots to build. Absent builds every planned slot. */
  targets?: readonly ReferenceView[];
  sink?: DiagnosticSink;
}

export interface ReferenceViewBuildReport {
  /**
   * `not_found` — no such character for this owner. `not_accepted` — nothing has
   * been accepted, so there is no source to derive from. `source_unreadable` —
   * the accepted portrait's bytes could not be read, so no view could honestly
   * claim to be derived from them. `unavailable` — no image provider is
   * configured (demo mode), which is a fact about this deployment and not about
   * the character. `built` — the pass ran; `built`/`failed` say how it went.
   */
  status: "built" | "not_found" | "not_accepted" | "source_unreadable" | "unavailable";
  planned: number;
  built: number;
  failed: number;
}

function report(status: ReferenceViewBuildReport["status"], planned = 0, built = 0, failed = 0): ReferenceViewBuildReport {
  return { status, planned, built, failed };
}

/**
 * The instruction one view asks the model for: the angle, the wardrobe clause,
 * and the sheet's blank backdrop, name-bound.
 *
 * Assembled here rather than stored per view because the three parts have
 * different owners — the angle registry, the wardrobe registry, and the sheet's
 * one setting rule — and a stored sentence would freeze a copy of all three.
 * `REFERENCE_VIEW_GENERATION_VERSION` is what makes a row built under earlier
 * wording read stale.
 */
export function referenceViewInstruction(view: ReferenceView, name: string): string | null {
  const angle = referenceViewAngleById(view.angle);
  const wardrobe = referenceViewWardrobeById(view.wardrobe);
  if (angle === undefined || wardrobe === undefined) return null;
  return [angle.instruction, wardrobe.instruction, REFERENCE_VIEW_BACKGROUND_CLAUSE]
    .join(", ")
    .replaceAll("{name}", name);
}

/** Everything one character's whole pass shares, read once. */
interface BuildContext {
  readonly jobId: string;
  readonly characterId: string;
  readonly ownerId: string;
  readonly name: string;
  readonly profile: ReturnType<typeof emptyCharacterProfile>;
  readonly revision: string;
  readonly wardrobe: AvatarWardrobeLoad;
  readonly acceptedImageId: string;
  readonly sourceContentHash: string;
  readonly sink: DiagnosticSink;
}

/**
 * Build (or rebuild) a character's reference views from its accepted portrait.
 *
 * The detached job body. It drains its own diagnostics to the process log the
 * way `renderChatLookImage` does: a background job has no request sink, and a
 * refusal that pushed a diagnostic into nothing is a sheet that silently never
 * appears.
 *
 * One pass reads the character, the accepted portrait's bytes and the wardrobe
 * ONCE, and then starts every target it was given at the same moment
 * ({@link runReferenceViewBuilds}). The batch is one job, admitted and charged
 * once by whoever queued it.
 */
export async function buildReferenceViews(input: BuildReferenceViewsInput): Promise<ReferenceViewBuildReport> {
  const collected = new DiagnosticCollector();
  const sink: DiagnosticSink = input.sink ? teeSink(input.sink, collected) : collected;
  try {
    return await runBuild(input, sink);
  } finally {
    logDiagnostics(SCOPE, collected.items, { characterId: input.characterId });
  }
}

async function runBuild(input: BuildReferenceViewsInput, sink: DiagnosticSink): Promise<ReferenceViewBuildReport> {
  const { characterId, ownerId } = input;
  const [character] = await db()
    .select()
    .from(characters)
    .where(and(eq(characters.id, characterId), eq(characters.ownerId, ownerId)))
    .limit(1);
  if (!character) return report("not_found");

  const acceptedImageId = character.acceptedAvatarImageId;
  if (acceptedImageId === null) {
    sink.push(
      diag("warn", `${SCOPE}.not_accepted`, "this character has no accepted portrait to derive views from", {
        path: SCOPE,
        context: { characterId },
      }),
    );
    return report("not_accepted");
  }

  const profile = parseOr(
    characterProfileSchema,
    character.profile ?? {},
    emptyCharacterProfile(),
    sink,
    "characters.profile",
  );
  // The age gate, before anything is reserved: a bare slot the ruling refuses is
  // never a row, never a charge and never a failed tile.
  const planned = plannedReferenceViews(profile);
  // Normalized rather than merely filtered: a caller that named one slot twice
  // gets one attempt, so no batch can supersede its own render mid-flight.
  const { targets } = normalizeReferenceViewTargets(input.targets ?? planned, planned);
  if (targets.length === 0) return report("built", planned.length);

  if (isDemoMode() || !hasReplicate()) {
    sink.push(
      diag("warn", `${SCOPE}.provider_unavailable`, "no image provider is configured, so no reference view was rendered", {
        path: SCOPE,
        context: { characterId },
      }),
    );
    return report("unavailable", planned.length);
  }

  // The bytes the whole sheet claims to be derived from, read and hashed once.
  const source = await readAcceptedPortraitSource(characterId, ownerId);
  if (!source.ok) {
    sink.push(
      diag("warn", `${SCOPE}.source_unreadable`, "the accepted portrait's bytes could not be read", {
        path: SCOPE,
        context: { characterId, sourceImageId: acceptedImageId },
      }),
    );
    return report("source_unreadable", planned.length);
  }

  const wardrobe = await loadDefaultWardrobeWithRevisions(ownerId, outfitItems(profile), sink);
  const context: BuildContext = {
    jobId: input.jobId,
    characterId,
    ownerId,
    name: character.name,
    profile,
    revision: character.updatedAt.toISOString(),
    wardrobe,
    acceptedImageId,
    sourceContentHash: source.contentHash,
    sink,
  };

  const { built, failed } = await runReferenceViewBuilds(targets, (target) =>
    buildOneReferenceView(context, target),
  );

  return report("built", planned.length, built, failed);
}

/**
 * Every target in one admitted batch, started together.
 *
 * The batch was admitted once, charged once and runs as one background job; the
 * only thing the old two-worker cursor bought was rendering an eight-view sheet
 * in four waves, which is latency the owner watches for no gain. Spend is
 * governed where spend is decided — the daily image budget, backpressure and the
 * per-user job cap — never by an arithmetic limit here.
 *
 * `buildOne` MUST NOT throw. That is what keeps settlement per-slot: each target
 * reserves, renders and settles its own row, so a moderated bare view fails
 * exactly one tile and the other seven finish. `buildOneReferenceView` is
 * written to that contract, and a throw from it is a defect that fails the whole
 * pass loudly rather than being counted as a refusal.
 *
 * Extracted so the concurrency promise can be exercised on its own: the claim is
 * about the fan-out, not about the database underneath one view.
 */
export async function runReferenceViewBuilds(
  targets: readonly ReferenceView[],
  buildOne: (target: ReferenceView) => Promise<boolean>,
): Promise<{ built: number; failed: number }> {
  const settled = await Promise.all(targets.map((target) => buildOne(target)));
  let built = 0;
  let failed = 0;
  for (const ok of settled) {
    if (ok) built += 1;
    else failed += 1;
  }
  return { built, failed };
}

// ---------------------------------------------------------------------------
// One view
// ---------------------------------------------------------------------------

/** The bare view's weights, or the reason this one view cannot be rendered. */
type BareRoute = { ok: true; profile: ResolvedImageProfile; binding: ImageLoraRenderBinding } | { ok: false; error: string };

/**
 * A bare view's model pairing, exactly the `nsfw_test` variant kind's route
 * (`resolveNsfwTestRoute` in `variants.ts`) and failing for its reason: a
 * reference the consumers cannot reproduce is worse than a missing one, so a
 * missing leg fails THIS view — regenerable later — and leaves the clothed views
 * untouched.
 */
async function resolveBareRoute(profile: ResolvedImageProfile, sink: DiagnosticSink): Promise<BareRoute> {
  const paired = await pairProfileWithNsfwLora(profile, sink);
  if (!paired.ok) return { ok: false, error: `the anatomy LoRA is unavailable (${paired.leg}): ${paired.message}` };
  return { ok: true, profile: paired.profile, binding: paired.binding };
}

/** True when the view produced a ready asset. Never throws. */
async function buildOneReferenceView(context: BuildContext, view: ReferenceView): Promise<boolean> {
  const { characterId, ownerId, sink } = context;
  const angle = referenceViewAngleById(view.angle);
  const wardrobeEntry = referenceViewWardrobeById(view.wardrobe);
  const instruction = referenceViewInstruction(view, context.name);
  // Unreachable for a target that came through `plannedReferenceViews`; a caller
  // that hand-built one gets a refusal rather than a throw.
  if (angle === undefined || wardrobeEntry === undefined || instruction === null) return false;

  const viewId = await reserveReferenceView({
    jobId: context.jobId,
    characterId,
    ownerId,
    view,
    sourceImageId: context.acceptedImageId,
    sourceContentHash: context.sourceContentHash,
  });
  // The character can cross the age gate after the job was admitted. The
  // reservation rechecks under the character lock and spends nothing for a
  // slot that is no longer eligible.
  if (viewId === null) return false;

  const intimate = wardrobeEntry.intimate;
  const picked = await resolveImageProfileForTask("variant", undefined, sink);
  const bareRoute = intimate && picked ? await resolveBareRoute(picked, sink) : null;
  const resolved = bareRoute?.ok === true ? bareRoute.profile : picked;

  const cut = tryBuildViewCut(context, view, angle.camera, angle.cameraId, intimate);
  const packIdentity =
    cut !== null && resolved !== null
      ? await identityPackRenderReferences({ ownerId, characterId, profile: resolved, sink })
      : null;
  const packSelection = packIdentity?.ok === true ? packIdentity : null;

  const program =
    cut !== null && resolved !== null && packSelection !== null && bareRoute?.ok !== false
      ? buildCharacterPromptProgram({
          lane: "variant",
          task: "variant",
          profile: resolved,
          bindingProfileKey: resolved.profile.key,
          cuts: [standaloneSubjectPromptCut(cut, { subjectId: characterId, name: context.name })],
          read: {
            kind: "standalone_character",
            characters: [{ characterId, revision: context.revision }],
            extraRevisions: [...context.wardrobe.revisions],
          },
          references: packSelection.references.map((entry) => ({ reference: entry.reference, subjectId: characterId })),
          operation: (subjects) =>
            characterVariantImageOperation({
              change: characterChangeContract(
                {
                  // A clothed view moves the body and keeps everything else, so it
                  // names the pose; a bare view also drops the garments, so it names
                  // the wardrobe — otherwise the preserve set would insist on exactly
                  // the clothing the instruction asks the model to remove.
                  concept: intimate ? "subject.wardrobe" : "subject.pose",
                  value: instruction,
                },
                subjects,
              ),
            }),
          // The intimate anatomy facts ride `bare` alone, projected from the same
          // resolved attributes and coverage readout the cut was selected over.
          ...(intimate ? { intimateReveal: true } : {}),
          // Identity-critical: a view that lost its anchor draws a stranger, and a
          // stranger anchoring every later scene is the exact failure this whole
          // set exists to stop.
          refuseOnMissingRequired: true,
          sink,
        })
      : null;
  const compiled: CharacterPromptProgram | null = program?.kind === "compiled" ? program : null;

  const precondition = viewPrecondition({ cut, resolved, bareRoute, packIdentity, program });
  let failure: string | null = precondition;

  const { imageId, status } = await runImagePipeline({
    asset: {
      ownerId,
      kind: "reference_view",
      entityKind: "character",
      entityId: characterId,
      prompt: compiled?.prompt ?? "",
      sourceImageId: context.acceptedImageId,
      meta: {
        referenceView: {
          angle: view.angle,
          wardrobe: view.wardrobe,
          generationVersion: REFERENCE_VIEW_GENERATION_VERSION,
          faceVisibility: referenceViewFaceVisibility(angle),
        },
        model: `replicate/${resolved?.model.slug ?? "none"}`,
        ...(bareRoute?.ok === true ? { lora: bareRoute.binding.id } : {}),
        ...(packSelection ? { identityReferences: packSelection.provenance } : {}),
        ...(cut?.digestMeta ?? {}),
        ...(compiled?.meta ?? {}),
      },
    },
    failedPrecondition: precondition,
    produce: async (asset) => {
      // Every no-answer above already failed the row, so a production render
      // reaches the provider only with a compiled program on a resolved model.
      if (resolved === null || compiled === null) return { ok: false, error: "no compiled prompt program for this view" };
      const edit = await renderImageIntent(
        {
          profile: resolved,
          ...characterPromptTransport(compiled),
          references: packSelection?.references.map((entry) => entry.reference) ?? [],
          target: { aspectRatio: IMAGE_TARGET_ASPECT },
          ...(bareRoute?.ok === true ? { resolvedLora: bareRoute.binding } : {}),
        },
        sink,
      );
      if (!edit.ok || !edit.image) {
        const error = edit.error ?? `${resolved.model.slug} returned no image`;
        failure = error;
        return { ok: false, error, ...renderAttemptMeta(edit.attempt) };
      }
      return { ok: true, image: edit.image, ...renderAttemptMeta(edit.attempt) };
    },
    onThrown: ({ message }) => {
      failure = message;
    },
    sink,
  });

  if (status !== "ready") {
    const message = failure ?? "the reference view render produced no image";
    await failReferenceView({
      jobId: context.jobId,
      viewId,
      characterId,
      ownerId,
      failureCode: classifyImageFailureMessage(message),
      failureMessage: message,
    });
    sink.push(
      diag("warn", REFERENCE_VIEW_BUILD_FAILED, message.slice(0, 300), {
        path: SCOPE,
        context: { characterId, angle: view.angle, wardrobe: view.wardrobe },
      }),
    );
    return false;
  }

  const finalized = await finalizeReferenceView({
    jobId: context.jobId,
    viewId,
    characterId,
    ownerId,
    imageId,
    method: "rendered",
  });
  if (finalized === "fenced") {
    // This worker lost the lease before settlement. Its produced asset belongs
    // to no attempt, so compensate only that unused output.
    try {
      await deleteOwnedImage(imageId, ownerId, { kind: "reference_view" });
    } catch (error) {
      log.warn("images", "unused fenced reference view cleanup failed", {
        imageId,
        error: error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300),
      });
    }
  }
  return finalized === "ready";
}

/**
 * The first precondition that stops this view, in the order the lane learns
 * them, or null for a view that can actually run. Each one fails the row BEFORE
 * provider spend — a render that never ran did not fail to generate.
 */
function viewPrecondition(inputs: {
  cut: StandaloneSubjectCut | null;
  resolved: ResolvedImageProfile | null;
  bareRoute: BareRoute | null;
  packIdentity: Awaited<ReturnType<typeof identityPackRenderReferences>> | null;
  program: ReturnType<typeof buildCharacterPromptProgram> | null;
}): string | null {
  if (inputs.cut === null) return "the reference view's visual cut could not be assembled";
  if (inputs.resolved === null) return "no image model is registered for portrait variants";
  if (inputs.bareRoute !== null && !inputs.bareRoute.ok) return inputs.bareRoute.error;
  if (inputs.packIdentity === null || !inputs.packIdentity.ok) {
    return inputs.packIdentity && !inputs.packIdentity.ok ? inputs.packIdentity.error : "identity references unavailable";
  }
  const program = inputs.program;
  if (program === null) return "no prompt program could be compiled for this view";
  if (program.kind === "refused") return program.refusal;
  if (program.kind === "unbound") return characterPromptUnboundRefusal(program);
  return null;
}

/**
 * The cut, or null when it would not assemble. A thrown build is a defect and is
 * degraded to a failed row with a diagnostic before any spend, exactly as the
 * variant lane's `tryBuildVariantCut` does.
 *
 * The two wardrobe states differ in ONE input each and nowhere else: `bare`
 * passes no garments (so the coverage readout reads fully bare, and the
 * adapter's exposure facts state it) and opens the digest's intimate lane.
 */
function tryBuildViewCut(
  context: BuildContext,
  view: ReferenceView,
  camera: Parameters<typeof buildStandaloneSubjectCut>[0]["camera"],
  cameraId: string,
  intimate: boolean,
): StandaloneSubjectCut | null {
  const load = context.wardrobe;
  try {
    return buildStandaloneSubjectCut({
      characterId: context.characterId,
      profile: context.profile,
      worn: intimate ? [] : toWornInputs(load.wardrobe),
      // A failed or unreadable wardrobe is unknown state, never a bare body —
      // and it says nothing about a view that is bare by construction, so the
      // degrade flags ride the clothed axis only.
      ...(!intimate && load.failed === true ? { wardrobeUnavailable: true } : {}),
      ...(!intimate && (load.coverageUnreliableIds?.length ?? 0) > 0 ? { coverageUnreliable: true } : {}),
      readToken: standaloneCharacterReadToken({
        characterId: context.characterId,
        revision: context.revision,
        extraRevisions: load.revisions,
      }),
      camera,
      cameraId,
      intimateAllowed: intimate,
      sink: context.sink,
    });
  } catch (err) {
    context.sink.push(
      diag("warn", `${SCOPE}.visual_cut_failed`, "the reference view's visual cut failed to assemble", {
        path: SCOPE,
        context: {
          characterId: context.characterId,
          angle: view.angle,
          wardrobe: view.wardrobe,
          error: err instanceof Error ? err.message.slice(0, 300) : String(err).slice(0, 300),
        },
      }),
    );
    return null;
  }
}
