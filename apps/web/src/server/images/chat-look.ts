import { and, desc, eq, inArray, ne } from "drizzle-orm";
import {
  exposedRegions,
  FULLY_COVERED,
  HAIR_OCCLUSION_NONE,
  realizeBody,
  resolveAttributes,
  type AttributeValue,
  type HairOcclusion,
  type RealizedBody,
  type RegionExposure,
  type SceneCameraSpec,
  type VisualImageDigest,
} from "@/contracts";
import { diag, DiagnosticCollector, teeSink, type DiagnosticSink } from "@/contracts/diagnostics";
import { fnv1aHex } from "@/lib/hash";
import { logDiagnostics } from "@/server/log";
import {
  safeBuildVisualStateShadow,
  visualStateImageDigestOfShadow,
  type VisualStateShadowInput,
} from "@/server/visual-state";
import { hasReplicate, isDemoMode } from "../ai";
import { db, images } from "../db";
import {
  IMAGE_TARGET_ASPECT,
  type IdentityReferenceProvenance,
  type ImageRenderReference,
  type ResolvedImageProfile,
} from "@vesper/image-core";
import { imageMeta, readImageBytes } from "./asset-storage";
import { purgeImagesWhere } from "./asset-deletion";
import { runImagePipeline } from "./assets";
import {
  buildCharacterPromptProgram,
  characterPromptTransport,
  characterPromptUnboundRefusal,
  type CharacterPromptProgramResult,
} from "./character-prompt-program";
import {
  characterChangeContract,
  characterChatLookImageOperation,
} from "@/contracts/images/character-digest";
import { identityPackRenderReferences } from "./identity-pack-consume";
import { resolveImageProfileForTask } from "./model-profiles";
import { renderAttemptMeta, renderImageIntent } from "./render-intent";

/**
 * Chat reference images: the two cached anchors
 * that keep a conversation's renders visually consistent —
 *
 * - **`chat_look`**: an outfit-true, identity-locked variant of the avatar,
 *   re-minted when the fiction re-dresses the character (archivist outfit change
 *   / appearance overlays — the look KEY hashes all three, owner ruling). Scenes
 *   and selfies anchor on it instead of the always-dressed avatar, so renders
 *   stop arguing the edit model out of repainting the reference's clothes. Only
 *   the LATEST look is kept (ruled); the cache pointer is the images table
 *   itself (`meta.lookKey` on the newest ready row) — no state column, so a
 *   regenerate rollback can never desync pointer from asset. Its prompt is the
 *   compiled prompt program (#256, `activeChatLookProgram`) over the committed
 *   chat cut, and that program is the mint's ONLY prompt: a mint with no cut to
 *   compile, or whose program will not compile, mints nothing.
 * - **`chat_place`**: a text-to-image establishing shot of the current
 *   scene-memory place, minted lazily from its agent-written sketch on the
 *   first render there; feeds the chat lane's multi-edit rung as the second
 *   reference so settings stay consistent across a conversation's scenes.
 *
 * Both kinds are chat-keyed, Gallery-hidden (its queries are kind-filtered),
 * and hard-deleted with the conversation.
 */

/**
 * The look cache key (chat-wardrobe-parity — new key shape, ruled): sorted structured
 * worn item ids + the free-text overlay + a coverage-computed exposure fingerprint +
 * appearance-relevant narrative overlays (a haircut invalidates the look like a change
 * of clothes) + the garment fingerprint and the hair-occlusion band, each appended only
 * when it says something. Structured worn state replaces the old free-text `outfit` string; a
 * legacy/free-text chat (empty worn list) keys on the overlay alone, so its key stays
 * stable across the change. PURE and order-stable.
 *
 * A DETERMINISM SEAM: this is the `meta.lookKey` `latestChatLook` compares, so if
 * the assembled string or its hash ever moves, every existing chat silently
 * re-renders its anchor. Golden-pinned in `chat-look.test.ts` and `lib/hash.test.ts`.
 */
export function chatLookKey(input: {
  wornItemIds: readonly string[];
  overlay: string;
  exposure: RegionExposure;
  attributeOverlays: readonly AttributeValue[];
  /**
   * The garment store's structural fingerprint (audit OQ8, `chatGarmentLookKey`):
   * worn INSTANCE set + presentation bands + wetness from `wet` up + deposit/damage
   * presence. Without it, arranging a garment — opening a placket, rolling a
   * sleeve, doffing one of two identical shirts — leaves the definition-id list
   * unchanged and the anchor stale.
   *
   * Appended only when non-empty, so an unmodelled chat hashes exactly as before
   * and no cached look invalidates on this change alone.
   */
  garmentKey?: string;
  /**
   * The wardrobe resolve's hair-occlusion band (`resolveChatWardrobe`), the same
   * value the mint's cut renders from. The band is an item-level override, so
   * a headwear edit from `none` to `full` moves the render input while the worn
   * id list, the exposure fingerprint and the garment fingerprint all stay put —
   * without this term `latestChatLook` reads the old visible-hair anchor as
   * fresh and every later scene composes from it.
   *
   * Appended only for a covering band (`partial` or `full`): `none` and absent
   * hash byte-identically to the key before the band existed, so no uncovered
   * chat's cached look invalidates on this change alone, while a covered-hair
   * chat's pre-band anchor (minted with hair showing) misses and re-mints. This
   * is the key gate only — the enqueue is its own gate (`chat-state.ts`), and a
   * band change that never fires the enqueue cannot be fixed here.
   */
  hairOcclusion?: HairOcclusion;
}): string {
  const worn = [...input.wornItemIds].sort().join(",");
  const { torso, pelvis, legs, feet } = input.exposure;
  const exposure = [torso, pelvis, legs, feet].map((r) => r[0]).join("");
  const overlays = [...input.attributeOverlays]
    .map((o) => `${o.id}=${JSON.stringify(o.value)}`)
    .sort()
    .join(";");
  const garments = input.garmentKey?.trim() ? `|${input.garmentKey.trim()}` : "";
  const hair =
    input.hairOcclusion === undefined || input.hairOcclusion === HAIR_OCCLUSION_NONE
      ? ""
      : `|hair=${input.hairOcclusion}`;
  return fnv1aHex(`${worn}|${input.overlay.trim().toLowerCase()}|${exposure}|${overlays}${garments}${hair}`);
}

/** True when this conversation has ever rendered an image (the ruled mint gate). */
export async function chatHasRenders(chatId: string): Promise<boolean> {
  const [row] = await db()
    .select({ id: images.id })
    .from(images)
    .where(and(eq(images.chatId, chatId), inArray(images.kind, ["scene", "chat_look"])))
    .limit(1);
  return row !== undefined;
}

/**
 * The newest ready look for one CHARACTER in this chat WITH a matching key,
 * loaded with its bytes; null ⇒ anchor on that character's avatar.
 *
 * Scoped by `entityId`, not by chat alone: a chat's roster holds up to four
 * characters, and a chat-wide read would hand one character's look to another —
 * dressing the wrong face in the wrong outfit. The rows have always carried
 * `entityId` (the mint sets it); only the read and the keep-latest purge were
 * chat-wide, which was safe while the exchange minted a look for the primary
 * alone and stops being safe the moment a second cast member anchors.
 */
export async function latestChatLook(
  chatId: string,
  characterId: string,
  lookKey: string,
): Promise<{ imageId: string; buffer: Buffer } | null> {
  const [row] = await db()
    .select()
    .from(images)
    .where(
      and(
        eq(images.chatId, chatId),
        eq(images.entityId, characterId),
        eq(images.kind, "chat_look"),
        eq(images.status, "ready"),
      ),
    )
    .orderBy(desc(images.createdAt))
    .limit(1);
  if (!row) return null;
  if (imageMeta(row.meta).lookKey !== lookKey) return null;
  const buffer = await readImageBytes(row);
  return buffer ? { imageId: row.id, buffer } : null; // no bytes — the sweep reconciles; fall back to the avatar
}

// ---------------------------------------------------------------------------
// The look mint's cut
// ---------------------------------------------------------------------------

/**
 * The look mint's fixed viewpoint: facing the camera at medium distance, which
 * `visualCameraReadsOfSceneCamera` maps to the `waist_up` framing band — the
 * same spec the avatar's portrait studio uses. This is a studio viewpoint, not
 * a committed scene camera: the mint is a wardrobe anchor, and a look keyed to
 * whatever the fiction's camera happened to be doing would invalidate on every
 * shot change.
 */
export const CHAT_LOOK_CAMERA: SceneCameraSpec = {
  orientation: "toward_viewer",
  distance: "medium",
  height: "eye_level",
};

/** The camera id the selection fingerprints. */
export const CHAT_LOOK_CAMERA_ID = "chat_look_studio";

/**
 * The caller supplied no committed cut for the look subject (a missing
 * `chat_participants` row — corrupt membership). The mint has nothing to
 * compile a program over, and this lane's refusal shape applies: no row, no
 * mint, retry on the next outfit or appearance change.
 */
export const CHAT_LOOK_VISUAL_CUT_MISSING = "images.chat_look.visual_cut_missing";
/** The shadow assembly failed; the mint refuses before reserving a row. */
export const CHAT_LOOK_VISUAL_DIGEST_UNAVAILABLE = "images.chat_look.visual_digest_unavailable";
/** The chat-look profile's model has no active prompt binding; the mint refuses before reserving a row. */
export const CHAT_LOOK_PROGRAM_UNBOUND = "images.chat_look.program_unbound";

/** One subject's committed chat cut, as the shared factory hands it over. */
export type ChatLookVisualCut = Omit<VisualStateShadowInput, "sink" | "camera">;

/** The realized cut the mint's program compiles from, plus its row provenance. */
export interface ChatLookCut {
  readonly digest: VisualImageDigest;
  /**
   * The resolve the adapter values facts from: authored base → persisted
   * narrative overlays, the layer `chatLookKey` hashes. The condition layer is
   * deliberately absent ({@link chatLookSubjectCut}).
   */
  readonly attributes: readonly AttributeValue[];
  readonly realizedBody: RealizedBody;
  /** The canonical coverage readout the exposure claims are made over. */
  readonly exposure: RegionExposure;
  /** How much of the subject's hair their worn headwear hides (the wardrobe seam's resolved band). */
  readonly hairOcclusion: HairOcclusion;
  /** The `meta.visualState` fragment the row records at reserve time. */
  readonly digestMeta: Record<string, unknown>;
}

export interface ChatLookCutInput {
  readonly cut: ChatLookVisualCut;
  /**
   * The canonical garment-coverage readout — the SAME `wardrobe.exposure` the
   * look key hashed. Absent falls back to the caller's binary exposed flag, the
   * scene lane's own default for a member with no resolved readout.
   */
  readonly exposure?: RegionExposure;
  /** The same resolve's hair-occlusion band; absent (no resolved wardrobe) reads `none`. */
  readonly hairOcclusion?: HairOcclusion;
  /** True when the resolved wardrobe positively says the body is exposed. */
  readonly outfitExposed: boolean;
  readonly sink?: DiagnosticSink;
}

/**
 * The committed cut, narrowed to what a CACHE-KEYED studio anchor may compile
 * from: one subject, resolved over the layers the key hashes.
 *
 * `chatLookKey` hashes one person's worn set, coverage, appearance overlays,
 * garment fingerprint and hair band, and the shared cut carries two things
 * beyond that which no pack suppression can reach — each either refuses the
 * mint or moves the prompt for a fact the key never saw:
 *
 * - **A second subject.** The shared factory files the player's worn garments
 *   and recorded body language under the player subject, and a garment left in
 *   the room under the scene subject. Each becomes a digest subject with no
 *   owners behind it, and the identity-critical compile refuses on its missing
 *   age and coverage anchors — so a coat over a chair, or the player's posture,
 *   would leave the chat with no anchor at all until it changed. The look cut
 *   carries no player subject and no scene subject, and its scene map keeps
 *   only this subject's own participant, so the snapshot names one person. The
 *   subject's own body language still projects; the pack suppresses it.
 * - **The condition layer's attribute overlays.** A condition's
 *   `attributeEffects` resolve at a precedence above the narrative overlays the
 *   key hashes, and the morphology band reads every attribute in its group, so
 *   a wing carriage or a grooming standard overlaid by a condition moves the
 *   prompt while the key stands. The conditions keep their own current-layer
 *   facts (the pack suppresses those) but hand the assembly no effects, so the
 *   projection and {@link ChatLookCut.attributes} both resolve base → persisted
 *   narrative overlays and nothing further.
 */
function chatLookSubjectCut(cut: ChatLookVisualCut): ChatLookVisualCut {
  const { sceneRelations, conditions } = cut;
  return {
    ...cut,
    playerSubjectId: undefined,
    sceneSubjectId: undefined,
    ...(sceneRelations === undefined
      ? {}
      : {
          sceneRelations: {
            scene: sceneRelations.scene,
            subjectsByParticipant: new Map(
              [...sceneRelations.subjectsByParticipant].filter(([, subjectId]) => subjectId === cut.subjectId),
            ),
          },
        }),
    ...(conditions === undefined
      ? {}
      : { conditions: conditions.map((condition) => ({ ...condition, attributeEffects: [] })) }),
  };
}

/**
 * Realize the look mint's cut from a committed chat cut. One shadow assembly,
 * ONE camera-bound selection pass, one digest realized from that exact
 * selection — never a re-select (`image-digest.ts` §Reuse the selection). The
 * committed cut arrives from `runChatLookImage`, which builds it through the
 * shared chat factory (`chatVisualStateShadowInput`) — the same one the scene
 * queue and the visual-state inspector use, so a look anchor and the scene
 * that anchors on it can never assemble two different cuts of one
 * conversation. This lane then narrows it to the look subject alone
 * ({@link chatLookSubjectCut}) before anything is assembled.
 *
 * Null when the shadow assembly threw ({@link CHAT_LOOK_VISUAL_DIGEST_UNAVAILABLE}
 * is on the sink); the caller mints nothing. Deterministic over its inputs.
 */
export function buildChatLookCut(input: ChatLookCutInput): ChatLookCut | null {
  const { cut, sink } = input;
  const build = safeBuildVisualStateShadow(
    {
      ...chatLookSubjectCut(cut),
      // The look mint's own studio viewpoint, bound into the ONE selection pass.
      camera: { cameraId: CHAT_LOOK_CAMERA_ID, spec: CHAT_LOOK_CAMERA },
      ...(sink === undefined ? {} : { sink }),
    },
    sink,
  );
  if (build === null) {
    sink?.push(
      diag("error", CHAT_LOOK_VISUAL_DIGEST_UNAVAILABLE, "the visual digest could not be assembled for this look", {
        path: "images.chat_look",
        context: { subjectId: cut.subjectId, cutId: cut.cutId },
      }),
    );
    return null;
  }

  // This job realizes the cut it just assembled, so `forCutId` names the same
  // id and the digest's stale-cut gate stays a seam contract rather than a live
  // branch.
  const realized = visualStateImageDigestOfShadow(build, {
    forCutId: cut.cutId,
    ...(sink === undefined ? {} : { sink }),
  });

  // The same resolve the projection was taken over — base → persisted
  // narrative overlays, the condition layer withheld (`chatLookSubjectCut`) —
  // read back off the cut so the adapter can never disagree with the digest
  // about a recorded haircut or dye.
  const attributes = resolveAttributes(cut.attributes, [...(cut.attributeOverlays ?? [])]);
  return {
    digest: realized.digest,
    attributes,
    realizedBody: realizeBody(cut.realize ?? {}),
    exposure: input.exposure ?? (input.outfitExposed ? exposedRegions([]) : FULLY_COVERED),
    hairOcclusion: input.hairOcclusion ?? HAIR_OCCLUSION_NONE,
    digestMeta: realized.meta,
  };
}

// ---------------------------------------------------------------------------
// The look mint
// ---------------------------------------------------------------------------

export interface RenderChatLookInput {
  chatId: string;
  userId: string;
  characterId: string;
  lookKey: string;
  outfit: string;
  outfitExposed: boolean;
  /**
   * This character's committed chat cut, as the shared factory
   * (`chatVisualStateShadowInput`) hands it over — the mint's digest source.
   *
   * OPTIONAL because the caller may have none to give: a missing
   * `chat_participants` row (corrupt membership) builds no cut. The mint then
   * REFUSES rather than degrading — a wardrobe anchor phrased from nothing is
   * a face every later scene composes from, and there is no second prompt
   * system to phrase it with ({@link CHAT_LOOK_VISUAL_CUT_MISSING}).
   */
  visual?: ChatLookVisualCut;
  /**
   * The canonical garment-coverage readout — the same `wardrobe.exposure` the
   * look key hashed. Passed rather than recomputed so the anchor's coverage
   * reads and its cache key can never disagree.
   */
  exposure?: RegionExposure;
  /** The same resolve's hair-occlusion band, carried with `exposure`. */
  hairOcclusion?: HairOcclusion;
  sink?: DiagnosticSink;
}

/** What one look mint sends as its identity, and what it records for having sent it. */
interface ChatLookIdentity {
  references: ImageRenderReference[];
  provenance: IdentityReferenceProvenance[];
}

/**
 * Source the look edit's identity reference(s) through the pack service:
 * profile-aware eligibility, one-or-more candidate roles, owned byte reads,
 * and the provenance the row records for having sent them.
 *
 * Null refuses the mint with no row reserved, this lane's precondition shape:
 * an unusable or unreadable identity source means "no mint, re-fire on the
 * next change" rather than substituting another image (the integration spec's
 * prohibition). Diagnostics already sit on the sink by the time null is
 * returned.
 */
async function chatLookIdentity(
  input: RenderChatLookInput,
  resolved: ResolvedImageProfile,
  sink: DiagnosticSink,
): Promise<ChatLookIdentity | null> {
  const pack = await identityPackRenderReferences({
    ownerId: input.userId,
    characterId: input.characterId,
    profile: resolved,
    sink,
  });
  if (!pack.ok) return null;
  return { references: pack.references.map((entry) => entry.reference), provenance: pack.provenance };
}

/**
 * The chat-look mint's prompt program over its cut (issue #256).
 *
 * `chat-look-standard` on Qwen Image Edit 2511 is the only chat-look profile the
 * catalog offers, and it is bound; the profile key still narrows resolution, so
 * a second chat-look profile added later cannot inherit this one's packs.
 *
 * The change contract states the delta this mint IS — the outfit the
 * conversation just settled on — and derives its preserve set from the assembled
 * subject slices, so the identity, morphology and age anchors the change does
 * not name survive the edit by derivation rather than by a blanket "preserve
 * everything".
 *
 * For a fixed look key the compiled prompt is a function of the key's inputs
 * alone. The committed cut states more than `chatLookKey` hashes — the current
 * layer (wetness, garment condition, active conditions) and body language —
 * and two mints under one key must not send two prompts, or the cached anchor
 * goes stale for a fact that never moved the key and bakes a transient state
 * into the reference every later scene composes from. The omission is the
 * chat-look binding's own positive pack (`packs-qwen-2511.ts`,
 * `pack-qwen-2511-positive-chat-look-v1`), which suppresses
 * `subject.current_state` and `subject.body_language`, so the row's program
 * provenance shows the anchor was compiled without them; this function passes
 * the realized cut and filters nothing itself. What the pack cannot reach —
 * a second digest subject, the condition layer's attribute overlays — never
 * enters the cut ({@link chatLookSubjectCut}). Exported for the lane's test,
 * which pins that invariant.
 */
export function activeChatLookProgram(
  input: RenderChatLookInput,
  cut: ChatLookCut,
  resolved: ResolvedImageProfile,
  references: readonly ImageRenderReference[],
  sink: DiagnosticSink,
): CharacterPromptProgramResult {
  const outfit = input.outfit.trim();
  return buildCharacterPromptProgram({
    lane: "chat_look",
    task: "chat_look",
    profile: resolved,
    bindingProfileKey: resolved.profile.key,
    cuts: [
      {
        subjectId: input.characterId,
        digest: cut.digest,
        attributes: cut.attributes,
        exposure: cut.exposure,
        hairOcclusion: cut.hairOcclusion,
        realizedBody: cut.realizedBody,
      },
    ],
    // The committed cut names itself: the cut id IS the staleness check, and a
    // minted token would throw that away.
    read: { kind: "committed_cut", token: input.visual?.cutId ?? "" },
    // Every reference this mint sends is the subject's own identity pack.
    references: references.map((reference) => ({ reference, subjectId: input.characterId })),
    operation: (subjects) =>
      characterChatLookImageOperation({
        change: characterChangeContract(
          {
            concept: "subject.wardrobe",
            // An empty outfit is a real instruction, not a missing one: the
            // conversation either undressed this character or settled on
            // nothing in particular. The concept is what the preserve
            // derivation excludes either way.
            value: outfit.length > 0 ? outfit : input.outfitExposed ? "nothing" : "a simple, casual outfit",
          },
          subjects,
        ),
      }),
    // The anchor is the face every later scene in this conversation composes
    // from, so a lost identity or morphology anchor is worth more than a
    // wardrobe refresh. It refuses, and this lane's refusal shape applies: no
    // row, no mint, retry on the next outfit or appearance change.
    refuseOnMissingRequired: true,
    sink,
  });
}

/**
 * Mint (or refresh) the chat's current-look reference: one identity-locked edit
 * from the avatar wearing the tracked outfit, on the shared reserve → generate →
 * save-or-fail → log shell (`runImagePipeline`). On success every OTHER
 * `chat_look` row for the chat deletes (keep-latest, ruled). Failures mark the
 * row failed and return null — the anchor loader just keeps falling back to the
 * avatar and the outfit-change trigger re-fires on the next change. Never throws.
 *
 * Both anchor lanes check their preconditions BEFORE reserving anything (a
 * keyless or demo chat leaves no row at all) and log no event — the two
 * differences from the avatar/entity shape, both deliberate. A missing cut, a
 * digest that will not assemble, a refused or unbound program all join that
 * set rather than becoming a `failedPrecondition`: this job re-fires on every
 * outfit and appearance change, so a reserving refusal would accumulate one
 * failed row per change for every ineligible chat, forever.
 *
 * Both lanes also DRAIN their diagnostics into the process log (the scene
 * lane's collector pattern): the production caller is a detached job with no
 * sink, and a refusal returns null with no row reserved — without the drain
 * that refusal would be a look that silently never appears, with no record
 * anywhere of why.
 */
export async function renderChatLookImage(input: RenderChatLookInput): Promise<string | null> {
  if (isDemoMode() || !hasReplicate()) return null;
  const collected = new DiagnosticCollector();
  const sink: DiagnosticSink = input.sink ? teeSink(input.sink, collected) : collected;
  try {
    // The look anchor is an identity edit of the avatar, so its task's default
    // profile sits on the same model the scene picker defaults to rather than
    // having a control of its own.
    const resolved = await resolveImageProfileForTask("chat_look", null, sink);
    if (!resolved) return null;
    // The cut is realized BEFORE the identity pack is consulted: it is pure and
    // free, and refusing here costs no owned byte reads. A caller with no cut
    // to give has nothing this mint can compile, and it is NOT a fallback to a
    // second prompt system: minting a plausible anchor from a string would
    // hide the corrupt membership behind an acceptable-looking face that every
    // later scene then composes from.
    if (input.visual === undefined) {
      sink.push(
        diag("warn", CHAT_LOOK_VISUAL_CUT_MISSING, "no committed cut for the look subject — no anchor is minted", {
          path: "images.chat_look",
          context: { chatId: input.chatId, characterId: input.characterId },
        }),
      );
      return null;
    }
    const cut = buildChatLookCut({
      cut: input.visual,
      outfitExposed: input.outfitExposed,
      ...(input.exposure === undefined ? {} : { exposure: input.exposure }),
      ...(input.hairOcclusion === undefined ? {} : { hairOcclusion: input.hairOcclusion }),
      sink,
    });
    if (cut === null) return null;
    const identity = await chatLookIdentity(input, resolved, sink);
    if (!identity) return null;
    const model = resolved.model;
    // The prompt this mint sends is the compiled prompt program, and nothing
    // else. A refusal already pushed the seam's diagnostic; an unbound model
    // pushes the lane's here, because the seam records nothing for an ordinary
    // "no row". Either way this lane's refusal shape applies: no row, no mint,
    // retry on the next outfit or appearance change.
    const program = activeChatLookProgram(input, cut, resolved, identity.references, sink);
    if (program.kind === "unbound") {
      sink.push(
        diag("warn", CHAT_LOOK_PROGRAM_UNBOUND, characterPromptUnboundRefusal(program), {
          path: "images.chat_look",
          context: { chatId: input.chatId, characterId: input.characterId, model: program.modelSlug, profileKey: program.profileKey },
        }),
      );
      return null;
    }
    if (program.kind === "refused") return null;
    const transport = characterPromptTransport(program);
    const { imageId, status } = await runImagePipeline({
      asset: {
        ownerId: input.userId,
        kind: "chat_look",
        entityKind: "character",
        entityId: input.characterId,
        chatId: input.chatId,
        prompt: transport.prompt,
        meta: {
          lookKey: input.lookKey,
          model: `replicate/${model.slug}`,
          identityReferences: identity.provenance,
          // The digest provenance lands at RESERVE time beside the key, so the
          // visual moment that shaped the prompt survives a failed render — the
          // avatar and scene lanes record it the same way.
          ...cut.digestMeta,
          // The compiled program's own provenance.
          ...program.meta,
        },
      },
      produce: async () => {
        const edit = await renderImageIntent(
          {
            profile: resolved,
            ...transport,
            references: identity.references,
            target: { aspectRatio: IMAGE_TARGET_ASPECT },
          },
          sink,
        );
        // A failure still THROWS (this lane's ruled failure shape), so provenance
        // is recorded only on success — a thrown produce has no meta channel.
        if (!edit.ok || !edit.image) throw new Error(edit.error ?? `${model.slug} returned no image`);
        return { ok: true, image: edit.image, ...renderAttemptMeta(edit.attempt) };
      },
      // Keep-latest (ruled), PER CHARACTER: the superseded looks go with their
      // files. Scoped by `entityId` for the same reason the loader above is — a
      // chat-wide purge makes two cast members evict each other's anchor on every
      // mint, so neither ever has one when the scene renders.
      onReady: async (asset) => {
        await purgeImagesWhere(
          and(
            eq(images.chatId, input.chatId),
            eq(images.entityId, input.characterId),
            eq(images.kind, "chat_look"),
            ne(images.id, asset.id),
          ),
        );
      },
      failureDiagnostic: { code: "images.chat_look.failed" },
      sink,
    });
    // A save that never reached `ready` already pushed its own diagnostic.
    return status === "ready" ? imageId : null;
  } finally {
    logDiagnostics("images.chat_look", collected.items, { chatId: input.chatId, characterId: input.characterId });
  }
}

export interface RenderChatPlaceInput {
  chatId: string;
  userId: string;
  placeName: string;
  /** The agent-written visual sketch (chat_scene_sketch) — the whole prompt source. */
  sketch: string;
  sink?: DiagnosticSink;
}

/** The place establishing-shot prompt: the sketch verbatim, empty of people (the entity-image rule). */
export function buildChatPlacePrompt(input: { placeName: string; sketch: string }): string {
  return `An establishing shot of ${input.placeName}: ${input.sketch.trim()} No people anywhere in frame; the space itself is the subject. Natural, grounded lighting.`;
}

/**
 * Mint the current place's reference image from its sketch (text-to-image on the
 * shared scene default model). Returns the ready asset id, or null on any
 * failure — the caller's CAS simply never writes and the lazy trigger re-fires
 * on the next render there. Never throws.
 */
export async function renderChatPlaceImage(input: RenderChatPlaceInput): Promise<string | null> {
  if (isDemoMode() || !hasReplicate() || !input.sketch.trim()) return null;
  const collected = new DiagnosticCollector();
  const sink: DiagnosticSink = input.sink ? teeSink(input.sink, collected) : collected;
  try {
    // A place shot is text-to-image with no subject to preserve, so its task's
    // default profile sits on the general-purpose model the way the item/location
    // lanes' do.
    const resolved = await resolveImageProfileForTask("chat_place", null, sink);
    if (!resolved) return null;
    const model = resolved.model;
    const prompt = buildChatPlacePrompt(input);
    const { imageId, status } = await runImagePipeline({
      asset: {
        ownerId: input.userId,
        kind: "chat_place",
        chatId: input.chatId,
        prompt,
        meta: { placeName: input.placeName, model: `replicate/${model.slug}` },
      },
      produce: async () => {
        // 3:2 landscape — an establishing shot, not a portrait.
        const shot = await renderImageIntent(
          { profile: resolved, prompt, references: [], target: { aspectRatio: 3 / 2 } },
          sink,
        );
        // A failure still THROWS (this lane's ruled failure shape), so provenance
        // is recorded only on success — a thrown produce has no meta channel.
        if (!shot.ok || !shot.image) throw new Error(shot.error ?? `${model.slug} returned no image`);
        return { ok: true, image: shot.image, ...renderAttemptMeta(shot.attempt) };
      },
      failureDiagnostic: { code: "images.chat_place.failed" },
      sink,
    });
    return status === "ready" ? imageId : null;
  } finally {
    logDiagnostics("images.chat_place", collected.items, { chatId: input.chatId, placeName: input.placeName });
  }
}
