import { and, eq } from "drizzle-orm";
import {
  type ImageLabInput,
  imageLabStagedSceneRecipeProfile,
  type ImageLabStaging,
  type ImageRenderReference,
  isImageLabControlRole,
  referenceCapacity,
  withReviewedImageQuality,
} from "@vesper/image-core";
import type { DiagnosticSink } from "@/contracts/diagnostics";
import { sceneStagingById, type SceneStaging } from "@/contracts/images/scene-staging";
import type { RegionExposure } from "@/contracts/items/visibility";
import { db, images } from "../db";
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
import {
  REFERENCE_ONLY_SUBJECT_FACTS,
  type StagedSubjectFacts,
  stagedSubjectExposure,
  tryBuildStagedSubjectVisual,
} from "./image-lab-staged-visual";
import {
  type ImageLabExperimentRow,
  type ImageLabRunPayload,
  labCharacterNames,
  labCharacterSheet,
  stagedSubjectFactsMode,
  storedInputs,
  storedSettings,
  storedStaging,
} from "./image-lab-store";
import { emptySceneSpec, type ScenePresentCharacter } from "./prompts-scene-composer";
import { resolveScenePlan, type SceneRenderPlan } from "./prompts-scene-plan";
import { buildSceneRenderPrompt } from "./prompts-scene-render";
import { heuristicLighting } from "./scene";

/**
 * The `staged_scene` lane — the one kind whose PROMPT is compiled from a registry
 * rather than typed by the admin.
 *
 * It benches one intimate staging: the same compiled wording and the same LoRA
 * binding the chat lane sends, with no chat, no composer and no narration to
 * steer. That is a question the chat lane cannot ask at all — production only
 * reaches an intimate render when the composer PROPOSES a staging and quotes
 * narration verbatim for it, so grading one today means playing a chat until the
 * composer cooperates. Here the staging is chosen outright.
 *
 * Parity with production is the whole point, and it is reuse rather than
 * reimplementation on both halves:
 *
 * - **The words** come from `buildSceneRenderPrompt` applied to a
 *   {@link SceneRenderPlan} this lane assembles, exactly as
 *   `scripts/eval/scene-images/orientation-ab.ts` assembles one outside the chat
 *   lane. The registry owns every explicit phrase; nothing here paraphrases a
 *   template, and {@link stagedSceneWords} is the single seam a test can pin
 *   byte-for-byte against the chat resolver's own plan.
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
 * - **The SUBJECT's facts** come from the character's visual digest on the
 *   default arm (owner ruling 2026-08-25), assembled by
 *   `image-lab-staged-visual.ts` through the same standalone seam the avatar and
 *   variant lanes take and under the chat scene lane's own policy. That is the
 *   third half of the parity claim, and it was missing until this ruling: the
 *   kind was built name-only, which was already recorded as a deliberate gap
 *   and became a parity BREAK once the chat lane
 *   moved its own character fields onto the digest. The `reference_only` arm
 *   keeps the name-only behavior as an explicit ablation — the only way to ask
 *   whether the textual anchors help or fight the identity reference — and is
 *   never reached by degradation, only by an operator choosing it.
 */

// --- staged scenes ---------------------------------------------------------

/**
 * The rule a staged row must satisfy before anything else is read, restated on
 * the row when it does not.
 *
 * The create schema demands the character and the render policy demands the
 * identity reference, so reaching this message means the row arrived around that
 * schema — an earlier deploy, or a caller that reached the service directly. The
 * runner stays authoritative anyway: with no subject there is no `{name}` to
 * bind the staging template to, and the prompt builder answers a nameless focal
 * by dropping the staged sentence ENTIRELY. That failure is the expensive one —
 * a paid render of somebody standing in a room, filed under a row that says an
 * act was staged.
 */
const STAGED_SUBJECT_RULE =
  "a staged scene names one character and sends exactly one identity reference of them; the staging template is written " +
  "about that person by name, and without one there is no act to render";

/** A staged row pointing at a control fixture the recipe has no slot to send. */
const STAGED_CONTROL_DECLARED =
  "a staged scene sends no control fixture: its structure is the staging's own wording, so a declared fixture could only " +
  "be recorded and never sent, leaving a record that claims a control the render never saw";

/**
 * The player's coverage this bench states for itself.
 *
 * A staged intimate act is one the viewer's own body is in, and the viewer's
 * parts are gated on the PLAYER's exposure (`resolveViewerParts`): a covered
 * pelvis drops `genitals`, and because a staging emits all-or-nothing — every
 * part it names must be in frame or the sentence is suppressed — a dressed
 * viewer would quietly turn this bench into an ordinary nude portrait render.
 * So the row says the viewer is undressed, in the same shape the probe that
 * produced this evidence states it (`orientation-ab.ts`'s `PLAYER_BARE`). There
 * is no chat state here to derive it from and nothing else it could honestly be.
 */
const STAGED_VIEWER_EXPOSURE: RegionExposure = { torso: "bare", pelvis: "bare", legs: "bare", feet: "bare" };

/**
 * One staged scene: a registry staging, one identity reference of the character
 * it stages, and an optional location image.
 *
 * The shape differs from every other recipe kind in exactly one way, and it is
 * the kind's whole reason for existing: the base prompt is COMPILED here from
 * the staging registry instead of being the admin's `instruction`. `instruction`
 * is deliberately unread — an admin sentence would compete with the registry
 * wording that ~45 graded probe renders settled, and a bench that let it through
 * would grade a prompt nobody has evidence about.
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
  // than anywhere else in the lab: `{name}` would bind to nothing, the prompt
  // builder would drop the staged sentence for a nameless focal, and the render
  // would come back looking like a model that ignored the act. Refused rather
  // than papered over, naming the fix — the same answer the two-character cast
  // check gives for the same class of unusable label.
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
  // it before eligibility, the LoRA read and the recipe compile spend any work.
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

  // The subject's own facts, on the arm this row RECORDED (an absent arm means
  // the row predates the choice and ran name-only). Placed after the shape
  // checks above and before the byte reads: a row that declares a fixture this
  // recipe cannot send is malformed whatever its character sheet says, and those
  // refusals should keep naming the malformation — but no S3 read or provider
  // call should be spent on a subject the prompt cannot describe.
  //
  // The ablation arm reads NOTHING but the name, which is not an optimization:
  // its whole claim is that the prompt carries no textual subject facts, and a
  // profile read it did not use would be a claim nobody could check.
  let facts: StagedSubjectFacts = REFERENCE_ONLY_SUBJECT_FACTS;
  if (stagedSubjectFactsMode(row, sink) === "production_parity") {
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
    // No fall back to the ablation: an arm the operator did not choose would
    // answer a different question than this row asks, and a bench row that
    // looked like it ran would corrupt the comparison it exists to feed.
    if (!visual.ok) {
      return await settleFailed(row, labFailure("visual_digest_unavailable"), visual.refusal, sink, { columns });
    }
    facts = visual.facts;
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
  // an edit of — and the location is not: `planImageRender` may drop it to fit a
  // narrow model and record the drop, where dropping the face would leave a
  // staged act happening to a stranger. No `subject` on either: that field's
  // wording ("one of the people this render depicts") is written for the
  // two-character send, and a solo bench asserting a cast of several would
  // contradict the prompt's own person-count assertion.
  const references: ImageRenderReference[] = read.ordered.map(({ input, buffer }) => ({
    role: input.role,
    buffer,
    sourceImageId: input.imageId,
    required: input.role === "identity",
  }));

  return await runRecipeIntent(row, {
    model,
    versionId,
    recipeProfile: imageLabStagedSceneRecipeProfile(model.id, entry.id),
    references,
    // NOT `row.instruction`: the words are the registry's, compiled the way the
    // chat lane compiles them. The recipe's compose strategy prefixes its
    // numbered role bindings to this, exactly as it does for every other recipe.
    prompt: stagedSceneWords(subject, entry, scene, facts).prompt,
    // Straight through, unexamined: the merge with the recipe's own control
    // defaults and every library gate belong to the shared runner, which is what
    // makes this bench's LoRA binding the production one rather than a copy.
    controls: settings.controls,
    columns,
    provenanceRole: "identity",
    fallbackSourceImageId: inputs[0]?.imageId,
    sink,
  });
}

/** The plan a staged bench renders, and the prompt compiled from it. */
export interface StagedSceneWords {
  plan: SceneRenderPlan;
  prompt: string;
}

/**
 * The render plan and final prompt for one staging, assembled the way
 * `orientation-ab.ts` assembles one outside the chat lane — the ONE way, since a
 * second would be the drift this bench exists to rule out.
 *
 * `resolveScenePlan` does the assembling rather than a hand-built literal so the
 * focal spec is derived by the chat lane's own code: the exposure phrase
 * ("topless, bare chest"), the outfit fallback and every field a later slice
 * adds arrive here for free and identically. What the resolver's own GATES would
 * decide is then overwritten, exactly as the probe overwrites them, because
 * every one of those gates asks a question about a chat: the staging's evidence
 * quote, the present roster's cast fit, and the composer's camera proposal. A
 * bench has no narration to quote and no composer to clamp — the admin picked
 * this entry outright, which is the whole instrument — so the entry's own camera
 * and viewer parts are stated rather than earned.
 *
 * Everything explicit still passes the gates that are about the RENDER rather
 * than the chat: `buildSceneRenderPrompt` runs the staging's viewer parts
 * through `resolveViewerParts` against the coverage below and this route's
 * `allowIntimate`, and suppresses the whole staged sentence if any of them falls
 * out of frame.
 *
 * Pure, and exported for that reason: the prompt this returns is the parity pin
 * — for the same plan and the same subject facts it must be byte-identical to
 * what the chat lane produces, and a test can only assert that against a seam
 * with no database behind it.
 *
 * `facts` is where the two subject-facts arms differ, and it is the ONLY place
 * they differ: `production_parity` hands the digest-produced fields in,
 * `reference_only` hands {@link REFERENCE_ONLY_SUBJECT_FACTS} — four empty
 * strings, which `characterSpec` turns back into the absent keys the kind
 * carried before the 2026-08-25 ruling. It defaults to the ablation so that a
 * caller who states no facts gets the arm that CLAIMS no facts; the runner
 * always passes an explicit value.
 */
export function stagedSceneWords(
  subject: string,
  entry: SceneStaging,
  scene: ImageLabStaging,
  facts: StagedSubjectFacts = REFERENCE_ONLY_SUBJECT_FACTS,
): StagedSceneWords {
  const present: ScenePresentCharacter = {
    name: subject,
    // No worn items and no described outfit: a bench states what the staging
    // needs bare and leaves the rest to the reference image, which the prompt's
    // clothing-authority clause already treats as authoritative when nothing
    // contradicts it. This holds on BOTH arms — the parity arm describes the
    // person, never their closet, because the coverage this bench renders is the
    // staging's premise and a garment list would contradict it.
    wornVisible: [],
    exposure: stagedSubjectExposure(entry),
    // The gate for bare phrasing at all — without it `formatExposure` returns ""
    // and a staging whose template describes bare skin would ride a prompt that
    // never said the subject was undressed.
    wardrobeTracked: true,
    // The digest-produced fields, or the ablation's empty strings.
    // `ageAnchor` is deliberately absent on both arms: a staged render inherits
    // visible age from the identity reference, which is the same call the scene
    // lane's segment policy makes (`age: "omit"`).
    appearance: facts.appearance,
    identityAnchors: facts.identityAnchors,
    lowerBody: facts.lowerBody,
    intimateAppearance: facts.intimateAppearance,
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
      // `resolveScenePlan` clamps viewer parts away and the prompt builder falls
      // back to the disembodied POV rule, which asserts the viewer's absence
      // while the staged sentence describes their hands on somebody.
      embodiedViewer: true,
      playerExposure: STAGED_VIEWER_EXPOSURE,
    },
  );
  const plan: SceneRenderPlan = {
    ...resolvedPlan,
    // A surviving staging OWNS the shot: the geometry
    // is entailed by the act, so its camera replaces the plan's rather than
    // merging with it.
    camera: { ...entry.camera },
    staging: entry,
    // The chat resolver unions the staging's parts into whatever the composer
    // grounded; a bench proposes none of its own, so that union reduces to this
    // list — and the per-prompt coverage/route gate still runs over it.
    viewerBody: [...entry.viewerParts],
  };
  return {
    plan,
    prompt: buildSceneRenderPrompt(plan, {
      // The reference-edit rung, because this kind always sends an identity
      // reference. It is what puts the identity lock in the prompt and what
      // budgets the result to `EDIT_RENDER_PROMPT_LIMIT` — the ceiling the
      // staging templates are measured against, character for character. Without
      // it the builder compiles the unbudgeted text-to-image shape, which is a
      // different prompt than production sends.
      referenceName: subject,
      // The uncensored route, stated rather than derived: every intimate entry's
      // sentence is suppressed without it, and a bench for the intimate LoRA
      // whose prompt omitted the act would grade the model on the wrong picture.
      allowIntimate: true,
    }),
  };
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
