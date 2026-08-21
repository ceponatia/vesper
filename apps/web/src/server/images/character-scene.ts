import { and, eq } from "drizzle-orm";
import { resolveAttributes, type AttributeValue } from "@/contracts/attributes/value";
import type { ActiveCondition } from "@/contracts/conditions/condition";
import { conditionAttributeOverlays } from "@/contracts/conditions/overlays";
import { resolveImageProfileForTask } from "./model-profiles";
import type { CommittedSceneFacts } from "@/contracts/images/scene-committed";
import { exposedRegions, FULLY_COVERED, type RegionExposure } from "@/contracts/items/visibility";
import { speciesLabelPhrase } from "@/contracts/species";
import type { CharacterProfile } from "@/contracts/world/profile";
import type { IdentityReferenceProvenance, SceneReferenceSource } from "@vesper/image-core";
import type { DiagnosticSink } from "@/contracts/diagnostics";
import { diag, DiagnosticCollector, teeSink } from "@/contracts/diagnostics";
import { logDiagnostics } from "@/server/log";
import { classifyImageFailure, hasReplicate, isDemoMode } from "../ai";
import { db, images } from "../db";
import { logEvent } from "../events";
import { deleteOwnedImage, imageMeta, readImageBytes } from "./assets";
import { identityPackRenderReferences } from "./identity-pack-consume";
import { latestChatLook } from "./chat-look";
import {
  characterAppearanceSummary,
  identityAnchorSummary,
  sceneRevealAppearance,
} from "./prompts-appearance";
import type { SceneComposerContext, ScenePresentCharacter } from "./prompts-scene-composer";
import type { SceneRenderPlan } from "./prompts-scene-plan";
import { composeSceneSpec, renderResolvedScene } from "./scene";
import { resolveIntimateSceneLoraRoute } from "./scene-lora";
import { applySceneSubjectVisual, visualStateNote } from "./scene-subject-visual";
import type { VisualStateShadowInput } from "@/server/visual-state";

// The meter note moved to the cast-1 cutover module with WP-C; the legacy
// cast ≥2 path below and existing consumers keep this import surface.
export { visualStateNote } from "./scene-subject-visual";

export const DEFAULT_CHAT_ROOM =
  "A warm, softly lit room — a comfortable couch, a low wooden table, shelves of books along one wall, and a tall window letting in natural light.";

/**
 * One character the render draws, with everything about them that varies per
 * person. The cast is the roster filtered to `presence: "present"` — chat's only
 * location-like state, so "in the same room" and "present" are the same claim
 * (qwen-advanced-image-subsystem.spec.md §"Stage 7 promotion delivery").
 */
export interface SceneCastMember {
  characterId: string;
  name: string;
  profile: CharacterProfile;
  avatarImageId: string | null;
  outfit?: string;
  outfitExposed?: boolean;
  exposure?: RegionExposure;
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
   * This character's look-anchor key. Absent ⇒ anchor on their avatar. Only the
   * primary's look is minted today, so a second cast member normally anchors on
   * their canonical portrait and takes its wardrobe from the prompt's clothing
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
   * The player's own recent messages, oldest first (scene-composition.plan.md slice 1) — a
   * separate list from `recentChat`, which keeps its meaning of assistant rows only.
   */
  recentPlayerChat?: string[];
  /**
   * Committed scene facts per cast member, keyed by normalized name (slice 3). Authoritative
   * where present; an absent entry constrains nothing.
   */
  committedScene?: ReadonlyMap<string, CommittedSceneFacts>;
  playerExposure?: RegionExposure;
  playerAttributes?: ReadonlyArray<AttributeValue>;
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
   * The single subject's committed chat cut as a camera-less shadow input
   * (image-lane-consolidation Stage 3, WP-C) — the queue builds it through
   * `chatVisualStateShadowInput` when the effective cast is one person. When
   * present (and matching the lone cast member), the visual image digest — with
   * the plan's committed camera bound into its one selection pass — becomes the
   * character-fact source for the focal spec, and a digest that cannot be built
   * fails the row before provider spend. Absent (pre-digest callers: tests, the
   * lab baseline), the legacy field production stands.
   */
  subjectVisual?: Omit<VisualStateShadowInput, "sink" | "camera">;
  sink?: DiagnosticSink;
}

/**
 * One cast member's composer entry — everything the shot needs about that person.
 *
 * LEGACY field production (image-lane-consolidation Stage 3 scope ruling): for
 * an effective cast of ONE with a supplied `subjectVisual` cut, the appearance,
 * identity-anchor and reveal fields written here are replaced after the plan
 * resolves by `applySceneSubjectVisual` — the digest-sourced production with the
 * committed camera bound in. A cast of 2+ keeps exactly this code path until
 * Stage 4. The composer prompt reads none of those fields, so the pre-plan
 * values never steer the shot either way.
 */
function presentCharacter(member: SceneCastMember): ScenePresentCharacter {
  const exposure: RegionExposure =
    member.exposure ?? (member.outfitExposed ? exposedRegions([]) : FULLY_COVERED);
  // Authored base → persisted narrative overlays → this moment's condition
  // overlays: the same three-layer resolve the narrator prompt takes
  // (`character-chat.ts`'s `fullResolved`), the affordance read takes
  // (`chat-affordances.ts`'s `resolveSubjectAttributes`) and the visual-state
  // projection takes (`visual-state/assemble.ts`'s `resolveShadowAttributes`).
  // Without the middle layer a recorded haircut or dye reached the narrator and
  // the projection but not the picture — and hair colour/length/style are
  // identity ANCHORS here, so the prompt actively re-asserted the old hair
  // against the reference. `condition` outranks `narrative` in
  // SOURCE_PRECEDENCE, so the order only settles same-source ties; it is kept
  // identical to those three anyway so the layers can never quietly diverge.
  const resolved = resolveAttributes(member.profile.attributes, [
    ...(member.attributeOverlays ?? []),
    ...conditionAttributeOverlays(member.conditions ?? []),
  ]);
  const stateNote = visualStateNote(member.meters);
  const appearance = [characterAppearanceSummary(resolved, undefined, false, member.profile), stateNote]
    .filter(Boolean)
    .join(". ");
  return {
    name: member.name,
    species: speciesLabelPhrase(member.profile.speciesId, member.profile.heritageId),
    wornVisible: [],
    outfitDescription: [(member.outfit ?? "").trim(), ...(member.garmentNotes ?? []).map((note) => note.trim())]
      .filter(Boolean)
      .join("; "),
    exposure,
    wardrobeTracked: true,
    appearance,
    identityAnchors: identityAnchorSummary(resolved, member.profile),
    // Age is deliberately absent from scene-image text. `profile.age` belongs to
    // narrators; `identity.apparent_age` belongs to portrait generation. Scene
    // renders inherit visible age from the portrait/chat-look reference instead.
    lowerBody: sceneRevealAppearance(resolved, exposure, member.profile, { intimate: false }),
    intimateAppearance: sceneRevealAppearance(resolved, exposure, member.profile, { intimate: true }),
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
  playerAttributes?: ReadonlyArray<AttributeValue>;
  playerProfile?: CharacterProfile;
}): SceneComposerContext {
  return {
    present: input.cast.map(presentCharacter),
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
    ...(input.playerAttributes ? { playerAttributes: input.playerAttributes } : {}),
    ...(input.playerProfile ? { playerProfile: input.playerProfile } : {}),
    ...(input.playerProfile && input.playerExposure
      ? {
          playerIntimateAppearance: sceneRevealAppearance(
            resolveAttributes(input.playerProfile.attributes, []),
            input.playerExposure,
            input.playerProfile,
            { intimate: true },
          ),
        }
      : {}),
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
  const selfie = input.flavor === "selfie";
  const room = input.room?.trim() || DEFAULT_CHAT_ROOM;
  // A selfie is the subject's own phone camera and its framing ends "No one else
  // in frame", so it stays single-subject however many people share the room.
  const cast = selfie ? input.cast.slice(0, 1) : input.cast;
  const context = buildCharacterSceneContext({
    cast,
    room,
    timeOfDay: input.timeOfDay,
    recentChat: (input.recentChat ?? []).filter((text) => text.trim()),
    recentPlayerChat: (input.recentPlayerChat ?? []).filter((text) => text.trim()),
    committedScene: input.committedScene,
    playerExposure: input.playerExposure,
    playerAttributes: input.playerAttributes,
    playerProfile: input.playerProfile,
  });
  let plan = await composeSceneSpec({ ...context, sink: input.sink, composerModel: input.composerModel });

  // The cast-1 digest cutover (image-lane-consolidation Stage 3, WP-C): applied
  // AFTER the plan resolves because the committed scene camera is `plan.camera`
  // and it must enter the digest's ONE selection pass. Cast ≥2 keeps the legacy
  // `presentCharacter` production untouched (Stage 4), and a selfie's forced
  // single-subject cast rides the new path. A refusal here reaches the row as a
  // failed precondition — reserved, failed, never sent to a provider.
  let visualRefusal: string | null = null;
  let visualStateMeta: Record<string, unknown> | undefined;
  const soleMember = cast.length === 1 ? cast[0] : undefined;
  if (soleMember !== undefined && input.subjectVisual !== undefined) {
    if (input.subjectVisual.subjectId !== soleMember.characterId) {
      input.sink?.push(
        diag("warn", "images.scene_render.visual_subject_mismatch", "subject visual cut names a different character — digest skipped", {
          context: { cut: input.subjectVisual.subjectId, cast: soleMember.characterId },
        }),
      );
    } else {
      const applied = applySceneSubjectVisual({
        plan,
        member: soleMember,
        shadow: input.subjectVisual,
        ...(input.sink === undefined ? {} : { sink: input.sink }),
      });
      plan = applied.plan;
      visualRefusal = applied.refusal;
      visualStateMeta = applied.digestMeta;
    }
  }

  // The chat's stored scene-model pick, resolved against the profile registry. A
  // pick that no longer exists degrades to the scene task's default (owner ruling
  // 5) — the legacy Venice keys on pre-registry rows land here and are simply
  // replaced, and a stored MODEL id still resolves to that model's own scene
  // profile rather than moving the chat onto a different model.
  const imageProfile = isDemoMode() ? null : await resolveImageProfileForTask("scene", input.sceneModel, input.sink);
  const model = imageProfile?.model ?? null;
  const referenceRoute = !isDemoMode() && hasReplicate() && model !== null && model.canEdit;
  // One anchor per cast member, resolved in roster order: this character's own
  // tracked look when the chat has minted one, else the identity-pack service's
  // candidate for their canonical portrait (5B ruling — a minted chat look
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
      // A member with no portrait at all renders from text, exactly as before —
      // there is no identity source for the pack to measure, so nothing was
      // substituted and nothing is refused.
      if (!member.avatarImageId) continue;
      const pack = await identityPackRenderReferences({
        ownerId: input.userId,
        characterId: member.characterId,
        profile: imageProfile,
        sink: input.sink,
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

  // Resolved PER ATTEMPT rather than once for the render, because the trigger is
  // a fact about the attempt: the content-rejection retry strips the staging from
  // its plan and clears `allowIntimate`, and re-asking here is what makes that
  // retry render LoRA-free without a second rule saying so
  // (intimate-scene-lora.spec.md §Algorithm step 3). Off the trigger it reads
  // nothing and reports nothing, so an ordinary scene pays one comparison.
  const renderOnce = async (attemptPlan: SceneRenderPlan, allowIntimate: boolean): Promise<string> => {
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
      mode: imageBearing >= 2 ? "multi" : "single",
      // The route's profile IS the lane's profile with the LoRA wrapper in place
      // of the scene model; off the route it is the resolved object itself, so a
      // LoRA-free render is unchanged down to the reference.
      profile: lora?.profile ?? imageProfile,
      ...(lora ? { resolvedLora: lora.binding } : {}),
      framing: selfie ? "selfie" : undefined,
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
      failedPrecondition: identityRefusal ?? visualRefusal,
      linkage: {
        ownerId: input.userId,
        entityKind: "character",
        entityId: input.characterId,
        chatId: input.chatId,
        anchorMessageId: input.anchorMessageId,
      },
      logResult: (imageId, status, started) =>
        void logEvent("image.character_scene", {
          imageId,
          characterId: input.characterId,
          status,
          durationMs: Date.now() - started,
        }),
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
  input.sink?.push(
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

function sanitizeScenePlan(plan: SceneRenderPlan): SceneRenderPlan {
  const scrub = <T extends { exposure?: string; intimateAppearance?: string }>(spec: T): T => ({
    ...spec,
    exposure: undefined,
    intimateAppearance: undefined,
  });
  // The staging goes with them (scene-composition.spec.md §Ownership rules): a content
  // rejection is the provider refusing what the prompt described, and the staged act is the
  // most explicit sentence in it. The camera stays — where the shot is taken from is never
  // what a moderator objected to, and dropping it would silently un-compose the scene.
  return {
    ...plan,
    staging: undefined,
    focal: plan.focal ? scrub(plan.focal) : null,
    others: plan.others.map(scrub),
  };
}