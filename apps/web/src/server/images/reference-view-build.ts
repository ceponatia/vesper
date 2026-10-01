import { and, eq } from "drizzle-orm";
import {
  characterProfileSchema,
  emptyCharacterProfile,
  normalizeReferenceViewTargets,
  outfitItems,
  plannedReferenceViews,
  referenceViewAngleById,
  referenceViewBodyReferences,
  referenceViewBodySetKey,
  referenceViewFaceVisibility,
  referenceViewUpstream,
  referenceViewUpstreamBinding,
  referenceViewWardrobeById,
  REFERENCE_VIEW_BACKGROUND_CLAUSE,
  REFERENCE_VIEW_GENERATION_VERSION,
  type BodyReferenceImage,
  type BodyReferenceRoutes,
  type ReferenceView,
} from "@/contracts";
import { characterChangeContract, characterVariantImageOperation } from "@/contracts/images/character-digest";
import type { IntimateRouteProvenance } from "@/contracts/images/intimate-scene-lora";
import { standaloneCharacterReadToken } from "@/contracts/images/subject-digest";
import { diag, DiagnosticCollector, teeSink, type DiagnosticSink } from "@/contracts/diagnostics";
import { parseOr } from "@/lib/parse";
import { log, logDiagnostics } from "@/server/log";
import {
  classifyImageFailureMessage,
  IMAGE_TARGET_ASPECT,
  type ImageLoraRenderBinding,
  type ImageRenderReference,
  type ResolvedImageProfile,
} from "@vesper/image-core";
import { characters, db } from "../db";
import {
  hasAnyImageProvider,
  hasImageProviderForModel,
  isDemoMode,
  qualifiedImageModelIdentity,
} from "../ai";
import { runImagePipeline } from "./assets";
import { deleteOwnedImage } from "./asset-deletion";
import { loadDefaultWardrobeWithRevisions, type AvatarWardrobeLoad } from "./avatar";
import { toWornInputs } from "./avatar-wardrobe";
import { loadBodyReferencesForBuild, type LoadedBodyReference } from "./body-reference-store";
import {
  buildCharacterPromptProgram,
  characterPromptSendsBodyReferences,
  characterPromptTransport,
  characterPromptUnboundRefusal,
  type CharacterPromptProgram,
  type CharacterPromptReference,
} from "./character-prompt-program";
import { identityPackRenderReferences } from "./identity-pack-consume";
import { resolveImageProfileForTask } from "./model-profiles";
import { resolveIntimateRoute } from "./nsfw-lora";
import { renderAttemptMeta, renderImageIntent } from "./render-intent";
import { buildStandaloneSubjectCut, standaloneSubjectPromptCut, type StandaloneSubjectCut } from "./standalone-subject-visual";
import { loadConsumableReferenceView, REFERENCE_VIEW_DROPPED_FOR_CAPACITY } from "./reference-view-consume";
import {
  failReferenceView,
  finalizeReferenceView,
  readAcceptedPortraitSource,
  REFERENCE_VIEW_UPSTREAM_UNAPPROVED,
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
 *    reads fully bare and the adapter's exposure facts state it. This lane
 *    writes no nudity sentence of its own — the coverage does, worded by the
 *    resolved model's dialect.
 * 3. **A bare view takes the intimate route**, resolved the way the `nsfw_test`
 *    variant kind resolves it (`nsfw-lora.ts`), because the scenes that consume
 *    these views take the same route and a reference rendered on different
 *    weights anchors a body the consumer cannot reproduce. On a model the
 *    intimate-route policy lists, that is the resolved `variant` profile
 *    itself, with the model's curated anatomy LoRA only when one resolves; on
 *    every other model it is the anatomy LoRA on the intimate model.
 * 4. **Nothing here can fail an accept.** Every refusal is a value with a code:
 *    a moderated bare view fails its own row and the other seven carry on, a
 *    character with no accepted portrait builds nothing and says so, and the
 *    job never throws out of itself.
 *
 * A view with an upstream in the build order (`referenceViewUpstream`) renders
 * with that view's approved current attempt beside the identity pack, as an
 * OPTIONAL identity reference of the same person: the pack's anchors stay first
 * and required, and the upstream is cut to the model's capacity like any
 * optional reference. It is read through the one consumable seam
 * (`loadConsumableReferenceView`) before anything is reserved, and the
 * reservation confirms under the character lock that it is still the approved
 * attempt — so a view is never rendered from a body the owner has not approved.
 *
 * The character's BODY IMAGES (#671) ride behind both, as optional `body`
 * references routed by the view's wardrobe (`referenceViewBodyReferences`):
 * a dressed view takes every one, dressed first, and an undressed view takes
 * the undressed ones. They are read once per job like the portrait, the row
 * records the set it was rendered against, and the reservation confirms under
 * the lock that the set has not moved — so a view is never rendered from body
 * images the owner has since changed. They are never identity references: the
 * portrait owns the face.
 *
 * The age gate is a GATE, in {@link plannedReferenceViews}, and it runs before
 * anything is reserved — a character whose image age band is not a recognized
 * adult one simply has no bare slots to build. Nothing about it reaches a model.
 */

/** The one live spelling of the diagnostic scope, so the drain and the codes agree. */
const SCOPE = "images.reference_views";

/** A view's render failed. The expected instance is a moderated bare view. */
export const REFERENCE_VIEW_BUILD_FAILED = `${SCOPE}.build_failed`;

/** Defined beside the reservation, which pushes it too; re-exported for the lane's readers. */
export { REFERENCE_VIEW_UPSTREAM_UNAPPROVED };

/**
 * A body image this view would have sent did not ride the render: the model's
 * capacity, the profile's reference policy or the resolved dialect left no
 * place for it (`context.reason`). The view renders from the rest and records
 * only what was sent.
 */
export const REFERENCE_VIEW_BODY_REFERENCE_DROPPED = `${SCOPE}.body_reference_dropped`;

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
  /** The sendable body images with their bytes, read once for the whole pass. */
  readonly bodyReferences: readonly LoadedBodyReference[];
  /**
   * Every sendable body image, readable or not — each row this pass reserves
   * records the key of the ones routed to its view (`referenceViewBodySetKey`).
   */
  readonly bodySendable: readonly BodyReferenceImage[];
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

  if (isDemoMode() || !hasAnyImageProvider()) {
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
  // Read once, like the portrait's bytes: every view in the pass sends from the
  // same set, and every row records it.
  const body = await loadBodyReferencesForBuild({ characterId, ownerId, profile, sink });
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
    bodyReferences: body.loaded,
    bodySendable: body.sendable,
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
 * written to that contract. A defect that does throw still waits for every
 * sibling to settle and release its lease before failing the whole pass loudly,
 * rather than being counted as a refusal.
 *
 * Extracted so the concurrency promise can be exercised on its own: the claim is
 * about the fan-out, not about the database underneath one view.
 */
export async function runReferenceViewBuilds(
  targets: readonly ReferenceView[],
  buildOne: (target: ReferenceView) => Promise<boolean>,
): Promise<{ built: number; failed: number }> {
  const settled = await Promise.allSettled(targets.map((target) => buildOne(target)));
  let built = 0;
  let failed = 0;
  let rejected: PromiseRejectedResult | undefined;
  for (const result of settled) {
    if (result.status === "rejected") {
      rejected ??= result;
      continue;
    }
    if (result.value) built += 1;
    else failed += 1;
  }
  if (rejected) throw rejected.reason;
  return { built, failed };
}

// ---------------------------------------------------------------------------
// One view
// ---------------------------------------------------------------------------

/**
 * The bare view's model and weights (null on a listed model rendering without
 * its anatomy LoRA) and what its row records about them, or the reason this one
 * view cannot be rendered.
 */
type BareRoute =
  | {
      ok: true;
      profile: ResolvedImageProfile;
      binding: ImageLoraRenderBinding | null;
      provenance: IntimateRouteProvenance;
    }
  | { ok: false; error: string };

/**
 * A bare view's intimate route, exactly the `nsfw_test` variant kind's
 * (`resolveNsfwTestRoute` in `variants.ts`) and failing for its reason: a
 * reference the consumers cannot reproduce is worse than a missing one, so a
 * missing leg of the intimate-model pairing fails THIS view — regenerable later
 * — and leaves the clothed views untouched. A model the intimate-route policy
 * lists has no leg to miss: it renders on the resolved profile either way.
 */
async function resolveBareRoute(profile: ResolvedImageProfile, sink: DiagnosticSink): Promise<BareRoute> {
  const route = await resolveIntimateRoute(profile, sink);
  if (!route.ok) return { ok: false, error: `the anatomy LoRA is unavailable (${route.leg}): ${route.message}` };
  return { ok: true, profile: route.profile, binding: route.binding, provenance: route.provenance };
}

/**
 * Whether a build started now would SEND body images to dressed and to
 * undressed views — the profile and the bare route the build itself resolves
 * (`resolveImageProfileForTask("variant")`, then {@link resolveBareRoute}),
 * judged by the prompt seam's own rule (`characterPromptSendsBodyReferences`:
 * the role policy, and a dialect that words the role).
 *
 * A fact about the deployment's current image model, not about the character
 * and not about staleness: an admin who switches the `variant` default to a
 * model that takes no body image, or a bare view routed to an anatomy-LoRA
 * model, sends none — and the studio must say so rather than claim the images
 * are in use. Read once per sheet read, outside the character lock. Never
 * throws: a route that does not resolve sends nothing, and a read that failed
 * outright is null — unknown, which the studio says nothing about.
 */
export async function referenceViewBodyRoutes(): Promise<BodyReferenceRoutes | null> {
  // The routes' own diagnostics belong to a build, not to a read of the sheet.
  const quiet = new DiagnosticCollector();
  try {
    const picked = await resolveImageProfileForTask("variant", undefined, quiet);
    if (picked === null) return { clothed: false, bare: false };
    const sends = (profile: ResolvedImageProfile): boolean =>
      characterPromptSendsBodyReferences({ profile, task: "variant", bindingProfileKey: profile.profile.key });
    const bare = await resolveBareRoute(picked, quiet);
    return { clothed: sends(picked), bare: bare.ok && sends(bare.profile) };
  } catch (error) {
    log.warn("images", "the body-image routes could not be resolved for a sheet read", {
      error: error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300),
    });
    return null;
  }
}

/**
 * The approved view one view is built from, shaped to ride its render — the
 * attempt it came from, its asset, and the reference exactly as both the prompt
 * seam and the renderer receive it.
 */
interface UpstreamReference {
  readonly view: ReferenceView;
  /** The upstream slot's approved current attempt — the bytes this render sends. */
  readonly attemptId: string;
  /** That attempt's lineage — what the dependent row records as its upstream. */
  readonly lineageId: string;
  readonly imageId: string;
  readonly entry: CharacterPromptReference;
}

/**
 * The view this one is built from, read through the one consumable seam: null
 * for a root view, `"unapproved"` when that slot has no approved current
 * attempt to send.
 *
 * The reference is an OPTIONAL identity reference of the same person, exactly
 * the shape a scene sends a view in (`scene.ts`): behind the pack's required
 * anchors, so a model with no room for it drops it rather than refusing the
 * plan. The registry's clause introduces it (`referenceViewUpstreamBinding`) —
 * a second image of one person reads as a second person unless something says
 * why it is there — and its own asset row's appearance revision tells the
 * prompt seam how much of the person it still shows, as for any view.
 */
async function loadUpstreamReference(
  context: BuildContext,
  view: ReferenceView,
): Promise<UpstreamReference | null | "unapproved"> {
  const upstream = referenceViewUpstream(view);
  if (upstream === null) return null;
  const description = referenceViewUpstreamBinding(view);
  const loaded = await loadConsumableReferenceView({
    ownerId: context.ownerId,
    characterId: context.characterId,
    view: upstream,
    sink: context.sink,
  });
  if (!loaded.ok || description === null) {
    context.sink.push(
      diag("warn", REFERENCE_VIEW_UPSTREAM_UNAPPROVED, "the view this one is built from is not approved, so it was not rendered", {
        path: SCOPE,
        context: {
          characterId: context.characterId,
          angle: view.angle,
          wardrobe: view.wardrobe,
          upstreamAngle: upstream.angle,
          upstreamWardrobe: upstream.wardrobe,
          reason: loaded.ok ? "no_binding" : loaded.reason,
        },
      }),
    );
    return "unapproved";
  }
  return {
    view: upstream,
    attemptId: loaded.attemptId,
    lineageId: loaded.lineageId,
    imageId: loaded.imageId,
    entry: {
      reference: {
        role: "identity",
        required: false,
        buffer: loaded.buffer,
        sourceImageId: loaded.imageId,
        name: context.name,
      },
      subjectId: context.characterId,
      description,
      appearanceRevision: loaded.appearanceRevision,
    },
  };
}

/** One body image shaped to ride a view's render, beside the stored facts its meta records. */
interface BodyReferenceEntry {
  readonly image: LoadedBodyReference;
  readonly entry: CharacterPromptReference;
}

/**
 * The body images this view sends, in send order (`referenceViewBodyReferences`):
 * each an OPTIONAL `body` reference of the character — never an identity one,
 * so no dialect counts it among the images the face comes from — with no
 * appearance revision, because the reference-authority selection concerns
 * identity images alone and a body image never supersedes the text.
 */
function bodyReferenceEntries(context: BuildContext, view: ReferenceView): BodyReferenceEntry[] {
  const routed = referenceViewBodyReferences(view, context.bodyReferences);
  return routed.flatMap((routedImage): BodyReferenceEntry[] => {
    const image = context.bodyReferences.find((loaded) => loaded.imageId === routedImage.imageId);
    if (image === undefined) return [];
    return [
      {
        image,
        entry: {
          reference: {
            role: "body",
            required: false,
            buffer: image.buffer,
            sourceImageId: image.imageId,
            name: context.name,
          },
          subjectId: context.characterId,
        },
      },
    ];
  });
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

  // Read before anything is reserved: a slot whose upstream is not approved
  // keeps whatever it shows now, spends nothing, and builds on that view's next
  // approval.
  const upstream = await loadUpstreamReference(context, view);
  if (upstream === "unapproved") return false;
  const bodyEntries = bodyReferenceEntries(context, view);

  const viewId = await reserveReferenceView({
    jobId: context.jobId,
    characterId,
    ownerId,
    view,
    sourceImageId: context.acceptedImageId,
    sourceContentHash: context.sourceContentHash,
    upstreamViewId: upstream?.lineageId ?? null,
    // The set routed to THIS view, by the function the sheet compares with.
    bodyReferenceSet: referenceViewBodySetKey(view.wardrobe, context.bodySendable),
    // An upstream that moved after the read above is refused with its own
    // diagnostic, so this lane never spends a charge in silence.
    sink,
  });
  // The character can cross the age gate after the job was admitted, the
  // upstream view can be replaced while this worker waited, and the owner can
  // change the body images. The reservation rechecks all three under the
  // character lock and spends nothing for a slot that is no longer eligible,
  // no longer has that approved upstream, or would render a body-image set
  // that is no longer the character's.
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
  // The pack's references first — required, unchanged — then the optional
  // references this view renders beside them: the upstream view, then the body
  // images. One list, handed to the prompt seam, whose planned send list is
  // exactly what the renderer receives.
  const references: readonly CharacterPromptReference[] =
    packSelection === null
      ? []
      : [
          ...packSelection.references.map((entry) => ({
            reference: entry.reference,
            subjectId: characterId,
            // The accepted portrait's own stamp (issue #551).
            appearanceRevision: entry.appearanceRevision,
          })),
          ...(upstream === null ? [] : [upstream.entry]),
          ...bodyEntries.map((body) => body.entry),
        ];

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
          references,
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
  // Whether the upstream actually rides this render. Planning returns the same
  // reference objects it was handed, so membership is identity. A view the
  // upstream never reached does not depend on it and records none.
  const upstreamSent = upstream !== null && compiled !== null && compiled.sentReferences.includes(upstream.entry.reference);
  if (upstream !== null && compiled !== null && !upstreamSent) {
    sink.push(
      diag("info", REFERENCE_VIEW_DROPPED_FOR_CAPACITY, `the ${upstream.view.angle} reference view did not fit this model's reference capacity`, {
        path: SCOPE,
        context: { characterId, angle: upstream.view.angle, wardrobe: upstream.view.wardrobe, for: `${view.angle}:${view.wardrobe}` },
      }),
    );
  }
  // The same honesty rule for the body images: only those the render actually
  // carries are recorded, and every one it could not carry is said, with why.
  const sentReferences: readonly ImageRenderReference[] = compiled?.sentReferences ?? [];
  const sentBody = bodyEntries.filter((body) => sentReferences.includes(body.entry.reference));
  if (compiled !== null) {
    for (const body of bodyEntries) {
      if (sentBody.includes(body)) continue;
      const dropped = compiled.droppedReferences.find((entry) => entry.reference === body.entry.reference);
      sink.push(
        diag("info", REFERENCE_VIEW_BODY_REFERENCE_DROPPED, "a body image did not ride this view's render", {
          path: SCOPE,
          context: {
            characterId,
            imageId: body.image.imageId,
            slot: body.image.slot,
            tag: body.image.tag,
            reason: dropped?.reason ?? "model_capacity",
            for: `${view.angle}:${view.wardrobe}`,
          },
        }),
      );
    }
  }

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
          // The approved view this one was rendered from, recorded only when it
          // was actually sent — the identity provenance's honesty rule.
          ...(upstream !== null && upstreamSent
            ? {
                upstream: {
                  angle: upstream.view.angle,
                  wardrobe: upstream.view.wardrobe,
                  attemptId: upstream.attemptId,
                  // What the row records: the attempt a restored copy came from.
                  lineageId: upstream.lineageId,
                  imageId: upstream.imageId,
                },
              }
            : {}),
          // The body images this view was rendered from, by slot, id and tag —
          // the ones actually sent, never the ones configured.
          ...(sentBody.length > 0
            ? { bodyReferences: sentBody.map((body) => ({ slot: body.image.slot, imageId: body.image.imageId, tag: body.image.tag })) }
            : {}),
        },
        model: qualifiedImageModelIdentity(resolved?.model),
        // The weights this view ran on, by id and never the locator, and the
        // route's own record — the LoRA it sent or null, and why. Bare views
        // only; a clothed view takes no intimate route.
        ...(bareRoute?.ok === true
          ? {
              ...(bareRoute.binding === null ? {} : { lora: bareRoute.binding.id }),
              intimateRoute: bareRoute.provenance,
            }
          : {}),
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
          // Exactly the list the prompt was compiled against: a body image the
          // resolved dialect cannot word was dropped before planning, and must
          // not reach the payload the prompt does not describe.
          references: [...compiled.sentReferences],
          target: { aspectRatio: IMAGE_TARGET_ASPECT },
          ...(bareRoute?.ok === true && bareRoute.binding !== null ? { resolvedLora: bareRoute.binding } : {}),
        },
        sink,
      );
      if (!edit.ok || !edit.image) {
        const error = edit.error ?? `${resolved.model.slug} returned no image`;
        failure = error;
        return { ok: false, error, ...renderAttemptMeta(edit.attempt, edit.advisories) };
      }
      return { ok: true, image: edit.image, ...renderAttemptMeta(edit.attempt, edit.advisories) };
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
    upstreamViewId: upstream !== null && upstreamSent ? upstream.lineageId : null,
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
  if (!hasImageProviderForModel(inputs.resolved.model)) {
    return `the ${qualifiedImageModelIdentity(inputs.resolved.model)} provider is not configured`;
  }
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
