import { and, desc, eq, inArray, ne } from "drizzle-orm";
import type { AttributeValue } from "@/contracts/attributes/value";
import type { RegionExposure } from "@/contracts/items/visibility";
import { DiagnosticCollector, teeSink, type DiagnosticSink } from "@/contracts/diagnostics";
import { fnv1aHex } from "@/lib/hash";
import { logDiagnostics } from "@/server/log";
import { hasReplicate, isDemoMode } from "../ai";
import { db, images } from "../db";
import {
  IMAGE_TARGET_ASPECT,
  type IdentityReferenceProvenance,
  type ImageRenderReference,
  type ResolvedImageProfile,
} from "@vesper/image-core";
import { imageMeta, purgeImagesWhere, readImageBytes, runImagePipeline } from "./assets";
import { buildChatLookSegments, type ChatLookSegmentAssembly, type ChatLookVisualCut } from "./chat-look-segments";
import {
  buildCharacterPromptProgram,
  characterPromptTransport,
  type CharacterPromptProgramResult,
} from "./character-prompt-program";
import {
  characterChangeContract,
  characterChatLookImageOperation,
} from "@/contracts/images/character-digest";
import { identityPackRenderReferences } from "./identity-pack-consume";
import { resolveImageProfileForTask } from "./model-profiles";
import { renderAttemptMeta, renderImageIntent } from "./render-intent";
import { PORTRAIT_IDENTITY_LOCK } from "./prompts-variant";

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
 *   chat cut; a mint whose caller could not load a participant row has no cut to
 *   compile and falls back to `buildChatLookSegments`, the route-owned
 *   assembly that also owns this lane's refusal and its `meta.visualState`.
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
 * of clothes). Structured worn state replaces the old free-text `outfit` string; a
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
}): string {
  const worn = [...input.wornItemIds].sort().join(",");
  const { torso, pelvis, legs, feet } = input.exposure;
  const exposure = [torso, pelvis, legs, feet].map((r) => r[0]).join("");
  const overlays = [...input.attributeOverlays]
    .map((o) => `${o.id}=${JSON.stringify(o.value)}`)
    .sort()
    .join(";");
  const garments = input.garmentKey?.trim() ? `|${input.garmentKey.trim()}` : "";
  return fnv1aHex(`${worn}|${input.overlay.trim().toLowerCase()}|${exposure}|${overlays}${garments}`);
}

/**
 * The identity-locked look-edit instruction: same person, new outfit, neutral
 * framing. Age is inherited from the portrait reference; neither chronological
 * nor apparent-age fields are accepted by this scene-supporting render.
 *
 * RETAINED BUT UNCALLED BY PRODUCTION since the Stage 4 cutover:
 * `renderChatLookImage` now assembles its
 * prompt from `buildChatLookSegments`, which carries these three sentences as
 * route-owned segments beside the visual digest's facts. This builder stays in
 * the tree as the frozen comparison baseline (`prompt-freeze.test.ts`) exactly
 * as `buildAvatarPrompt` did, and Stage 6 deletes both.
 */
export function buildChatLookPrompt(input: { outfit: string; outfitExposed: boolean }): string {
  const outfit = input.outfit.trim();
  const wearing = outfit
    ? `Change the outfit: now wearing ${outfit}. Depict only this clothing — remove anything the reference wears that is not listed.`
    : input.outfitExposed
      ? "Remove the outfit: undressed."
      : "Keep a simple, casual outfit.";
  return [
    PORTRAIT_IDENTITY_LOCK,
    wearing,
    "Standing, relaxed neutral pose, facing the viewer; plain softly lit neutral backdrop; waist-up to three-quarter frame.",
  ]
    .filter(Boolean)
    .join(" ");
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

export interface RenderChatLookInput {
  chatId: string;
  userId: string;
  characterId: string;
  lookKey: string;
  outfit: string;
  outfitExposed: boolean;
  /**
   * This character's committed chat cut, as the shared factory
   * (`chatVisualStateShadowInput`) hands it over — the Stage 4 digest source.
   *
   * OPTIONAL, and the absence is a real production path: the caller could not
   * load a `chat_participants` row for this subject (corrupt membership), and
   * the mint degrades to the route-owned segments rather than refusing a
   * wardrobe anchor over a continuity id. Every pre-cutover call site (the
   * identity-render-lane tests, the lab baselines) supplies none.
   */
  visual?: ChatLookVisualCut;
  /**
   * The canonical garment-coverage readout — the same `wardrobe.exposure` the
   * look key hashed. Passed rather than recomputed so the anchor's coverage
   * reads and its cache key can never disagree.
   */
  exposure?: RegionExposure;
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
 * The chat-look mint's ACTIVE prompt program, or null when this mint has
 * nothing to compile (issue #256).
 *
 * Null is the route-only degraded mint: the caller could not load a
 * `chat_participants` row for this subject, so the assembly realized no cut and
 * there is no committed visual moment to compile a program over. That mint
 * keeps the route-owned segments, which is the degradation this lane has always
 * promised rather than refusing a wardrobe anchor over a continuity id.
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
 */
function activeChatLookProgram(
  input: RenderChatLookInput,
  assembly: ChatLookSegmentAssembly,
  resolved: ResolvedImageProfile,
  references: readonly ImageRenderReference[],
  sink: DiagnosticSink,
): CharacterPromptProgramResult | null {
  const visual = assembly.visual;
  const cut = input.visual;
  if (visual === undefined || cut === undefined) return null;
  const outfit = input.outfit.trim();
  return buildCharacterPromptProgram({
    lane: "chat_look",
    task: "chat_look",
    profile: resolved,
    bindingProfileKey: resolved.profile.key,
    resolver: "active",
    cuts: [
      {
        subjectId: input.characterId,
        digest: visual.digest,
        attributes: visual.attributes,
        exposure: visual.exposure,
        realizedBody: visual.realizedBody,
      },
    ],
    // The committed cut names itself: the cut id IS the staleness check, and a
    // minted token would throw that away.
    read: { kind: "committed_cut", token: cut.cutId },
    // Every reference this mint sends is the subject's own identity pack.
    references: references.map((reference) => ({ reference, subjectId: input.characterId })),
    operation: (subjects) =>
      characterChatLookImageOperation({
        change: characterChangeContract(
          {
            concept: "subject.wardrobe",
            // An empty outfit is a real instruction, not a missing one: the
            // conversation either undressed this character or settled on
            // nothing in particular, and the segment build already words both.
            // The concept is what the preserve derivation excludes either way.
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
 * differences from the avatar/entity shape, both deliberate. The Stage 4 digest
 * refusal joins that set rather than becoming a `failedPrecondition`: this job
 * re-fires on every outfit and appearance change, so a reserving refusal would
 * accumulate one failed row per change for every ineligible chat, forever.
 *
 * Both lanes also DRAIN their diagnostics into the process log (the scene
 * lane's collector pattern): the production caller is a detached job with no
 * sink, and a flag-on pack refusal returns null with no row reserved — without
 * the drain that refusal would be a look that silently never appears, with no
 * record anywhere of why.
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
    // The Stage 4 segment assembly runs BEFORE the identity pack is consulted:
    // it is pure and free, and refusing here costs no owned byte reads. Its
    // refusal has this lane's shape — no row, no mint, retry on the next
    // outfit or appearance change.
    const assembly = buildChatLookSegments({
      outfit: input.outfit,
      outfitExposed: input.outfitExposed,
      ...(input.visual === undefined ? {} : { shadow: input.visual }),
      ...(input.exposure === undefined ? {} : { exposure: input.exposure }),
      sink,
    });
    if (assembly.refusal !== null) return null;
    const identity = await chatLookIdentity(input, resolved, sink);
    if (!identity) return null;
    const model = resolved.model;
    // The cutover (issue #256): the prompt this mint sends is the compiled
    // prompt program. A refusal takes this lane's own refusal shape rather than
    // failing a row — no row, no mint, retry on the next outfit or appearance
    // change — because this job re-fires on every change and a reserving refusal
    // would accumulate one failed row per change for every ineligible chat,
    // forever. It is NOT a fallback to the legacy prose: a bound lane that could
    // not compile is a fault to surface, and minting a plausible anchor from the
    // string the program replaced would hide it behind an acceptable-looking
    // face that every later scene then composes from.
    const program = activeChatLookProgram(input, assembly, resolved, identity.references, sink);
    if (program?.kind === "refused") return null;
    const compiled = program?.kind === "compiled" ? program : null;
    // Prompt, segments and any compiled negative in ONE decision — a compiled
    // mint must not still carry the legacy segments, which `resolveIntentPrompt`
    // would prefer over the compiled string.
    const transport = characterPromptTransport(assembly.prompt, assembly.segments, compiled);
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
          ...(assembly.digestMeta ?? {}),
          // The compiled program's own provenance. Absent on the route-only
          // degraded mint, which is how a row says which prompt system built it.
          ...(compiled?.meta ?? {}),
        },
      },
      produce: async () => {
        const edit = await renderImageIntent(
          {
            profile: resolved,
            // Prompt, segments and the normalized negative in one decision. On
            // the route-only degraded mint the semantic segments stay
            // authoritative and `prompt` is the same segments compiled — safe to
            // send both, because this lane's profile runs `instruction_edit`,
            // which passes the base prompt through unchanged. On a compiled mint
            // the segments are absent, or they would outrank the program.
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