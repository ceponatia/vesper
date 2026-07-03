import type { NextRequest } from "next/server";
import { z } from "zod";
import {
  activeConditionSchema,
  attributeValueSchema,
  characterProfileSchema,
  chatActionIdSchema,
  CHAT_MIND_NOTE_MAX_CHARS,
  CHAT_OUTFIT_MAX_CHARS,
  CHAT_PREMISE_MAX_CHARS,
  DiagnosticCollector,
  effectiveTraitValue,
  emptyCharacterProfile,
  socialReactionCardSchema,
  type CharacterProfile,
} from "@/contracts";
import { parseOr } from "@/lib/parse";
import { jsonError, jsonOk, readBody, withUser } from "@/server/api";
import {
  applyChatAction,
  chatStateSnapshot,
  driftChatState,
  editChatState,
  loadChatState,
  persistChatState,
  seedChatState,
} from "@/server/engine";
import { loadOwnedChat, type OwnedChat } from "../../owned";

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
  affinity: z.number().int().min(-100).max(100).optional(),
  mindNote: z.string().trim().max(CHAT_MIND_NOTE_MAX_CHARS).optional(),
  meters: z.record(z.string(), z.number()).optional(),
  conditions: z.array(activeConditionSchema).optional(),
  outfit: z.string().max(CHAT_OUTFIT_MAX_CHARS).optional(),
  outfitExposed: z.boolean().optional(),
  activeSocialCards: z.array(socialReactionCardSchema).optional(),
  // Inspector-grade fields (character-chat-standalone.spec.md §6.1): the dev/state-tools
  // surface can rewrite everything stored — including the D11 gate bypass via `affinity`.
  openLoops: z.array(z.string().trim().max(200)).max(6).optional(),
  memoryQueries: z.array(z.string().trim().max(200)).max(6).optional(),
  surfacedCues: z.record(z.string(), z.string()).optional(),
  attributeOverlays: z.array(attributeValueSchema).optional(),
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

export const GET = withUser<Params>(async (user, _req, ctx) => {
  const { chatId } = await ctx.params;
  const owned = await loadOwnedChat(chatId, user.id);
  if (!owned) return jsonError("not_found", "chat not found", 404);

  const sink = new DiagnosticCollector();
  const profile = parseProfile(owned, sink);
  const stored = await loadChatState(chatId, owned.participant.characterId, sink);
  const state = stored ? driftChatState(stored, new Date(), profile, { advance: false }) : seedChatState(profile);
  return jsonOk(chatStateSnapshot(state, { ...snapshotOpts(profile), persisted: stored !== null }));
});

export const PATCH = withUser<Params>(async (user, req: NextRequest, ctx) => {
  const { chatId } = await ctx.params;
  const owned = await loadOwnedChat(chatId, user.id);
  if (!owned) return jsonError("not_found", "chat not found", 404);

  const body = await readBody(req, editBodySchema);
  if (!body.ok) return body.response;

  const profile = parseProfile(owned);
  const state = await editChatState({
    chatId,
    characterId: owned.participant.characterId,
    profile,
    patch: body.value,
  });
  return jsonOk(chatStateSnapshot(state, snapshotOpts(profile)));
});

export const POST = withUser<Params>(async (user, req: NextRequest, ctx) => {
  const { chatId } = await ctx.params;
  const owned = await loadOwnedChat(chatId, user.id);
  if (!owned) return jsonError("not_found", "chat not found", 404);

  const body = await readBody(req, actionBodySchema);
  if (!body.ok) return body.response;

  const sink = new DiagnosticCollector();
  const profile = parseProfile(owned, sink);
  const stored = await loadChatState(chatId, owned.participant.characterId, sink);
  // Apply the chip to the current (recovered) state, then persist.
  const current = stored ? driftChatState(stored, new Date(), profile, { advance: false }) : seedChatState(profile);
  const next = applyChatAction(current, body.value.action);
  await persistChatState(chatId, owned.participant.characterId, next);
  return jsonOk(chatStateSnapshot(next, snapshotOpts(profile)));
});
