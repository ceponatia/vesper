import fs from "node:fs/promises";
import { and, eq } from "drizzle-orm";
import { resolveAttributes, type AttributeValue } from "@/contracts/attributes/value";
import type { ActiveCondition } from "@/contracts/conditions/condition";
import { conditionAttributeOverlays } from "@/contracts/conditions/overlays";
import { exposedRegions, FULLY_COVERED, type RegionExposure } from "@/contracts/items/visibility";
import { speciesLabelPhrase } from "@/contracts/species";
import type { CharacterProfile } from "@/contracts/world/profile";
import type { SceneReferenceSource } from "@/contracts/images/scene-reference";
import type { DiagnosticSink } from "@/contracts/diagnostics";
import { diag } from "@/contracts/diagnostics";
import { classifyImageFailure, hasVenice, isDemoMode } from "../ai";
import { db, images } from "../db";
import { logEvent } from "../events";
import { absoluteImagePath, deleteOwnedImage } from "./assets";
import { latestChatLook } from "./chat-look";
import {
  characterAppearanceSummary,
  identityAnchorSummary,
  sceneRevealAppearance,
  type SceneComposerContext,
  type ScenePresentCharacter,
  type SceneRenderPlan,
} from "./prompts";
import { composeSceneSpec, renderResolvedScene } from "./scene";

/**
 * Sessionless scene images for the character-chat harness
 * (docs/developer-notes/character-chat.plan.md). Same two-step pipeline as the
 * in-session scene image (compose a spec from the present cast + recent
 * scene image (compose a spec from the present cast + recent narration, then
 * render with the avatar as the identity anchor) — but there is no location, so
 * the single subject is the library character and a default room description
 * stands in for the place. The asset is filed against the character
 * (`entityKind:"character"`), so it surfaces in the Gallery under "Character
 * chats" and is deletable there like any scene.
 */

/** The stand-in location when the chat has no real place. Overridable per request. */
export const DEFAULT_CHAT_ROOM =
  "A warm, softly lit room — a comfortable couch, a low wooden table, shelves of books along one wall, and a tall window letting in natural light.";

export interface RenderCharacterSceneInput {
  characterId: string;
  userId: string;
  name: string;
  profile: CharacterProfile;
  /** The character's canonical avatar, used as the identity reference when ready. */
  avatarImageId: string | null;
  /** Default-room override; falls back to DEFAULT_CHAT_ROOM. */
  room?: string;
  /** Scene-memory time of day (chat-scene-fidelity.plan.md slice 2a); falls back to "day". */
  timeOfDay?: string;
  /** Recent assistant turns (oldest first) for the composer to center the shot on. */
  recentChat?: string[];
  /** Rendered outfit phrase (structured worn items + overlay), from the wardrobe seam; "" ⇒ composer-inferred. */
  outfit?: string;
  /** Reveal intimate anatomy — the free-text/legacy manual flag (superseded by `exposure` when present). */
  outfitExposed?: boolean;
  /** Coverage-computed per-region exposure (chat-wardrobe-parity); overrides the boolean flag. */
  exposure?: RegionExposure;
  /**
   * Compact garment-state facts for THIS shot (clothing-state-graph slice 6, behind
   * `CHAT_GARMENT_CUES`): the same semantic reads the narrator digest and cue block
   * are built from — "her shirt is soaked through", "mud has dried into the hem" —
   * never a raw value. They ride the outfit description, which is exactly where the
   * composer already looks for what the clothes are doing. Absent ⇒ today's prompt.
   */
  garmentNotes?: readonly string[];
  /**
   * The PLAYER's coverage, from their persona's worn items (persona-library slice 8) — the
   * gate on whether the viewer's own anatomy may enter frame. Absent ⇒ covered ⇒ shut.
   */
  playerExposure?: RegionExposure;
  /** The persona's resolved attributes — the viewer's own body facts (slice 4). */
  playerAttributes?: ReadonlyArray<AttributeValue>;
  /** The persona adapted to a character profile — realized-body applicability for the above. */
  playerProfile?: CharacterProfile;
  /** Live chat meters — fold a visible-state note (unsteady/disheveled/tired/breathless) into the shot (D4). */
  meters?: Record<string, number>;
  /** Active conditions — overlay grooming/scent/hair so a "disheveled" character renders that way (D4). */
  conditions?: ActiveCondition[];
  /** The conversation this scene belongs to (slice 9 inline moments) — scopes list + scrub. */
  chatId?: string;
  /** The assistant message the scene illustrates — the inline-transcript anchor. */
  anchorMessageId?: string;
  /**
   * "selfie" (chat-selfies.plan.md): the subject's-own-camera framing on the
   * identity-locked reference route, `meta.flavor: "selfie"`, and the retry-once
   * failure policy (a content rejection retries sanitized; a second failure
   * stays a debuggable failed row).
   */
  flavor?: "selfie";
  /**
   * The chat's current look key (chat-scene-references.plan.md): when a cached
   * `chat_look` with this key exists, it anchors the render instead of the
   * always-dressed avatar — the reference finally agrees with the fiction's
   * outfit. Absent / stale key ⇒ the avatar (today's behavior).
   */
  lookKey?: string;
  /**
   * The current place's minted reference image: fed as the second reference on
   * the multi-edit rung so settings stay consistent across a conversation's
   * scenes. Selfies ignore it (the subject is the shot).
   */
  place?: { name: string; imageId: string };
  sink?: DiagnosticSink;
}

/**
 * A short **visible-state** phrase for the scene image (character-chat-state-narration.spec.md
 * §8): the meters with a visual signature, in image-appropriate wording (the narrator-facing
 * threshold hints are behavioral, so this is a separate, render-tuned mapping). "" when the
 * character reads rested and presentable. Mood/affect ride the avatar reference, not this note.
 *
 * **No skin-colour words** (scene-pov-embodiment.plan.md slice 0, owner report): "flushed" /
 * "blushing" / "rosy" render as stage blusher — a clown-makeup face, not a body state. Every
 * phrase here states physiology the model paints as physiology instead: eyes, breath, sweat,
 * posture, hair. `scrubBlush` (images/prompts.ts) is the backstop for the LLM-authored text
 * this note sits beside; keep the two in agreement.
 */
export function visualStateNote(meters: Record<string, number> = {}): string {
  const parts: string[] = [];
  const intoxication = meters.intoxication ?? 0;
  if (intoxication > 0.7) parts.push("visibly unsteady from drink, eyes glassy and unfocused, posture slack");
  else if (intoxication > 0.35) parts.push("loose and warm from a drink or two, gaze a little unfocused");
  const hygiene = meters.hygiene ?? 1;
  if (hygiene < 0.3) parts.push("unwashed — hair gone lank, skin sheened, clothes rumpled");
  else if (hygiene < 0.55) parts.push("a little disheveled, hair loosened and skin damp");
  const energy = meters.energy ?? 1;
  if (energy < 0.2) parts.push("exhausted and heavy-lidded");
  else if (energy < 0.45) parts.push("tired, eyes heavy");
  const arousal = meters.arousal ?? 0;
  if (arousal > 0.55) parts.push("eyes bright and heavy-lidded, lips parted, breath shallow, a faint sheen of sweat");
  return parts.join("; ");
}

/**
 * The composer context for a single library character in the default room
 * (character-chat-scenario.plan.md; structured worn state — chat-wardrobe-parity). The
 * `outfit` is the rendered garment phrase (structured worn items + free-text overlay), and
 * `exposure` — when the caller supplies it — is COMPUTED from the worn items' coverage via the
 * session classifier; absent, the manual `outfitExposed` flag stands in (free-text / legacy
 * path): exposed ⇒ fully bare (intimate-anatomy reveal on the uncensored route), else SFW.
 */
export function buildCharacterSceneContext(input: {
  name: string;
  profile: CharacterProfile;
  room: string;
  timeOfDay?: string;
  recentChat: string[];
  outfit: string;
  outfitExposed: boolean;
  /** Coverage-computed exposure (chat-wardrobe-parity); overrides the boolean flag when present. */
  exposure?: RegionExposure;
  /** Compact garment-state facts appended to the outfit description (slice 6, flag-gated). */
  garmentNotes?: readonly string[];
  /** The PLAYER's coverage — gates whether their own anatomy may render (scene-pov-embodiment). */
  playerExposure?: RegionExposure;
  playerAttributes?: ReadonlyArray<AttributeValue>;
  playerProfile?: CharacterProfile;
  meters?: Record<string, number>;
  conditions?: ActiveCondition[];
}): SceneComposerContext {
  const exposure: RegionExposure = input.exposure ?? (input.outfitExposed ? exposedRegions([]) : FULLY_COVERED);

  // Active conditions overlay attributes (grooming/scent/hair) the same way the chat prompt
  // does (character-chat-state-narration.spec.md §2/§8), and a visible-state note layers the
  // meters with a visual signature — so the render reflects how the character actually is now.
  const resolved = resolveAttributes(input.profile.attributes, conditionAttributeOverlays(input.conditions ?? []));
  const stateNote = visualStateNote(input.meters);
  const appearance = [characterAppearanceSummary(resolved, undefined, false, input.profile), stateNote]
    .filter(Boolean)
    .join(". ");
  const present: ScenePresentCharacter = {
    name: input.name,
    species: speciesLabelPhrase(input.profile.speciesId, input.profile.heritageId),
    // No structured items in chat — the free-text outfit overrides the (empty) wardrobe summary.
    wornVisible: [],
    outfitDescription: [input.outfit.trim(), ...(input.garmentNotes ?? []).map((note) => note.trim())]
      .filter(Boolean)
      .join("; "),
    exposure,
    // Authoritative for this shot: the described outfit / exposed toggle overrides a clothed
    // reference avatar (same role exposedRegions played for the old default-outfit path).
    wardrobeTracked: true,
    appearance,
    // Identity-critical features (lips, skin tone, eyes, hair) reinforcing the avatar
    // reference — the render prompt keeps the reference authoritative over them.
    identityAnchors: identityAnchorSummary(resolved, input.profile),
    // The chat subject is the identity-locked reference (a waist-up portrait), so supplement it
    // with the figure it can't show: the SFW lower-body shape line (always) and exposure-gated
    // intimate anatomy (uncensored route, only when the outfit is flagged exposed).
    lowerBody: sceneRevealAppearance(resolved, exposure, input.profile, { intimate: false }),
    intimateAppearance: sceneRevealAppearance(resolved, exposure, input.profile, { intimate: true }),
  };

  return {
    present: [present],
    locationName: "the room",
    locationDescription: input.room,
    timeOfDay: input.timeOfDay?.trim() || "day",
    recentNarration: input.recentChat,
    // The chat lane is the iteration ground for image-prompt tuning, so embodied POV lands
    // here first (scene-pov-embodiment.plan.md §Lane scope) — the session lane keeps the
    // absolute player-is-invisible rule and its tests.
    embodiedViewer: true,
    ...(input.playerExposure ? { playerExposure: input.playerExposure } : {}),
    ...(input.playerAttributes ? { playerAttributes: input.playerAttributes } : {}),
    ...(input.playerProfile ? { playerProfile: input.playerProfile } : {}),
    // The viewer's intimate anatomy, exposure-gated exactly like the character's — the
    // render only emits it on an uncensored route AND when a gated part survived.
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

/** The minted place reference's bytes — owned + ready `chat_place`, else null (single-reference render). */
async function loadChatPlaceImage(ownerId: string, imageId: string): Promise<{ imageId: string; buffer: Buffer } | null> {
  const [row] = await db()
    .select()
    .from(images)
    .where(and(eq(images.id, imageId), eq(images.ownerId, ownerId), eq(images.kind, "chat_place"), eq(images.status, "ready")))
    .limit(1);
  if (!row) return null;
  try {
    return { imageId: row.id, buffer: await fs.readFile(absoluteImagePath(row)) };
  } catch {
    return null; // file lost — render single-reference; the sweep reconciles
  }
}

/** Read the character's canonical avatar for reference editing — owned + ready, else null (text-to-image). */
async function loadCharacterAvatar(
  ownerId: string,
  avatarImageId: string | null,
): Promise<{ imageId: string; buffer: Buffer; source: SceneReferenceSource } | null> {
  if (!avatarImageId) return null;
  const [row] = await db()
    .select()
    .from(images)
    .where(and(eq(images.id, avatarImageId), eq(images.ownerId, ownerId)))
    .limit(1);
  if (!row || row.status !== "ready") return null;
  try {
    const buffer = await fs.readFile(absoluteImagePath(row));
    const uploaded =
      row.meta && typeof row.meta === "object" && !Array.isArray(row.meta) && (row.meta as Record<string, unknown>).source === "upload";
    return { imageId: row.id, buffer, source: uploaded ? "uploaded" : "generated" };
  } catch {
    return null; // file lost — fall through to text-to-image
  }
}

/**
 * Render one character-chat scene image. Composes the spec (tool model), then
 * renders through the shared provider chain (scene.renderResolvedScene) with the
 * character's avatar as the single identity reference and the asset filed against
 * the character (no session).
 */
export async function renderCharacterSceneImage(input: RenderCharacterSceneInput): Promise<string> {
  const selfie = input.flavor === "selfie";
  const room = input.room?.trim() || DEFAULT_CHAT_ROOM;
  const context = buildCharacterSceneContext({
    name: input.name,
    profile: input.profile,
    room,
    timeOfDay: input.timeOfDay,
    recentChat: (input.recentChat ?? []).filter((t) => t.trim()),
    outfit: input.outfit ?? "",
    outfitExposed: input.outfitExposed ?? false,
    exposure: input.exposure,
    garmentNotes: input.garmentNotes,
    playerExposure: input.playerExposure,
    playerAttributes: input.playerAttributes,
    playerProfile: input.playerProfile,
    meters: input.meters,
    conditions: input.conditions,
  });
  const plan = await composeSceneSpec({ ...context, sink: input.sink });

  // Character-chat is a single subject (one library character, no location image),
  // so it renders single-reference by default: the avatar anchors the uncensored
  // edit. The render is fail-visible by construction (routeSceneProviders) — a
  // failed edit never degrades to a different-looking text-to-image person; only
  // when there's NO usable avatar does text-to-image stand in. The scene strip's
  // t2i style-swap pick was removed with the vocabulary (owner ruling 2026-07-29
  // — chatSceneModels is reference-only until more reference-capable models land).
  const referenceRoute = !isDemoMode() && hasVenice();
  // Anchor preference (chat-scene-references.plan.md): the cached outfit-true look
  // when its key matches the chat's current outfit/appearance, else the avatar.
  const look = referenceRoute && input.chatId && input.lookKey ? await latestChatLook(input.chatId, input.lookKey) : null;
  const anchor = look
    ? { imageId: look.imageId, buffer: look.buffer, source: "generated" as SceneReferenceSource }
    : referenceRoute
      ? await loadCharacterAvatar(input.userId, input.avatarImageId)
      : null;
  const referenceBuffers = new Map<string, Buffer>();
  if (anchor) referenceBuffers.set(anchor.imageId, anchor.buffer);

  // The place reference (second image → the multi-edit rung). Scenes only — a
  // selfie is the subject alone, and without a character anchor there is nothing
  // to compose the place against.
  const placeRef =
    !selfie && anchor && input.place && input.chatId ? await loadChatPlaceImage(input.userId, input.place.imageId) : null;
  if (placeRef) referenceBuffers.set(placeRef.imageId, placeRef.buffer);

  const renderOnce = (attemptPlan: SceneRenderPlan, allowIntimate: boolean): Promise<string> =>
    renderResolvedScene({
      plan: attemptPlan,
      references: [
        {
          kind: "character",
          entityId: input.characterId,
          name: input.name,
          role: "focal",
          allowForIntimate: allowIntimate,
          ...(anchor ? { imageId: anchor.imageId, source: anchor.source } : {}),
        },
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
      mode: placeRef ? "multi" : "single",
      framing: selfie ? "selfie" : undefined,
      flavor: input.flavor,
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

  const first = await renderOnce(plan, true);
  if (!selfie) return first;

  // Selfie failure policy (owner ruling 2026-07-11): determine WHY the first
  // attempt failed and try ONCE more — a content rejection retries with the
  // sanitized plan (intimate/exposure phrasing stripped), anything else retries
  // as-is (the transient case; the chain's own same-provider retry already ran).
  // The failed first row is dropped so exactly ONE tile shows; a second failure
  // stays a failed row whose prompt + error are the debug surface (the transcript
  // "Failed" placeholder enlarges to them).
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

/** The failed row's error message, or null when the render is not failed (pending/ready/missing). */
async function imageFailure(imageId: string): Promise<string | null> {
  const [row] = await db().select({ status: images.status, meta: images.meta }).from(images).where(eq(images.id, imageId)).limit(1);
  if (!row || row.status !== "failed") return null;
  const meta = row.meta && typeof row.meta === "object" && !Array.isArray(row.meta) ? (row.meta as Record<string, unknown>) : {};
  return typeof meta.error === "string" ? meta.error : "";
}

/**
 * Deterministic content-rejection sanitize (owner ruling — "determine via
 * inference why it failed"): strip the exposure + intimate-anatomy phrasing that
 * most plausibly tripped moderation, keep identity/pose/setting. The retry also
 * runs with `allowForIntimate: false`, so the render prompt drops the intimate
 * block even if a spec field survives.
 */
function sanitizeScenePlan(plan: SceneRenderPlan): SceneRenderPlan {
  const scrub = <T extends { exposure?: string; intimateAppearance?: string }>(spec: T): T => ({
    ...spec,
    exposure: undefined,
    intimateAppearance: undefined,
  });
  return {
    ...plan,
    focal: plan.focal ? scrub(plan.focal) : null,
    others: plan.others.map(scrub),
  };
}
