import type { NextRequest } from "next/server";
import { z } from "zod";
import {
  activeConditionSchema,
  attributeValueSchema,
  characterProfileSchema,
  chatActionIdSchema,
  CHAT_MIND_NOTE_MAX_CHARS,
  CHAT_PREMISE_MAX_CHARS,
  chatDrivesSchema,
  chatSceneModels,
  DiagnosticCollector,
  effectiveTraitValue,
  emptyCharacterProfile,
  relationshipTextureSchema,
  socialReactionCardSchema,
  type CharacterProfile,
} from "@/contracts";
import { parseOr } from "@/lib/parse";
import { jsonError, jsonOk, readBody, withUser } from "@/server/api";
import {
  applyChatAction,
  chatFeelingStateSchema,
  chatStateSnapshot,
  selfieHistorySchema,
  driftChatState,
  editChatState,
  loadChatScenario,
  loadChatState,
  persistChatState,
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
 * - **POST `{ action }`** → a one-click test-bed action chip (offer a drink →
 *   intoxication↑, etc.), applied deterministically server-side.
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
  outfit: z.string().optional(),
  outfitExposed: z.boolean().optional(),
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
});

const actionBodySchema = z.object({ action: chatActionIdSchema });

/**
 * Mood-chip inputs for the snapshot (mood.spec §4): the character's `social.dominance`
 * tilts a low-valence read angry vs sad, and chat — a private intimate-capable 1-on-1 —
 * permits the `aroused` label (then gated purely on the arousal meter).
 */
const snapshotOpts = (profile: CharacterProfile) => ({
  dominance: effectiveTraitValue(profile.traits, "social.dominance"),
  intimateContext: true,
});

const parseProfile = (owned: OwnedChat, sink?: DiagnosticCollector) =>
  parseOr(characterProfileSchema, owned.character.profile ?? {}, emptyCharacterProfile(), sink, "characters.profile");

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
  const state = stored ? driftChatState(base, profile, { advance: false, clockMinutes: scenario.clockMinutes }) : base;
  return jsonOk(chatStateSnapshot(state, scenario, { ...snapshotOpts(profile), persisted: stored !== null }));
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
  const { state, scenario } = await editChatState({
    chatId,
    characterId: target.characterId,
    ownerId: user.id,
    profile,
    patch: body.value,
  });
  return jsonOk(chatStateSnapshot(state, scenario, snapshotOpts(profile)));
});

export const POST = withUser<Params>(async (user, req: NextRequest, ctx) => {
  const { chatId } = await ctx.params;
  const owned = await loadOwnedChat(chatId, user.id);
  if (!owned) return jsonError("not_found", "chat not found", 404);
  const busy = chatBusyResponse(chatId);
  if (busy) return busy;

  const body = await readBody(req, actionBodySchema);
  if (!body.ok) return body.response;

  const sink = new DiagnosticCollector();
  const profile = parseProfile(owned, sink);
  const stored = await loadChatState(chatId, owned.participant.characterId, sink);
  // Apply the chip to the current state (seeded outfit marker resolved first —
  // this path persists), then persist.
  const base = await resolveSeededOutfit(stored ?? seedChatState(profile), user.id, profile, sink);
  const scenario = (await loadChatScenario(chatId, sink)) ?? seedChatScenario(profile);
  const current = stored ? driftChatState(base, profile, { advance: false, clockMinutes: scenario.clockMinutes }) : base;
  const next = applyChatAction(current, body.value.action, scenario.clockMinutes);
  await persistChatState(chatId, owned.participant.characterId, next);
  return jsonOk(chatStateSnapshot(next, scenario, snapshotOpts(profile)));
});
