import { and, eq } from "drizzle-orm";
import { resolveAttributes, type AttributeValue } from "@/contracts/attributes";
import type { ActiveCondition } from "@/contracts/conditions/condition";
import { resolveImageProfileForTask } from "./model-profiles";
import type { CommittedSceneFacts } from "@/contracts/images/scene-committed";
import type { HairOcclusion } from "@/contracts/items/hair-occlusion";
import { exposedRegions, FULLY_COVERED, type RegionExposure } from "@/contracts/items/visibility";
import { realizeBody, speciesLabelPhrase } from "@/contracts/species";
import type { CharacterProfile } from "@/contracts/world/profile";
import type { IdentityReferenceProvenance, SceneCaptureMode, SceneReferenceSource } from "@vesper/image-core";
import type { DiagnosticSink } from "@/contracts/diagnostics";
import { diag, DiagnosticCollector, teeSink } from "@/contracts/diagnostics";
import { logDiagnostics } from "@/server/log";
import { classifyImageFailure, hasImageProviderForModel, isDemoMode } from "../ai";
import { db, images } from "../db";
import { logEvent } from "../events";
import { deleteOwnedImage } from "./asset-deletion";
import { imageMeta, readImageBytes } from "./asset-storage";
import { identityPackRenderReferences } from "./identity-pack-consume";
import { latestChatLook } from "./chat-look";
import type { SceneComposerContext, ScenePresentCharacter } from "./prompts-scene-composer";
import type { SceneRenderPlan } from "./prompts-scene-plan";
import { composeSceneSpec, renderResolvedScene, type SceneRenderReferenceView } from "./scene";
import { loadConsumableReferenceView } from "./reference-view-consume";
import { referenceViewAngleById, selectReferenceView } from "@/contracts";
import type { SceneLoweringViewer } from "./scene-lowering";
import { resolveIntimateSceneLoraRoute } from "./scene-lora";
import { applySceneCastVisual, type SceneCastVisualSubject, type SceneSubjectVisualSlice } from "./scene-subject-visual";
import type { VisualStateShadowInput } from "@/server/visual-state";

export const DEFAULT_CHAT_ROOM =
  "A warm, softly lit room — a comfortable couch, a low wooden table, shelves of books along one wall, and a tall window letting in natural light.";

/**
 * One character the render draws, with everything about them that varies per
 * person. The cast is the roster filtered to `presence: "present"` — chat's only
 * location-like state, so "in the same room" and "present" are the same claim.
 */
export interface SceneCastMember {
  characterId: string;
  name: string;
  profile: CharacterProfile;
  /**
   * The member's identity source: `characters.accepted_avatar_image_id`, never
   * the candidate portrait on screen. Null ⇒ nothing accepted, and this member
   * renders from their textual description exactly as a portrait-less character
   * does.
   */
  identityImageId: string | null;
  outfit?: string;
  outfitExposed?: boolean;
  exposure?: RegionExposure;
  /** The resolved wardrobe's hair-occlusion band (`ResolvedChatWardrobe.hairOcclusion`); absent reads `none`. */
  hairOcclusion?: HairOcclusion;
  garmentNotes?: readonly string[];
  meters?: Record<string, number>;
  conditions?: ActiveCondition[];
  /**
   * The chat's PERSISTED narrative attribute overlays for this member
   * (`ChatState.attributeOverlays`) — a recorded haircut or dye the archivist
   * wrote down. Absent ⇒ the authored sheet alone, which is what every
   * non-chat caller (the lab, a bare test render) has.
   */
  attributeOverlays?: readonly AttributeValue[];
  /**
   * This character's look-anchor key. Absent ⇒ anchor on their accepted
   * portrait. Only the
   * primary's look is minted today, so a second cast member normally anchors on
   * their accepted portrait and takes its wardrobe from the prompt's clothing
   * authority rather than from the reference.
   */
  lookKey?: string;
}

export interface RenderCharacterSceneInput {
  /** The character the scene row is FILED against — the strip reads by this id. */
  characterId: string;
  userId: string;
  /** Everyone in frame, in roster order. Never empty. */
  cast: readonly SceneCastMember[];
  room?: string;
  timeOfDay?: string;
  recentChat?: string[];
  /**
   * The player's own recent messages, oldest first — a
   * separate list from `recentChat`, which keeps its meaning of assistant rows only.
   */
  recentPlayerChat?: string[];
  /**
   * Committed scene facts per cast member, keyed by normalized name (slice 3). Authoritative
   * where present; an absent entry constrains nothing.
   */
  committedScene?: ReadonlyMap<string, CommittedSceneFacts>;
  /**
   * The PLAYER's coverage, computed from their worn items. The gate half of the
   * viewer's own body: it decides which viewer parts a frame — staged or
   * generic — may hold at all (`scene-lowering.ts`), and which of their intimate
   * attributes an uncensored rung may state.
   */
  playerExposure?: RegionExposure;
  /**
   * The player's persona as a character profile — the DESCRIBED half of the
   * viewer's own body (issue #390).
   *
   * An embodied first-person frame crops the viewer's hands, forearms, lap, legs
   * or torso into the foreground, and without their skin and build those limbs
   * change colour between shots and read as a different person reaching in. The
   * profile arrives rather than the resolved list because both things the
   * projection needs — the attributes and the realized body that decides which
   * of them apply — come from it.
   *
   * Never makes the viewer a subject: no cut, no identity reference, no place in
   * `operation.subjectCount`. Absent leaves an embodied frame stating its own
   * geometry and nothing about whose body it is.
   */
  playerProfile?: CharacterProfile;
  chatId?: string;
  anchorMessageId?: string;
  flavor?: "selfie";
  place?: { name: string; imageId: string };
  /** Persisted registry model id; unknown/absent values fall back to the scene default. */
  sceneModel?: string;
  /**
   * The chat's admin-set **composer** model (`character_chats.scene_composer_model`) — the
   * TEXT model that plans the shot, as distinct from `sceneModel` above, which picks the
   * IMAGE model that paints it. Unknown/absent ⇒ the curated composer default.
   */
  composerModel?: string;
  /**
   * Each drawn subject's committed chat cut as a camera-less shadow input, keyed
   * by `characterId` — the queue builds one per present cast member through
   * `chatVisualStateShadowInput`. Every member with an entry (whose cut names
   * them) is realized under the plan's committed camera in one selection pass,
   * and that cut is the WHOLE of what the prompt program says about them; a cut
   * that cannot be assembled fails the row before provider spend.
   *
   * A member with no entry, or with an entry naming somebody else, has no cut
   * and cannot be compiled — nothing here describes them from anywhere else.
   * The render then REFUSES rather than drawing the rest: `renderResolvedScene`
   * holds the cast it was asked to draw against the cuts it was given — the same
   * people, once each, or the row fails before provider spend
   * (`images.scene_render.cast_mismatch`). A smaller cast is never a quieter
   * render — it is a different picture, sent with the missing person's identity
   * reference still attached.
   */
  subjectVisuals?: ReadonlyMap<string, Omit<VisualStateShadowInput, "sink" | "camera">>;
  sink?: DiagnosticSink;
}

/** One selected reference view beside the bytes the render will send for it. */
interface SelectedReferenceView {
  readonly view: SceneRenderReferenceView;
  readonly buffer: Buffer;
}

/**
 * One cast member's composer entry — what the SHOT PLANNER needs to know about
 * that person: their name, species, outfit and coverage. Nothing here reaches
 * the image model as a description of them; the committed cut the program
 * compiles is the only source for that, and it is realized after the plan
 * resolves (`applySceneCastVisual`).
 */
function presentCharacter(member: SceneCastMember): ScenePresentCharacter {
  const exposure: RegionExposure =
    member.exposure ?? (member.outfitExposed ? exposedRegions([]) : FULLY_COVERED);
  return {
    name: member.name,
    species: speciesLabelPhrase(member.profile.speciesId, member.profile.heritageId),
    wornVisible: [],
    outfitDescription: [(member.outfit ?? "").trim(), ...(member.garmentNotes ?? []).map((note) => note.trim())]
      .filter(Boolean)
      .join("; "),
    exposure,
    wardrobeTracked: true,
  };
}

export function buildCharacterSceneContext(input: {
  cast: readonly SceneCastMember[];
  room: string;
  timeOfDay?: string;
  recentChat: string[];
  recentPlayerChat?: string[];
  committedScene?: ReadonlyMap<string, CommittedSceneFacts>;
  playerExposure?: RegionExposure;
  /** Who holds the camera — the route's decision, carried on the plan it resolves. */
  captureMode?: SceneCaptureMode;
}): SceneComposerContext {
  return {
    present: input.cast.map(presentCharacter),
    ...(input.captureMode === undefined ? {} : { captureMode: input.captureMode }),
    locationName: "the room",
    locationDescription: input.room,
    timeOfDay: input.timeOfDay?.trim() || "day",
    recentNarration: input.recentChat,
    // Both spread conditionally: an absent player corpus and an empty committed map must
    // leave the composer prompt byte-identical to the pre-slice one.
    ...(input.recentPlayerChat && input.recentPlayerChat.length > 0
      ? { recentPlayerMessages: input.recentPlayerChat }
      : {}),
    ...(input.committedScene && input.committedScene.size > 0 ? { committedScene: input.committedScene } : {}),
    embodiedViewer: true,
    ...(input.playerExposure ? { playerExposure: input.playerExposure } : {}),
  };
}

async function loadChatPlaceImage(ownerId: string, imageId: string): Promise<{ imageId: string; buffer: Buffer } | null> {
  const [row] = await db()
    .select()
    .from(images)
    .where(and(eq(images.id, imageId), eq(images.ownerId, ownerId), eq(images.kind, "chat_place"), eq(images.status, "ready")))
    .limit(1);
  if (!row) return null;
  const buffer = await readImageBytes(row);
  return buffer ? { imageId: row.id, buffer } : null;
}

/** Compose and render one character-chat scene with the persisted provider choice. */
export async function renderCharacterSceneImage(input: RenderCharacterSceneInput): Promise<string> {
  // The scene queue is a detached job and passes no sink, so the route-level
  // diagnostics — the composer's clamps and fallbacks, a skipped digest, the
  // profile resolver's degrades, an identity-pack degrade, the selfie retry —
  // would otherwise vanish exactly when an operator needs them (the collector
  // pattern's documented tail, docs/resilience.md §2). The spans that answer
  // for themselves — the LoRA route and `renderResolvedScene`'s attempt chain —
  // deliberately keep the caller's sink below, so their own drains stay the
  // single replay of their diagnostics.
  const routeDiagnostics = new DiagnosticCollector();
  const sink = input.sink ? teeSink(input.sink, routeDiagnostics) : routeDiagnostics;
  try {
    return await renderCharacterSceneWithSink(input, sink);
  } finally {
    logDiagnostics("images.character_scene", routeDiagnostics.items, { characterId: input.characterId });
  }
}

async function renderCharacterSceneWithSink(input: RenderCharacterSceneInput, sink: DiagnosticSink): Promise<string> {
  const selfie = input.flavor === "selfie";
  const room = input.room?.trim() || DEFAULT_CHAT_ROOM;
  // A selfie is the subject's own phone camera and its framing ends "No one else
  // in frame", so it stays single-subject however many people share the room.
  const cast = selfie ? input.cast.slice(0, 1) : input.cast;
  const context = buildCharacterSceneContext({
    cast,
    room,
    // Only a selfie states a mode. Everything else stays what this lane has
    // always been — the player's own eyes — and the plan's default says so
    // rather than an `?? third_person` here inverting every chat scene.
    ...(selfie ? { captureMode: "selfie" as const } : {}),
    timeOfDay: input.timeOfDay,
    recentChat: (input.recentChat ?? []).filter((text) => text.trim()),
    recentPlayerChat: (input.recentPlayerChat ?? []).filter((text) => text.trim()),
    committedScene: input.committedScene,
    playerExposure: input.playerExposure,
  });
  const plan = await composeSceneSpec({ ...context, sink, composerModel: input.composerModel });

  // The viewer, resolved once. Their sheet does not change between rungs — only
  // the route's intimate permission does, and that is spent in the lowering —
  // and the resolve carries no overlays because a persona has no chat-tracked
  // condition or narrative overlay behind it, unlike a cast member's cut.
  const viewer: SceneLoweringViewer | undefined = input.playerProfile
    ? {
        attributes: resolveAttributes(input.playerProfile.attributes, []),
        realizedBody: realizeBody(input.playerProfile),
      }
    : undefined;

  // The cast, realized AFTER the plan resolves because the committed scene
  // camera is `plan.camera` and it must enter EACH subject's ONE selection pass.
  // Every present member with a supplied cut goes through it — the focal and
  // everyone else alike — and a selfie's forced single-subject cast is just the
  // one-member case of the same loop. A refusal reaches the row as a failed
  // precondition: reserved, failed, never sent to a provider.
  //
  // A member whose cut names somebody else is skipped HERE — the mismatch is a
  // fact about one person's cut and is reported as one — but skipping is not
  // where the story ends: that member then has no cut, and the render's own
  // cast-integrity check refuses before provider spend rather than compiling
  // the picture without them (`renderResolvedScene`, `cast_mismatch`). The
  // program still describes nobody it has no cut for; it simply never runs.
  let visualRefusal: string | null = null;
  let visualStateMeta: Record<string, unknown> | undefined;
  let appliedVisuals: readonly SceneSubjectVisualSlice[] = [];
  const castVisuals: SceneCastVisualSubject[] = [];
  for (const member of cast) {
    const shadow = input.subjectVisuals?.get(member.characterId);
    if (shadow === undefined) continue;
    if (shadow.subjectId !== member.characterId) {
      sink.push(
        diag("warn", "images.scene_render.visual_subject_mismatch", "subject visual cut names a different character — digest skipped", {
          context: { cut: shadow.subjectId, cast: member.characterId },
        }),
      );
      continue;
    }
    castVisuals.push({ member, shadow });
  }
  if (castVisuals.length > 0) {
    const applied = applySceneCastVisual({ plan, members: castVisuals, sink });
    visualRefusal = applied.refusal;
    visualStateMeta = applied.digestMeta;
    appliedVisuals = applied.visuals;
  }

  // The chat's stored scene-model pick, resolved against the profile registry. A
  // pick that no longer exists degrades to the scene task's default (owner ruling
  // 5) — the legacy Venice keys on pre-registry rows land here and are simply
  // replaced, and a stored MODEL id still resolves to that model's own scene
  // profile rather than moving the chat onto a different model.
  const imageProfile = isDemoMode() ? null : await resolveImageProfileForTask("scene", input.sceneModel, sink);
  const model = imageProfile?.model ?? null;
  const referenceRoute =
    !isDemoMode() && model !== null && hasImageProviderForModel(model) && model.canEdit;
  // One anchor per cast member, resolved in roster order: this character's own
  // tracked look when the chat has minted one, else the identity-pack service's
  // candidate for their accepted portrait (5B ruling — a minted chat look
  // STAYS the identity reference: it carries current wardrobe/state and is
  // itself downstream of the avatar, so only the member with no fresh look
  // asks the pack). A member with neither renders from the prompt's textual
  // description, which the multi-reference prompt already labels as such.
  const anchors = new Map<string, { imageId: string; buffer: Buffer; source: SceneReferenceSource }>();
  const identityProvenance: IdentityReferenceProvenance[] = [];
  let identityRefusal: string | null = null;
  // `imageProfile !== null` is implied by `referenceRoute` at runtime (the model
  // comes from the profile) — restated so the pack call below type-narrows.
  if (referenceRoute && imageProfile !== null) {
    for (const member of cast) {
      const look =
        input.chatId && member.lookKey ? await latestChatLook(input.chatId, member.characterId, member.lookKey) : null;
      if (look) {
        anchors.set(member.characterId, { imageId: look.imageId, buffer: look.buffer, source: "generated" });
        continue;
      }
      // A member with no ACCEPTED portrait renders from text, exactly as a
      // member with no portrait at all does — there is no identity source for
      // the pack to measure, so nothing was substituted and nothing is refused.
      if (!member.identityImageId) continue;
      const pack = await identityPackRenderReferences({
        ownerId: input.userId,
        characterId: member.characterId,
        profile: imageProfile,
        sink,
      });
      if (!pack.ok) {
        // An ineligible pack refuses the whole scene rather than dropping this
        // member's reference or reading the avatar directly — either would be
        // the substitution the integration spec forbids. Diagnostics are
        // already on the sink; the row below records the reason.
        identityRefusal = `identity references unavailable for ${member.name}: ${pack.error}`;
        break;
      }
      // The cast structure carries ONE anchor per member, so the anchor is the
      // pack's required candidate (the identity that cannot be lost), matching
      // the capacity rule "required identities before optional face detail".
      const chosen = pack.references.find((entry) => entry.candidate.required) ?? pack.references[0];
      if (!chosen) continue;
      anchors.set(member.characterId, {
        imageId: chosen.candidate.imageId,
        buffer: chosen.reference.buffer,
        source: chosen.source,
      });
      identityProvenance.push(chosen.provenance);
    }
  }
  const referenceBuffers = new Map<string, Buffer>();
  for (const anchor of anchors.values()) referenceBuffers.set(anchor.imageId, anchor.buffer);

  // The place rides behind the people: identity is what the cast ruling protects,
  // so when capacity is short the setting is what gives way, never a character.
  const placeRef =
    !selfie && anchors.size > 0 && input.place && input.chatId
      ? await loadChatPlaceImage(input.userId, input.place.imageId)
      : null;
  if (placeRef) referenceBuffers.set(placeRef.imageId, placeRef.buffer);
  const imageBearing = anchors.size + (placeRef ? 1 : 0);

  // Each member's coverage as the PROGRAM already computed it — the realized
  // cut's own `exposure`, not a second derivation. "Is this character undressed
  // in this scene" has one answer per render, and a view selected from a second
  // reading of the wardrobe is a reference that argues with the prompt beside it.
  // A member with no realized cut has no entry, and no render: the cast-integrity
  // check refuses a scene whose people have no committed cuts.
  const exposureBySubject = new Map(appliedVisuals.map((visual) => [visual.subjectId, visual.exposure]));

  /**
   * The matching reference views for one attempt, selected from the shot that
   * attempt will actually render under and the permission it will render with.
   *
   * PER ATTEMPT, for the same reason the LoRA route is: a content-rejected
   * selfie retries with `allowIntimate` cleared, and re-asking here is what keeps
   * a bare view off the sanitized retry without a second rule saying so.
   *
   * `allowIntimate` is the ARGUMENT rather than a fact re-derived here: it is
   * what every character reference below is built with, so it is exactly what the
   * multi-reference rung's own gate (`every character ref allowForIntimate`)
   * would compute. A lane that may not carry intimate content therefore never
   * receives a bare view, whatever the fiction says about the wardrobe.
   *
   * A shot with no matching angle selects nothing and says nothing: three of the
   * five orientations have no view in a four-angle sheet, and the front anchor
   * is the right answer rather than a fallback. A view that WAS wanted and could
   * not be sent — nothing built, unreviewed, rejected, stale, unreadable — is an
   * INFO line. Either way the render is the front-anchored one it has always
   * been.
   */
  const selectReferenceViews = async (
    attemptPlan: SceneRenderPlan,
    allowIntimate: boolean,
  ): Promise<SelectedReferenceView[]> => {
    if (!referenceRoute || identityRefusal !== null || visualRefusal !== null) return [];
    const selected: SelectedReferenceView[] = [];
    for (const member of cast) {
      // No accepted portrait, no sheet: a view is only ever consumable while it
      // was rendered from the portrait this character has accepted right now.
      if (!member.identityImageId) continue;
      const selection = selectReferenceView({
        // The RESOLVED camera. Every evidence gate has already been spent on it,
        // and a surviving staging entry has already overwritten it, so this is
        // the shot — not a proposal anything downstream may still move.
        camera: attemptPlan.camera,
        exposure: exposureBySubject.get(member.characterId) ?? null,
        allowIntimate,
        // One character keeps ONE side for a whole conversation. Outside a chat
        // the id alone still fixes it per character.
        sideKey: `${member.characterId}${input.chatId ?? ""}`,
      });
      // No matching angle is not a degradation: nothing was wanted, and the
      // front-anchored render this produces is exactly the picture the shot
      // asked for. Silent by ruling — a line on every ordinary chat scene would
      // drown the misses that ARE worth reading.
      if (selection.view === null) continue;
      const loaded = await loadConsumableReferenceView({
        ownerId: input.userId,
        characterId: member.characterId,
        view: selection.view,
        sink,
      });
      if (!loaded.ok) continue;
      const angle = referenceViewAngleById(selection.view.angle);
      if (angle === undefined) continue;
      selected.push({
        buffer: loaded.buffer,
        view: {
          characterId: member.characterId,
          imageId: loaded.imageId,
          sourceImageId: loaded.sourceImageId,
          angle: selection.view.angle,
          wardrobe: selection.view.wardrobe,
          faceVisibility: loaded.faceVisibility,
          name: member.name,
          description: angle.sceneBinding,
          // The member's own anchor permission, so the multi rung's gate reads
          // exactly what it read before the sheet existed.
          allowForIntimate: allowIntimate,
        },
      });
    }
    return selected;
  };

  // Resolved PER ATTEMPT rather than once for the render, because the trigger is
  // a fact about the attempt: the content-rejection retry strips the staging from
  // its plan and clears `allowIntimate`, and re-asking here is what makes that
  // retry render LoRA-free without a second rule saying so. Off the trigger it
  // reads nothing and reports nothing, so an ordinary scene pays one comparison.
  const renderOnce = async (attemptPlan: SceneRenderPlan, allowIntimate: boolean): Promise<string> => {
    const picked = await selectReferenceViews(attemptPlan, allowIntimate);
    for (const entry of picked) referenceBuffers.set(entry.view.imageId, entry.buffer);
    const referenceViews = picked.map((entry) => entry.view);
    // The scene queue is a detached job and passes no sink, so the route's own
    // diagnostics would have nowhere to land — and "the LoRA was skipped" is
    // exactly the line an operator needs when the pictures go back to being
    // nervous near-misses. Collected here and replayed at their own severities,
    // the collector pattern's documented tail (docs/resilience.md §2), the same
    // way `renderResolvedScene` answers for the attempt chain's.
    const routeDiagnostics = new DiagnosticCollector();
    const lora = await resolveIntimateSceneLoraRoute({
      plan: attemptPlan,
      allowIntimate,
      selfie,
      referenceRoute,
      anchored: anchors.size > 0,
      profile: imageProfile,
      sink: input.sink ? teeSink(input.sink, routeDiagnostics) : routeDiagnostics,
    });
    logDiagnostics("images.scene_lora", routeDiagnostics.items, { characterId: input.characterId });
    const finalProfile = lora?.profile ?? imageProfile;
    const providerRefusal =
      finalProfile !== null && !hasImageProviderForModel(finalProfile.model)
        ? `the image provider for ${finalProfile.model.slug} is not configured`
        : null;
    return renderResolvedScene({
      plan: attemptPlan,
      references: [
        ...cast.map((member) => {
          const anchor = anchors.get(member.characterId);
          return {
            kind: "character" as const,
            entityId: member.characterId,
            name: member.name,
            role: attemptPlan.focal?.name === member.name ? "focal" : "other",
            allowForIntimate: allowIntimate,
            ...(anchor ? { imageId: anchor.imageId, source: anchor.source } : {}),
          };
        }),
        ...(placeRef
          ? [
              {
                kind: "location" as const,
                name: input.place?.name ?? "the place",
                role: "location",
                allowForIntimate: true,
                imageId: placeRef.imageId,
                source: "generated" as SceneReferenceSource,
              },
            ]
          : []),
      ],
      referenceBuffers,
      // The views count: an extra image-bearing reference is what routes the
      // multi-reference rung, and a single-anchor scene that just gained a
      // matching back view has two images to compose rather than one.
      mode: imageBearing + referenceViews.length >= 2 ? ("multi" as const) : ("single" as const),
      ...(referenceViews.length === 0 ? {} : { referenceViews }),
      // The route's profile IS the lane's profile paired with the intimate
      // model's registered row; off the route it is the resolved object itself,
      // so a LoRA-free render is unchanged down to the reference.
      profile: finalProfile,
      ...(lora ? { resolvedLora: lora.binding } : {}),
      flavor: input.flavor,
      // No provenance travels with a refusal: an earlier cast member's pack may
      // have answered before a later member's refusal stopped the scene, and
      // those references are never sent (renderResolvedScene would drop them
      // from the row anyway — this keeps the lane's own output coherent).
      ...(identityProvenance.length > 0 && identityRefusal === null && visualRefusal === null
        ? { identityProvenance }
        : {}),
      // The digest's `meta.visualState` fragment, written at reserve time so it
      // survives failures — which visual moment fed this render, whatever the
      // provider then did with it.
      ...(visualStateMeta === undefined ? {} : { visualStateMeta }),
      // The realized cast rides only past the refusals: a render that fails its
      // precondition never reaches a provider, so compiling a prompt program for
      // it would store a program describing a render nobody made.
      ...(appliedVisuals.length === 0 || identityRefusal !== null || visualRefusal !== null
        ? {}
        : { cast: appliedVisuals }),
      // The viewer, beside the cast and never in it. Resolved once for the
      // render: the persona's sheet does not change between rungs, and only the
      // route's intimate permission does.
      ...(viewer === undefined ? {} : { viewer }),
      failedPrecondition: identityRefusal ?? visualRefusal ?? providerRefusal,
      linkage: {
        ownerId: input.userId,
        entityKind: "character",
        entityId: input.characterId,
        chatId: input.chatId,
        anchorMessageId: input.anchorMessageId,
      },
      logResult: (imageId, status, started) =>
        // Ids, status and duration only — no prompt text. The chat id ties the
        // row to its conversation so deleting the chat takes it too.
        void logEvent(
          "image.character_scene",
          {
            imageId,
            characterId: input.characterId,
            status,
            durationMs: Date.now() - started,
          },
          { chatId: input.chatId ?? null },
        ),
      sink: input.sink,
    });
  };

  const first = await renderOnce(plan, true);
  // A refused render — identity or visual-digest — retries into the same
  // refusal; return the record.
  if (!selfie || identityRefusal !== null || visualRefusal !== null) return first;

  const firstError = await imageFailure(first);
  if (firstError === null) return first;
  const reason = classifyImageFailure(new Error(firstError || "render failed"));
  sink.push(
    diag("info", "images.selfie.retry", `first selfie attempt failed (${reason}) — retrying${reason === "content_rejection" ? " sanitized" : ""}`),
  );
  const retryPlan = reason === "content_rejection" ? sanitizeScenePlan(plan) : plan;
  const second = await renderOnce(retryPlan, reason !== "content_rejection");
  await deleteOwnedImage(first, input.userId, { kind: "scene" });
  return second;
}

async function imageFailure(imageId: string): Promise<string | null> {
  const [row] = await db().select({ status: images.status, meta: images.meta }).from(images).where(eq(images.id, imageId)).limit(1);
  if (!row || row.status !== "failed") return null;
  const error = imageMeta(row.meta).error;
  return typeof error === "string" ? error : "";
}

/**
 * The plan a content-rejected selfie retries with: the staging gone, everything
 * else kept. A content rejection is the provider refusing what the prompt
 * described, and the staged act is the most explicit sentence in it. The cast's
 * exposed anatomy is not on the plan at all — it is the rung's own intimate
 * permission, which the retry clears (`renderOnce(plan, false)`), so the
 * program compiles the cut alone. The camera stays: where the shot is taken
 * from is never what a moderator objected to, and dropping it would silently
 * un-compose the scene.
 */
function sanitizeScenePlan(plan: SceneRenderPlan): SceneRenderPlan {
  return { ...plan, staging: undefined };
}
