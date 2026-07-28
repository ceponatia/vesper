import type { NextRequest } from "next/server";
import { z } from "zod";
import {
  activeConditionSchema,
  attributeValueSchema,
  characterProfileSchema,
  CHAT_MIND_NOTE_MAX_CHARS,
  CHAT_PREMISE_MAX_CHARS,
  chatDrivesSchema,
  chatPlansSchema,
  chatSceneModels,
  DiagnosticCollector,
  effectiveTraitValue,
  emptyCharacterProfile,
  garmentActorForCharacter,
  garmentOperationListSchema,
  relationshipTextureSchema,
  socialReactionCardSchema,
  chatPlayerStateSchema,
  supportingCastSchema,
  type CharacterProfile,
} from "@/contracts";
import { calendarStartSchema } from "@/lib/clock";
import { parseOr } from "@/lib/parse";
import { jsonError, jsonOk, readBody, withUser } from "@/server/api";
import {
  chatFeelingStateSchema,
  chatStateSnapshot,
  garmentReadoutsFor,
  selfieHistorySchema,
  driftChatState,
  editChatState,
  loadChatScenario,
  loadChatState,
  readSimChatClock,
  readSimChatMeters,
  readSimChatOutfit,
  readSimChatRelationship,
  resolveChatWardrobe,
  resolveSeededOutfit,
  seedChatScenario,
  seedChatState,
} from "@/server/engine";
import { chatBusyResponse, loadOwnedChat, type OwnedChat } from "../../owned";

type Params = { chatId: string };

/**
 * The conversation-state API (character-chat-state.spec.md §5 + slice 4), keyed per
 * participant (character-chat-standalone.spec.md §1.2), a sibling of the plain-text
 * reply stream so state never inlines into prose:
 *
 * - **GET** → the strip / premise-bar / state-tools snapshot, with the same
 *   drift-on-read the prompt build applies. No row ⇒ a rested seed from the
 *   authored defaults.
 * - **PATCH** → an author edit (premise **Save** + the state-tools modal): upsert
 *   the provided fields (seeding the rest if absent).
 *
 * The action chips no longer POST here — a tap is now a narrated `action_beat`
 * exchange through the chat pipeline (chat-action-beats.plan.md), which applies the
 * same deterministic effect pre-narration so the reply reflects it.
 */

const editBodySchema = z.object({
  premise: z.string().trim().max(CHAT_PREMISE_MAX_CHARS).optional(),
  regard: z.number().int().min(-100).max(100).optional(),
  familiarity: z.number().int().min(0).max(100).optional(),
  /** Authored relationship texture (kind/history/mask/looming) — the state-tools edit surface. */
  relationship: relationshipTextureSchema.optional(),
  mindNote: z.string().trim().max(CHAT_MIND_NOTE_MAX_CHARS).optional(),
  meters: z.record(z.string(), z.number()).optional(),
  conditions: z.array(activeConditionSchema).optional(),
  /** Structured worn item-definition ids (chat-wardrobe-parity rung 3) — the sheet's equip editor. */
  wornItemIds: z.array(z.string().trim().min(1)).max(40).optional(),
  /** The active outfit preset id (rung 1) — the sheet's preset switcher. */
  outfitPresetId: z.string().max(120).optional(),
  outfit: z.string().optional(),
  outfitExposed: z.boolean().optional(),
  /**
   * Typed garment operations (clothing-state-graph slice 3) — the sheet's
   * presentation controls. `garmentOperationListSchema` is the trust boundary:
   * it drops each malformed operation individually and caps the list, so one bad
   * entry never voids the save (docs/resilience.md §1).
   */
  garmentOperations: garmentOperationListSchema.optional(),
  activeSocialCards: z.array(socialReactionCardSchema).optional(),
  // Inspector-grade fields (character-chat-standalone.spec.md §6.1): the dev/state-tools
  // surface can rewrite everything stored — including the D11 gate bypass via `regard`.
  openLoops: z.array(z.string().trim().max(200)).max(6).optional(),
  memoryQueries: z.array(z.string().trim().max(200)).max(6).optional(),
  surfacedCues: z.record(z.string(), z.string()).optional(),
  attributeOverlays: z.array(attributeValueSchema).optional(),
  /** Auto scene-generation mode (slice 9): "off" | "milestones" (the scenario modal's toggle). */
  sceneAuto: z.enum(["off", "milestones"]).optional(),
  /** Scene-image model pick (the scene strip's save-on-select dropdown). */
  sceneModel: z.enum(chatSceneModels).optional(),
  /** Memory-callback ring (memory-callbacks.plan.md) — inspector-grade reset/edit. */
  callbackHistory: z.array(z.object({ ref: z.string().max(80), atClockMinutes: z.number() })).max(20).optional(),
  /** Emotional weather (emotional-weather.plan.md) — inspector-grade set/clear. */
  feeling: chatFeelingStateSchema.optional(),
  /** Selfie-send ring (chat-selfies.plan.md) — inspector-grade reset/edit. */
  selfieHistory: selfieHistorySchema.optional(),
  /** Runtime drives (character-drives.plan.md) — scenario/state-tools edit surface. */
  drives: chatDrivesSchema.optional(),
  /** Who the player is here + what they're wearing (persona-library.plan.md) — the "Playing as" pick. */
  playerState: chatPlayerStateSchema.optional(),
  /** Recurring named side characters (chat-supporting-cast.plan.md) — the panel's whole-list save. */
  supportingCast: supportingCastSchema.optional(),
  /** Tracked plans & promises (chat-plans-promises.plan.md) — the Plans panel's whole-list save. */
  plans: chatPlansSchema.optional(),
  /** The story-calendar anchor (chat-clock-calendar.plan.md) — the clock card's editor. */
  calendarStart: calendarStartSchema.optional(),
  /** Where an away member is (chat-offscreen-life) — author-correctable phrase. */
  whereabouts: z.string().trim().max(120).optional(),
});

/**
 * Mood-chip inputs for the snapshot (mood.spec §4): the character's `social.dominance`
 * tilts a low-valence read angry vs sad, and chat — a private intimate-capable 1-on-1 —
 * permits the `aroused` label (then gated purely on the arousal meter).
 */
const snapshotOpts = (profile: CharacterProfile) => ({
  dominance: effectiveTraitValue(profile.traits, "social.dominance"),
  intimateContext: true,
});

/**
 * Resolve the TARGET participant (followups ruling 13 — per-character sheets):
 * `?characterId=` picks any roster member's state; absent ⇒ the primary (the
 * pre-roster shape every 1-on-1 caller keeps using). Null ⇒ not in this roster.
 */
function targetMember(owned: OwnedChat, req: NextRequest): { characterId: string; profile: unknown } | null {
  const characterId = new URL(req.url).searchParams.get("characterId");
  if (!characterId) return { characterId: owned.participant.characterId, profile: owned.character.profile };
  const member = owned.roster.find((m) => m.characterId === characterId);
  return member ? { characterId: member.characterId, profile: member.character.profile } : null;
}

export const GET = withUser<Params>(async (user, req: NextRequest, ctx) => {
  const { chatId } = await ctx.params;
  const owned = await loadOwnedChat(chatId, user.id);
  if (!owned) return jsonError("not_found", "chat not found", 404);
  const target = targetMember(owned, req);
  if (!target) return jsonError("not_found", "that character is not in this conversation", 404);

  const sink = new DiagnosticCollector();
  const profile = parseOr(characterProfileSchema, target.profile ?? {}, emptyCharacterProfile(), sink, "characters.profile");
  const stored = await loadChatState(chatId, target.characterId, sink);
  // resolveSeededOutfit: the seeded outfit is an item-id marker (and pre-fix rows
  // persisted those ids) — the character sheet must show the garment phrase.
  const base = await resolveSeededOutfit(stored ?? seedChatState(profile), user.id, profile, sink);
  const scenario = (await loadChatScenario(chatId, sink)) ?? seedChatScenario(profile);
  const drifted = stored ? driftChatState(base, profile, { advance: false, clockMinutes: scenario.clockMinutes }) : base;
  // R5 slices 4+7: a sim-routed chat's meters come from the ruling-15 body
  // substrate and its regard/familiarity from the §21 relationship ledger —
  // the mood chip, pips, and disposition bands then all DERIVE from world
  // truth, since the snapshot computes from whatever state it is handed.
  const isPrimaryTarget = target.characterId === owned.participant.characterId;
  const [simMeters, simRelationship] = isPrimaryTarget
    ? await Promise.all([readSimChatMeters(chatId), readSimChatRelationship(chatId)])
    : [null, null];
  const state = {
    ...drifted,
    ...(simMeters === null ? {} : { meters: { ...drifted.meters, ...simMeters } }),
    ...(simRelationship === null ? {} : { regard: simRelationship.regard, familiarity: simRelationship.familiarity }),
  };
  // Rendered garment phrase for the read-only strip chip (chat-wardrobe-parity): the structured
  // worn items resolved through the shared seam, else the free-text overlay.
  const wardrobe = await resolveChatWardrobe(
    { ...state, garments: scenario.garments, garmentActorId: garmentActorForCharacter(target.characterId) },
    user.id,
    profile,
    sink,
  );
  // R5 slice 5: a routed chat's outfit chip reads the mirror's WORN items.
  const simOutfit = target.characterId === owned.participant.characterId ? await readSimChatOutfit(chatId) : null;
  return jsonOk({
    ...chatStateSnapshot(state, scenario, { ...snapshotOpts(profile), persisted: stored !== null }),
    outfitLabel: simOutfit ?? wardrobe.garments,
    // The presentation graph for this member's worn garments (slice 3): the
    // controls the sheet offers plus the coverage they currently produce.
    garments: garmentReadoutsFor(
      scenario.garments,
      garmentActorForCharacter(target.characterId),
      scenario.clockMinutes,
    ),
    garmentDiagnostics: [],
    // Sim-routed chats show the WORLD clock, not the legacy scenario clock
    // (R3 slice 4 + R5 calendar, ruling 17) — null for legacy chats.
    simClock: await readSimChatClock(chatId),
  });
});

export const PATCH = withUser<Params>(async (user, req: NextRequest, ctx) => {
  const { chatId } = await ctx.params;
  const owned = await loadOwnedChat(chatId, user.id);
  if (!owned) return jsonError("not_found", "chat not found", 404);
  const target = targetMember(owned, req);
  if (!target) return jsonError("not_found", "that character is not in this conversation", 404);
  const busy = chatBusyResponse(chatId);
  if (busy) return busy;

  const body = await readBody(req, editBodySchema);
  if (!body.ok) return body.response;

  const profile = parseOr(characterProfileSchema, target.profile ?? {}, emptyCharacterProfile(), undefined, "characters.profile");
  // Garment operations degrade rather than fail (docs/resilience.md): a rejected
  // one is a stable-code diagnostic, collected here and handed back so the sheet
  // can say WHY it did not take instead of silently discarding it.
  const editSink = new DiagnosticCollector();
  const { state, scenario } = await editChatState({
    chatId,
    characterId: target.characterId,
    ownerId: user.id,
    profile,
    patch: body.value,
    sink: editSink,
  });
  const wardrobe = await resolveChatWardrobe(
    { ...state, garments: scenario.garments, garmentActorId: garmentActorForCharacter(target.characterId) },
    user.id,
    profile,
  );
  return jsonOk({
    ...chatStateSnapshot(state, scenario, snapshotOpts(profile)),
    outfitLabel: wardrobe.garments,
    garments: garmentReadoutsFor(
      scenario.garments,
      garmentActorForCharacter(target.characterId),
      scenario.clockMinutes,
    ),
    garmentDiagnostics: editSink.items
      .filter((d) => d.code.startsWith("garment_op."))
      .map((d) => ({ code: d.code, message: d.message })),
    simClock: await readSimChatClock(chatId),
  });
});
