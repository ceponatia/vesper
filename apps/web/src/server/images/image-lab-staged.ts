import { and, eq } from "drizzle-orm";
import {
  type ImageLabInput,
  imageLabStagedSceneRecipeProfile,
  type ImageLabStaging,
  type ImageModel,
  type ImageRenderReference,
  type ResolvedImageProfile,
  isImageLabControlRole,
  referenceCapacity,
  withReviewedImageQuality,
} from "@vesper/image-core";
import type { DiagnosticSink } from "@/contracts/diagnostics";
import { characterSceneImageOperation, type CharacterWorldReadInput } from "@/contracts/images/character-digest";
import { sceneStagingById, type SceneStaging } from "@/contracts/images/scene-staging";
import type { RegionExposure } from "@/contracts/items/visibility";
import { db, images } from "../db";
import {
  buildCharacterPromptProgram,
  type CharacterPromptProgramResult,
  type CharacterPromptReference,
} from "./character-prompt-program";
import {
  carriesRawProviderBag,
  labFailure,
  RAW_BAG_REFUSAL,
  readOrderedInputBytes,
  resolvePinnedLabModel,
  runRecipeIntent,
  settleFailed,
  UNDECLARED_CONTROL_ROLE,
} from "./image-lab-render";
import { type StagedSubjectCut, stagedSubjectExposure, tryBuildStagedSubjectVisual } from "./image-lab-staged-visual";
import {
  type ImageLabExperimentRow,
  type ImageLabRunPayload,
  LAB_PROFILE_UNAVAILABLE,
  labCharacterNames,
  labCharacterSheet,
  storedInputs,
  storedSettings,
  storedStaging,
} from "./image-lab-store";
import { loadImageModelProfilesForTask } from "./model-profiles";
import { emptySceneSpec, type ScenePresentCharacter } from "./prompts-scene-composer";
import { resolveScenePlan, type SceneRenderPlan } from "./prompts-scene-plan";
import { heuristicLighting } from "./scene";
import { lowerScenePlan } from "./scene-lowering";

/**
 * The `staged_scene` lane — the one kind whose PROMPT is compiled from a registry
 * and a committed cut rather than typed by the admin.
 *
 * It benches one intimate staging: the same compiled program and the same LoRA
 * binding the chat lane sends, with no chat, no composer and no narration to
 * steer. That is a question the chat lane cannot ask at all — production only
 * reaches an intimate render when the composer PROPOSES a staging and quotes
 * narration verbatim for it, so grading one today means playing a chat until the
 * composer cooperates. Here the staging is chosen outright.
 *
 * Parity with production is the whole point, and it is reuse rather than
 * reimplementation on every half:
 *
 * - **The words** are a compiled prompt program — the exact program the chat
 *   scene lane's single-reference `edit` rung compiles (`scene.ts`), built by
 *   {@link stagedSceneProgram} over the same seams: `resolveScenePlan` for the
 *   plan, `lowerScenePlan` for the scene's typed facts, and
 *   `buildCharacterPromptProgram` for the digest, the binding, the packs, the
 *   reference plan and the compile. The registry owns every explicit phrase
 *   (the lowering adopts the staging's measured surface form); nothing here
 *   paraphrases a template, and the seam is pure so a test can pin the bench's
 *   program byte-for-byte against the chat lane's.
 * - **The subject** is a committed visual cut, realized by
 *   `image-lab-staged-visual.ts` through the same standalone assembly the
 *   avatar and variant lanes take, under the scene lane's own knobs. It is the
 *   ONLY thing the program says about the person, exactly as in a chat.
 * - **The LoRA** rides `settings.controls.lora`, which {@link runRecipeIntent}
 *   already resolves through `resolveImageLoraForRender` — the same seam, the
 *   same library gates, the same curated scale band and the same `image_lora.*`
 *   refusals as the chat route. There is deliberately no second binding path
 *   here to drift from that one.
 *
 * `resolveIntimateSceneLoraRoute` is NOT called, and its absence is the design
 * rather than an oversight: its facts (`allowIntimate`, `selfie`,
 * `referenceRoute`, `anchored`) are chat-shaped, and a bench row would have to
 * invent four of them to ask a question it already knows the answer to. This
 * lane states the claim directly — a staged intimate render on the pinned model
 * with the selected LoRA — and lets the library seam refuse it if that model
 * cannot carry it.
 *
 * ## Refusals, never a fallback
 *
 * A program that will not compile is a bench that cannot honestly say what it
 * is about to draw. `unbound` — no active prompt binding for this endpoint on
 * the scene task — settles under {@link STAGED_PROGRAM_UNBOUND}; a compile
 * refusal settles under the program's own `image_prompt_program.*` code, the
 * way an `image_lora.*` or `image_profile.*` refusal lands verbatim. Neither
 * falls back to a second description assembled somewhere else, because there
 * is no second description: production has none either.
 */

// --- staged scenes ---------------------------------------------------------

/**
 * The rule a staged row must satisfy before anything else is read, restated on
 * the row when it does not.
 *
 * The create schema demands the character and the render policy demands the
 * identity reference, so reaching this message means the row arrived around that
 * schema — an earlier deploy, or a caller that reached the service directly. The
 * runner stays authoritative anyway: with no subject there is no cut to compile
 * and no `{name}` to bind the staging template to, and the lowering states no
 * arrangement for a shot with no focal subject. That failure is the expensive
 * one — a paid render of somebody standing in a room, filed under a row that
 * says an act was staged.
 */
const STAGED_SUBJECT_RULE =
  "a staged scene names one character and sends exactly one identity reference of them; the staging template is written " +
  "about that person by name, and without one there is no act to render";

/** A staged row pointing at a control fixture the recipe has no slot to send. */
const STAGED_CONTROL_DECLARED =
  "a staged scene sends no control fixture: its structure is the staging's own wording, so a declared fixture could only " +
  "be recorded and never sent, leaving a record that claims a control the render never saw";

/**
 * No active prompt binding for the pinned endpoint on the scene task — the
 * binding table is where a scene's words are authorized, and an endpoint
 * missing from it is one this bench may not speak for. A code in the prompt
 * program's own family, beside `pack_missing` and `references_renumbered`,
 * because that is the layer that answered.
 */
export const STAGED_PROGRAM_UNBOUND = "image_prompt_program.unbound";

/**
 * The player's coverage this bench states for itself.
 *
 * A staged intimate act is one the viewer's own body is in, and the viewer's
 * parts are gated on the PLAYER's exposure (`resolveViewerParts`, run per rung
 * by the lowering): a covered pelvis drops `genitals`, and because a staging
 * lowers all-or-nothing — every part it names must be in frame or the
 * arrangement is not stated — a dressed viewer would quietly turn this bench
 * into an ordinary nude portrait render. So the row says the viewer is
 * undressed, in the same shape the probe that produced this evidence stated it
 * (`PLAYER_BARE` in the retired orientation A/B probe). There is no chat state
 * here to derive it from and nothing else it could honestly be.
 */
const STAGED_VIEWER_EXPOSURE: RegionExposure = { torso: "bare", pelvis: "bare", legs: "bare", feet: "bare" };

/**
 * One staged scene: a registry staging, one identity reference of the character
 * it stages, and an optional location image.
 *
 * The shape differs from every other recipe kind in exactly one way, and it is
 * the kind's whole reason for existing: the base prompt is COMPILED here from
 * the staging registry and the subject's cut instead of being the admin's
 * `instruction`. `instruction` is deliberately unread — an admin sentence would
 * compete with the registry wording that ~45 graded probe renders settled, and
 * a bench that let it through would grade a prompt nobody has evidence about.
 */
export async function runStagedScene(row: ImageLabExperimentRow, sink?: DiagnosticSink): Promise<ImageLabRunPayload> {
  const inputs = storedInputs(row, sink);
  if (inputs.length === 0) {
    return await settleFailed(row, labFailure("input_missing"), "the experiment records no ordered inputs", sink);
  }

  const identities = inputs.filter((input) => input.role === "identity");
  const characterId = row.characterId;
  if (identities.length !== 1 || characterId === null) {
    return await settleFailed(row, labFailure("input_missing"), STAGED_SUBJECT_RULE, sink);
  }

  // Owner-scoped, and read BEFORE the version is resolved, for the two-character
  // lane's reason: a subject this owner does not have is a fact about the row
  // that no amount of provider work would change, and the name is not decoration
  // — it is the `{name}` every clause of the staging template is written around.
  const cast = await labCharacterNames([characterId], row.ownerId);
  if (!cast) {
    return await settleFailed(
      row,
      labFailure("input_missing"),
      "this experiment names a character this owner does not have, so the staged act has nobody to be about",
      sink,
    );
  }
  // `characters.name` is not guaranteed non-blank, and a blank one is worse here
  // than anywhere else in the lab: `{name}` would bind to nothing, the program
  // would label its one subject with an empty string, and the render would come
  // back looking like a model that ignored the act. Refused rather than papered
  // over, naming the fix — the same answer the two-character cast check gives
  // for the same class of unusable label.
  const subject = (cast.get(characterId) ?? "").trim();
  if (!subject) {
    return await settleFailed(
      row,
      labFailure("subject_invalid"),
      `character ${characterId} has no name, and every clause of a staging template is written about the subject by name; name that character before benching a staging on them`,
      sink,
    );
  }

  const scene = storedStaging(row, sink);
  if (!scene) {
    return await settleFailed(
      row,
      labFailure("subject_invalid"),
      "the experiment records no staging; the registry owns the words, so with no id there is no act to render",
      sink,
    );
  }
  // The wire carries a plain string because the registry is app-side and a
  // package may not reach it (`imageLabStagingSchema`), so THIS is where
  // membership is checked. The id is echoed because it is the whole of what went
  // wrong: an admin reading the row can see which entry the catalog no longer
  // has, which is what a renamed or retired staging looks like from here.
  const entry = sceneStagingById(scene.id);
  if (!entry) {
    return await settleFailed(
      row,
      labFailure("subject_invalid"),
      `no staging in the registry answers to "${scene.id}", so nothing here can say what act this experiment was for`,
      sink,
    );
  }

  const resolved = await resolvePinnedLabModel(row.modelSlug, "a staged scene", sink);
  if (!resolved.ok) {
    return await settleFailed(row, labFailure("version_unpinned"), resolved.message, sink);
  }
  const { model, versionId } = resolved;
  const columns = { requestedVersionId: versionId, modelSlug: model.slug };

  // A staged scene declares NO fixture, so both halves of the control question
  // are refusals rather than arms. A DECLARED fixture is a record the recipe
  // cannot honour; an UNDECLARED control role among the inputs is the
  // uncontrolled two-character arm's refusal, reached the same way — a skeleton
  // riding along that the record does not name.
  if (row.controlImageId !== null || row.controlKind !== null) {
    return await settleFailed(row, labFailure("control_invalid"), STAGED_CONTROL_DECLARED, sink, { columns });
  }
  if (inputs.some((input) => isImageLabControlRole(input.role))) {
    return await settleFailed(row, labFailure("control_invalid"), UNDECLARED_CONTROL_ROLE, sink, { columns });
  }

  const settings = storedSettings(row, sink);
  if (carriesRawProviderBag(settings)) {
    return await settleFailed(row, labFailure("settings_unsupported"), RAW_BAG_REFUSAL, sink, { columns });
  }

  // The identity reference is the only REQUIRED one, so this is a one-slot check
  // — and it still earns its place, because a model with no reference capacity
  // at all would otherwise reach the planner and come back with an
  // `image_profile.*` refusal about a dropped required role. The lab's own
  // vocabulary says the same thing in words the panel already explains, and says
  // it before eligibility, the LoRA read and the program compile spend any work.
  // Read through the reviewed-quality overlay for the two-character kind's
  // reason: it is what keeps this check about the model the provider is handed.
  const effectiveModel = withReviewedImageQuality(model);
  const capacity = referenceCapacity(effectiveModel);
  if (identities.length > capacity.max) {
    return await settleFailed(
      row,
      labFailure("capacity_exceeded"),
      `${effectiveModel.slug} accepts ${String(capacity.max)} reference image(s) and a staged scene requires its one identity reference; the act is staged on a named person or not at all`,
      sink,
      { columns },
    );
  }

  // The subject's own cut, from their sheet. Placed after the shape checks
  // above and before the byte reads: a row that declares a fixture this recipe
  // cannot send is malformed whatever its character sheet says, and those
  // refusals should keep naming the malformation — but no S3 read or provider
  // call should be spent on a subject the program cannot describe.
  const sheet = await labCharacterSheet(characterId, row.ownerId, sink);
  if (!sheet) {
    return await settleFailed(
      row,
      labFailure("input_missing"),
      "this experiment names a character this owner does not have, so the staged act has nobody to be about",
      sink,
      { columns },
    );
  }
  const visual = tryBuildStagedSubjectVisual(
    { characterId, name: subject, profile: sheet.profile, revision: sheet.revision, entry },
    sink,
  );
  // No fall back to a name-only render: a prompt production never sends would
  // answer a different question than this row asks, and a bench row that looked
  // like it ran would corrupt the comparison it exists to feed.
  if (!visual.ok) {
    return await settleFailed(row, labFailure("visual_digest_unavailable"), visual.refusal, sink, { columns });
  }

  const read = await readOrderedInputBytes(inputs, row.ownerId);
  if (!read.ok) {
    return await settleFailed(row, labFailure("input_missing"), read.message, sink, { columns });
  }
  // The bytes are readable and this owner's; whose FACE they are is a separate
  // question, and one this kind has to ask because the prompt names the subject
  // in every clause. Asked after the read so an unreadable image keeps reporting
  // as the missing input it is.
  const misbound = await identityImageSubjectRefusal(identities[0], characterId, row.ownerId);
  if (misbound) {
    return await settleFailed(row, labFailure("subject_invalid"), misbound, sink, { columns });
  }

  // The identity reference is required — it is the likeness the whole render is
  // an edit of — and the location is not: planning may drop it to fit a narrow
  // model and record the drop, where dropping the face would leave a staged act
  // happening to a stranger. No `subject` on either: the program binds the
  // identity image to its subject itself (`CharacterPromptReference.subjectId`),
  // and a solo bench has no second face for a transport-level subject label to
  // tell apart.
  const references: ImageRenderReference[] = read.ordered.map(({ input, buffer }) => ({
    role: input.role,
    buffer,
    sourceImageId: input.imageId,
    required: input.role === "identity",
  }));

  const bindingProfileKey = await stagedSceneBindingProfileKey(model, sink);
  if (bindingProfileKey === null) {
    return await settleFailed(
      row,
      LAB_PROFILE_UNAVAILABLE,
      "no scene profile is offered on this deployment, so there is no prompt binding to compile the staged program against",
      sink,
      { columns },
    );
  }
  const recipeProfile = imageLabStagedSceneRecipeProfile(model.id, entry.id);
  const { program } = stagedSceneProgram({
    subject: visual.cut,
    entry,
    scene,
    profile: { model, profile: recipeProfile },
    bindingProfileKey,
    // The standalone read the avatar lane records for a chat-less character:
    // the row's own revision, and nothing else — the coverage is the staging's
    // premise, so no wardrobe row fed this render.
    read: { kind: "standalone_character", characters: [{ characterId, revision: sheet.revision }] },
    references,
    ...(sink === undefined ? {} : { sink }),
  });
  if (program.kind === "unbound") {
    return await settleFailed(
      row,
      STAGED_PROGRAM_UNBOUND,
      `${program.modelSlug} has no active prompt binding for the scene task under the ${program.profileKey ?? "default"} profile, so this bench has no authorized way to word the act; bind the endpoint before benching it`,
      sink,
      { columns },
    );
  }
  if (program.kind === "refused") {
    return await settleFailed(row, program.code, program.refusal, sink, { columns });
  }

  return await runRecipeIntent(row, {
    model,
    versionId,
    recipeProfile,
    // The program's OWN planned list, in its send order — the slots its prompt
    // numbers. Planning an already-planned list is a fixed point, so the recipe
    // run cannot move a slot the prompt has named.
    references: [...program.sentReferences],
    // NOT `row.instruction`: the compiled program, compiled the way the chat
    // lane compiles it. The recipe's `instruction_edit` strategy passes it
    // through untouched — the program already numbers its own references.
    prompt: program.prompt,
    // Straight through, unexamined: the merge with the recipe's own control
    // defaults and every library gate belong to the shared runner, which is what
    // makes this bench's LoRA binding the production one rather than a copy.
    // The program's compiled exclusions ride the normalized control beside
    // them, the same channel `characterPromptTransport` puts them on for the
    // chat lane; null or empty means this endpoint compiled none.
    controls:
      program.negativePrompt === null || program.negativePrompt.length === 0
        ? settings.controls
        : { ...settings.controls, negativePrompt: program.negativePrompt },
    columns,
    provenanceRole: "identity",
    fallbackSourceImageId: inputs[0]?.imageId,
    sink,
  });
}

// --- the pure seam ---------------------------------------------------------

/**
 * The render plan for one staging, assembled the way the retired orientation A/B
 * probe assembled one outside the chat lane — the ONE way, since a second would
 * be the drift this bench exists to rule out.
 *
 * `resolveScenePlan` does the assembling rather than a hand-built literal so the
 * focal spec is derived by the chat lane's own code: the outfit fallback, the
 * name normalization and every field a later slice adds arrive here for free
 * and identically. What the resolver's own GATES would decide is then
 * overwritten, exactly as the probe overwrites them, because every one of those
 * gates asks a question about a chat: the staging's evidence quote, the present
 * roster's cast fit, and the composer's camera proposal. A bench has no
 * narration to quote and no composer to clamp — the admin picked this entry
 * outright, which is the whole instrument — so the entry's own camera and viewer
 * parts are stated rather than earned.
 *
 * Everything explicit still passes the gates that are about the RENDER rather
 * than the chat: the lowering runs the staging's viewer parts through
 * `resolveViewerParts` against the coverage below and this route's intimate
 * permission, and states no arrangement if any of them falls out of frame.
 */
export function stagedScenePlan(subject: string, entry: SceneStaging, scene: ImageLabStaging): SceneRenderPlan {
  const present: ScenePresentCharacter = {
    name: subject,
    // No worn items and no described outfit: a bench states what the staging
    // needs bare and leaves the rest to the reference image. The cut's own
    // coverage readout is the staging's premise, so the program states exactly
    // those bare regions and no garment — a garment list would contradict the
    // act it is benching.
    wornVisible: [],
    exposure: stagedSubjectExposure(entry),
    // The staging gate reads the roster's coverage; stated as authoritative so
    // the plan resolves the way a chat's would for a subject undressed this far.
    wardrobeTracked: true,
  };
  const resolvedPlan = resolveScenePlan(
    {
      ...emptySceneSpec(),
      focalCharacter: subject,
      setting: scene.setting ?? "",
      // The admin's phrase, or the chat lane's own derivation from the time of
      // day — the same table, so a bench that states `night` gets the light a
      // chat at night would have got.
      lighting: scene.lighting ?? heuristicLighting(scene.timeOfDay),
    },
    {
      present: [present],
      // The lane flag the whole staged vocabulary hangs off: without it
      // `resolveScenePlan` clamps viewer parts away and the lowering states the
      // disembodied POV, which asserts the viewer's absence while the staged
      // arrangement describes their hands on somebody.
      embodiedViewer: true,
      playerExposure: STAGED_VIEWER_EXPOSURE,
    },
  );
  return {
    ...resolvedPlan,
    // A surviving staging OWNS the shot: the geometry is entailed by the act, so
    // its camera replaces the plan's rather than merging with it.
    camera: { ...entry.camera },
    staging: entry,
    // The chat resolver unions the staging's parts into whatever the composer
    // grounded; a bench proposes none of its own, so that union reduces to this
    // list — and the per-rung coverage/route gate still runs over it.
    viewerBody: [...entry.viewerParts],
  };
}

export interface StagedSceneProgramInput {
  /** The subject's realized cut, with the name the staging binds `{name}` to. */
  readonly subject: StagedSubjectCut;
  readonly entry: SceneStaging;
  readonly scene: ImageLabStaging;
  /**
   * The pinned model paired with the staged recipe profile — the profile the
   * intent runs. The program plans its references under this profile's policy,
   * so the recipe run's own planning of the program's list is a fixed point.
   */
  readonly profile: ResolvedImageProfile;
  /**
   * The production scene profile key the binding resolves on. The recipe
   * profile carries no binding row (it is a request shape, not an authorized
   * endpoint), so the key is the one a chat scene would compile this model
   * under — see `stagedSceneBindingProfileKey`.
   */
  readonly bindingProfileKey: string;
  /** What the render was asked over — the character row's revision, for a bench. */
  readonly read: CharacterWorldReadInput;
  /** The identity reference of the subject first, then any location image, in the lane's send order. */
  readonly references: readonly ImageRenderReference[];
  readonly sink?: DiagnosticSink;
}

export interface StagedSceneProgram {
  /** The plan the program was lowered from. */
  readonly plan: SceneRenderPlan;
  /** The compiled program, or the seam's own account of why there is none. */
  readonly program: CharacterPromptProgramResult;
}

/**
 * The bench's prompt program: the exact program the chat scene lane's
 * single-reference `edit` rung compiles for the same plan and cut (`scene.ts`,
 * `programFor("edit")`), argument for argument.
 *
 * - the plan is lowered with this rung's intimate permission, which for a bench
 *   is always the uncensored route: every intimate entry's arrangement is
 *   withheld without it, and a bench for the intimate LoRA whose prompt omitted
 *   the act would grade the model on the wrong picture;
 * - the reveal is spent the same way, so the cut's exposed anatomy is stated
 *   from the premise coverage exactly as a chat's rung states it from the
 *   wardrobe's;
 * - the identity reference is bound to the subject, so the dialect's slot
 *   wording names the person the act is about;
 * - **no viewer is supplied**, and that is the bench's premise rather than an
 *   omission: there is no persona behind this lens, only a coverage premise. An
 *   arrangement names every viewer part it puts in frame, so the geometry is
 *   stated by the template either way; what a chat scene adds on top is the
 *   player's own skin and build, which a bench has nobody to read;
 * - `refuseOnMissingRequired`, because a staged act on somebody with a lost
 *   identity or morphology anchor is the act happening to a stranger.
 *
 * Pure, and exported for that reason: the program this returns is the parity
 * pin — for the same plan and the same cut it must be byte-identical to what
 * the chat lane compiles, and a test can only assert that against a seam with
 * no database behind it.
 */
export function stagedSceneProgram(input: StagedSceneProgramInput): StagedSceneProgram {
  const { subject, sink } = input;
  const plan = stagedScenePlan(subject.name, input.entry, input.scene);
  const lowered = lowerScenePlan({
    plan,
    cast: [{ subjectId: subject.subjectId, name: subject.name }],
    allowIntimate: true,
    ...(sink === undefined ? {} : { sink }),
  });
  const program = buildCharacterPromptProgram({
    lane: "scene",
    task: "scene",
    profile: input.profile,
    bindingProfileKey: input.bindingProfileKey,
    bindingStrategy: "instruction_edit",
    cuts: [subject],
    scene: lowered.scene,
    location: lowered.location,
    camera: lowered.camera,
    intimateReveal: true,
    read: input.read,
    references: input.references.map(
      (reference): CharacterPromptReference =>
        reference.role === "identity" ? { reference, subjectId: subject.subjectId } : { reference },
    ),
    operation: () => characterSceneImageOperation({ subjectCount: 1, kind: "edit" }),
    refuseOnMissingRequired: true,
    ...(sink === undefined ? {} : { sink }),
  });
  return { plan, program };
}

/**
 * The production scene profile key the bench's program binds on.
 *
 * A binding row is keyed by the endpoint, the task and a PROFILE KEY, and the
 * staged recipe profile (`staged_scene/<id>`) carries no row — it is a request
 * shape, not an endpoint the binding table authorizes words for. The honest key
 * is the one a chat scene would compile this model under: the pinned model's
 * own offered scene profile, and where it has none — the LoRA wrapper, which
 * sits on no picker — the scene task's default profile, exactly the row
 * `resolveIntimateSceneLoraRoute` keeps when it swaps a chat render onto the
 * wrapper (`pairProfileWithNsfwLora`). Null when the deployment offers the
 * scene task no profile at all, which is the chat lane's own `none_offered`
 * failure.
 */
async function stagedSceneBindingProfileKey(model: ImageModel, sink?: DiagnosticSink): Promise<string | null> {
  const offered = await loadImageModelProfilesForTask("scene", sink);
  const own = offered.filter((candidate) => candidate.model.id === model.id);
  const picked =
    own.find((candidate) => candidate.profile.isDefault) ??
    own[0] ??
    offered.find((candidate) => candidate.profile.isDefault) ??
    offered[0];
  return picked?.profile.key ?? null;
}

/**
 * Why this identity input's IMAGE cannot stand for the character the row names —
 * or `null` when it can.
 *
 * The two-character kind asks this to keep two faces from swapping names; a
 * staged scene asks it for a different reason, and the answer matters just as
 * much. The compiled prompt says "Sabrina astride the viewer…" in the registry's
 * own words while the edit anchors on whatever bytes the identity slot holds, so
 * a mismatched portrait produces a render of one person under another's name —
 * and the bench's verdict ("did this staging work for this character?") would be
 * about a request nobody made. Nothing upstream establishes it: the create path
 * checks that the caller owns the character, the byte read checks that they own
 * the image, and neither asks whether those pixels depict that person.
 *
 * `images.entityKind`/`entityId` is the association the app already keeps, and
 * the portrait listing the lab's picker reads (`listOwnedPortraits`) selects on
 * exactly those two columns, so every image a form can offer for the slot passes
 * here.
 */
async function identityImageSubjectRefusal(
  identity: ImageLabInput | undefined,
  characterId: string,
  ownerId: string,
): Promise<string | null> {
  if (!identity) return null;
  const [image] = await db()
    .select({ entityKind: images.entityKind, entityId: images.entityId })
    .from(images)
    .where(and(eq(images.id, identity.imageId), eq(images.ownerId, ownerId)))
    .limit(1);
  if (image?.entityKind === "character" && image.entityId === characterId) return null;
  return `the identity image at position ${String(identity.position)} is not a render of character ${characterId}, so this bench would stage the act on one person's face under another's name`;
}
