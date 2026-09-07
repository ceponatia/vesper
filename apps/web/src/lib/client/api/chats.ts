import { z } from "zod";

import { newId } from "@/lib/ids";

import {
  milestoneSchema,
  type ChatSkipAmount,
  socialReactionCardSchema,
  type SocialReactionCard,
} from "@/contracts";

/**
 * Client data layer (docs/streaming-api.md, docs/ui/conventions.md): typed
 * fetch helpers over the route-handler API. Every response crosses a trust boundary, so it
 * is parsed with forgiving schemas — unknown fields are stripped, bad fields
 * fall back, bad list elements are dropped. Errors use the
 * `{ error: { code, message } }` envelope.
 *
 * This module is client-safe: it imports only pure contracts and `zod`.
 */
import {
  apiDelete,
  apiGet,
  apiPatch,
  apiPost,
  apiPut,
  withQuery,
} from "./http";

import { imageRecordSchema } from "./images";
import { arrayOf, createdRefSchema, idSchema, listOf, textOr } from "./shared";
import {
  chatRelationshipSchema,
  chatRelationshipsSchema,
  chatStateSnapshotSchema,
  chatSummarySchema,
  chatTranscriptSchema,
  chatWorldSchema,
  simDoActivityResultSchema,
  simGiveItemResultSchema,
  simMoveTogetherResultSchema,
  simTravelResultSchema,
} from "./chat-schemas";

export const chatsApi = {
  /** Active conversations, newest first; scoped to one character and/or the archived shelf. */
  list: (opts: { characterId?: string; archived?: boolean } = {}) =>
    apiGet(
      listOf(chatSummarySchema, "chats"),
      withQuery("/api/chats", {
        characterId: opts.characterId,
        archived: opts.archived ? "1" : undefined,
      }),
    ),
  /** Rename, archive, or restore a conversation — or stamp the "has something to say"
   * seen-cursor (`seen: true` on open). */
  update: (
    chatId: string,
    patch: { title?: string; archived?: boolean; seen?: boolean },
  ) => apiPatch(z.unknown(), `/api/chats/${chatId}`, patch),
  /**
   * Create a conversation — D7 memory choice: `"shared"` continues the history, `"fresh"`
   * is a clean island. `characterIds` order matters: the first is the primary participant;
   * every pick joins as a full roster member.
   */
  create: (body: {
    characterIds: string[];
    title?: string;
    memory: "shared" | "fresh";
    presetId?: string;
  }) => apiPost(createdRefSchema, "/api/chats", body),
  /**
   * The full conversation envelope: the newest transcript page (oldest first) +
   * chat header + character card. `before` keysets older pages ("Load earlier").
   */
  transcript: (chatId: string, opts: { before?: string } = {}) =>
    apiGet(
      chatTranscriptSchema,
      withQuery(`/api/chats/${chatId}`, { before: opts.before }),
    ),
  /**
   * Hard-delete the conversation: transcript, summary, light state, and RAG
   * memory all go with it; scene images survive in the Gallery.
   */
  remove: (chatId: string) => apiDelete(`/api/chats/${chatId}`),
  // --- Light chat state, keyed per participant ---
  // `characterId` targets any roster member's state (the per-character sheet);
  // absent ⇒ the primary.
  state: (chatId: string, characterId?: string) =>
    apiGet(
      chatStateSnapshotSchema,
      `/api/chats/${chatId}/state${characterId ? `?characterId=${characterId}` : ""}`,
    ),
  /** Edit chat state fields from the character sheet / scenario modal; returns the refreshed snapshot. */
  editState: (chatId: string, patch: ChatStateEdit, characterId?: string) =>
    apiPatch(
      chatStateSnapshotSchema,
      `/api/chats/${chatId}/state${characterId ? `?characterId=${characterId}` : ""}`,
      patch,
    ),
  /**
   * Upload ONE player photo for this conversation: a data-URL in, the
   * `chat_upload` asset id back — sent with the next message as
   * `attachmentIds`. Input-only content: Gallery-hidden, deleted with its message.
   */
  uploadAttachment: (chatId: string, image: string) =>
    apiPost(z.object({ id: z.string() }), `/api/chats/${chatId}/attachments`, {
      image,
    }),
  /** Overwrite one chat message's text in place (recovery lever for a poisoned transcript). */
  editMessage: (chatId: string, messageId: string, content: string) =>
    apiPatch(z.unknown(), `/api/chats/${chatId}/messages/${messageId}`, {
      content,
    }),
  /** Delete a single chat message (snip a refusal out of the context window). */
  deleteMessage: (chatId: string, messageId: string) =>
    apiDelete(`/api/chats/${chatId}/messages/${messageId}`),
  /**
   * Rendered scenes for the conversation's character (kind="scene"), newest first, plus
   * whether a render job is live server-side (`rendering` — true through the composer
   * step BEFORE the pending image row exists, so pollers don't go blind there).
   */
  scenes: (chatId: string) =>
    apiGet(
      z
        .object({
          scenes: arrayOf(imageRecordSchema),
          rendering: z.boolean().catch(false),
        })
        .catch({ scenes: [], rendering: false }),
      `/api/chats/${chatId}/scene`,
    ),
  /** Queue a scene render from the recent chat (single-reference); poll `scenes` for the result. */
  generateScene: (chatId: string) =>
    apiPost(z.unknown(), `/api/chats/${chatId}/scene`, {}),
  /** Cut the in-flight reply short; what already streamed persists with `meta.stopped`. */
  stop: (chatId: string) => apiPost(z.unknown(), `/api/chats/${chatId}/stop`),
  /**
   * "Remember this" (D15): pin a player note into the chat's long-term memory —
   * always retrieved, floor-exempt, and never overridden by the background memory-writer.
   */
  remember: (chatId: string, content: string) =>
    apiPost(
      z.object({ id: z.string().nullable().catch(null) }),
      `/api/chats/${chatId}/remember`,
      { content },
    ),
  /**
   * Player time skip (D14 — flavor-only v1): advances the in-game clock,
   * expires running timed conditions, stamps the one-shot skip note. Meters untouched.
   */
  timeSkip: (chatId: string, amount: ChatSkipAmount) =>
    apiPost(chatStateSnapshotSchema, `/api/chats/${chatId}/time-skip`, {
      amount,
    }),
  /**
   * Sim-routed time skip (R3 slice 4, ruling 17): ends the standing scene (the
   * "Later →" wrap) and drains the world's bounded story-time advance. The chat
   * skip affordances call THIS for sim-routed chats, never the legacy timeSkip.
   * `requestId` is minted per call (command-integrity A1): a resend of the exact
   * body replays the recorded response instead of advancing time twice.
   */
  simAdvanceTime: (chatId: string, minutes: number) =>
    apiPost(
      z.object({
        status: z.string().catch(""),
        toStorySecond: z.number().nullable().catch(null),
      }),
      `/api/chats/${chatId}/sim-command`,
      { kind: "advance_time", minutes, requestId: newId() },
    ),
  /**
   * The player-facing world read. Degraded / legacy /
   * shadow ⇒ `!ok`, and the `ChatWorldCard` simply doesn't render (ruling-18-style
   * affordance hiding).
   */
  world: (chatId: string) =>
    apiGet(chatWorldSchema, `/api/chats/${chatId}/world`),
  /**
   * Skip-style travel (ruling 20): server-composed `move` + a bounded advance to
   * the journey's earliest arrival. Returns a landing or the public refusal face
   * (both `ok`); the card refreshes world + chat state on a landing.
   */
  simTravel: (chatId: string, toZoneId: string) =>
    apiPost(simTravelResultSchema, `/api/chats/${chatId}/sim-command`, {
      kind: "travel",
      toZoneId,
      requestId: newId(),
    }),
  /**
   * Walk-with-me (command-integrity A4): invite the co-present primary to travel
   * together via the ONE atomic `move_together` command (decide + scene-end + one
   * shared journey + one arrival — the pair can no longer be stranded mid-move).
   * The primary's acceptance is NPC agency (a deterministic policy, re-run inside
   * the locked view); returns a co-travel landing or the public refusal face (both
   * `ok`). `requestId` is minted per tap (A1): a resend replays the recorded
   * response instead of moving twice. The card refreshes world + transcript on a landing.
   */
  simMoveTogether: (chatId: string, toZoneId: string) =>
    apiPost(simMoveTogetherResultSchema, `/api/chats/${chatId}/sim-command`, {
      kind: "move_together",
      toZoneId,
      requestId: newId(),
    }),
  /**
   * Hand the player's held item to the primary (slice 3): a success or the
   * public refusal face, both at 200. On success the server writes a `gave_item`
   * world beat; the card refreshes the transcript + world.
   */
  simGiveItem: (chatId: string, itemId: string) =>
    apiPost(simGiveItemResultSchema, `/api/chats/${chatId}/sim-command`, {
      kind: "give_item",
      itemId,
      requestId: newId(),
    }),
  /**
   * Perform a skip-style action (slice 3): server-composed `start_activity` + a
   * bounded drain through the activity's duration (the completion trigger fires
   * inside the drain). Returns a landing or the public refusal face (both `ok`);
   * on success the server writes a `rested` world beat.
   */
  simDoActivity: (chatId: string, actionDefinitionId: string) =>
    apiPost(simDoActivityResultSchema, `/api/chats/${chatId}/sim-command`, {
      kind: "do_activity",
      actionDefinitionId,
      requestId: newId(),
    }),
  /** End the pair's standing scene (wiring lands now; its card UI is slice 4). */
  simEndScene: (chatId: string) =>
    apiPost(
      z.object({ status: z.string().catch("") }),
      `/api/chats/${chatId}/sim-command`,
      {
        kind: "end_scene",
        requestId: newId(),
      },
    ),
  /** The Relationship panel payload: stage, sparkline, milestones, story so far. */
  relationship: (chatId: string) =>
    apiGet(chatRelationshipSchema, `/api/chats/${chatId}/relationship`),
  // --- Relationship matrix ---
  /** The conversation's directed NPC↔NPC edges + roster (the matrix editor's data). */
  relationships: (chatId: string) =>
    apiGet(chatRelationshipsSchema, `/api/chats/${chatId}/relationships`),
  /** Upsert authored NPC↔NPC edges and/or player edges (band picks + texture → live scalars server-side). */
  saveRelationships: (
    chatId: string,
    body: {
      edges?: {
        fromCharacterId: string;
        toCharacterId: string;
        record: AuthoredEdgeRecord;
      }[];
      playerEdges?: { characterId: string; record: AuthoredEdgeRecord }[];
    },
  ) =>
    apiPut(
      chatRelationshipsSchema.omit({ roster: true }),
      `/api/chats/${chatId}/relationships`,
      body,
    ),
  // --- Roster ---
  /** Add a character to the roster (cap 4); D7 memory choice defaults to shared. */
  addParticipant: (
    chatId: string,
    characterId: string,
    memory: "shared" | "fresh" = "shared",
  ) =>
    apiPost(z.unknown(), `/api/chats/${chatId}/participants`, {
      characterId,
      memory,
    }),
  /** Remove a roster member (never the last; removing the primary promotes the next). */
  removeParticipant: (chatId: string, characterId: string) =>
    apiDelete(`/api/chats/${chatId}/participants/${characterId}`),
  /** Flip a member's narrative presence — the roster panel's manual override. */
  setPresence: (
    chatId: string,
    characterId: string,
    presence: "present" | "away",
  ) =>
    apiPatch(z.unknown(), `/api/chats/${chatId}/participants/${characterId}`, {
      presence,
    }),
  /** "Mark this moment": pin a milestone on any message. */
  markMoment: (chatId: string, messageId: string, label?: string) =>
    apiPost(
      z.object({ milestones: z.array(milestoneSchema).catch([]) }),
      `/api/chats/${chatId}/milestones`,
      {
        messageId,
        label,
      },
    ),
  /** Re-fold the rolling summary from the full transcript — the recovery lever. */
  rebuildSummary: (chatId: string) =>
    apiPost(
      z.object({ summary: z.string().catch("") }),
      `/api/chats/${chatId}/summary/rebuild`,
      {},
    ),
  /** Transcript export — a plain download URL for an anchor/window.open. */
  exportUrl: (chatId: string, format: "md" | "json", memory: boolean) =>
    `/api/chats/${chatId}/export?format=${format}${memory ? "&memory=1" : ""}`,
  /** Make one recorded take the displayed reply (display-only); returns its content. */
  switchTake: (chatId: string, messageId: string, takeId: string) =>
    apiPatch(
      z.object({ content: z.string().catch("") }),
      `/api/chats/${chatId}/messages/${messageId}/take`,
      { takeId },
    ),
};

/** The authored starting-relationship a preset stores. */
export const presetRelationshipSchema = z
  .object({
    familiarity: z.string().catch("strangers"),
    regard: z.string().catch("neutral"),
    kind: textOr(""),
    history: textOr(""),
    presented: z
      .object({
        lean: z.enum(["masks_warmth", "masks_dislike"]),
        note: textOr(""),
      })
      .optional()
      .catch(undefined),
    looming: z.boolean().catch(false),
  })
  .catch({
    familiarity: "strangers",
    regard: "neutral",
    kind: "",
    history: "",
    looming: false,
  });
export type PresetRelationship = z.infer<typeof presetRelationshipSchema>;

/** A saved scenario preset. */
export const chatPresetSchema = z.object({
  id: idSchema,
  name: textOr(""),
  premise: textOr(""),
  outfit: textOr(""),
  outfitExposed: z.boolean().catch(false),
  socialCards: arrayOf(socialReactionCardSchema),
  /** Seeds the primary's player edge at creation only — never a running chat. */
  startingRelationship: presetRelationshipSchema,
});
export type ChatPreset = z.infer<typeof chatPresetSchema>;

export const chatPresetsApi = {
  list: () => apiGet(listOf(chatPresetSchema, "presets"), "/api/chat-presets"),
  create: (body: {
    name: string;
    premise?: string;
    outfit?: string;
    outfitExposed?: boolean;
    socialCards?: SocialReactionCard[];
    startingRelationship?: PresetRelationship;
  }) => apiPost(createdRefSchema, "/api/chat-presets", body),
  remove: (presetId: string) => apiDelete(`/api/chat-presets/${presetId}`),
};

export const successorChatSummarySchema = z.object({
  id: z.string().min(1),
  title: textOr(""),
  characterName: textOr(""),
  authority: z.string().catch("successor_narrative_view"),
  /** The linked world's clock (storySecond); null when the branch was torn down. */
  storySecond: z.number().nullable().catch(null),
  lastMessageAt: z.string().catch(""),
});
export type SuccessorChatSummary = z.infer<typeof successorChatSummarySchema>;

/**
 * The successor front door (the Worlds page): create a complete successor chat
 * — fresh isolated world, actors mapped, authority flipped — in one call, and
 * list the caller's existing ones.
 *
 * `requestId` is REQUIRED: it is the
 * caller's idempotency key for one create INTENT. Resend the same id to retry a
 * failed create — the server resumes that world instead of minting a second —
 * and mint a fresh one for a genuinely new world.
 */
export const successorChatsApi = {
  list: () =>
    apiGet(
      z.object({ chats: z.array(successorChatSummarySchema).catch([]) }),
      "/api/successor-chats",
    ),
  create: (body: { characterId: string; title?: string; requestId: string }) =>
    apiPost(z.object({ id: z.string().min(1) }), "/api/successor-chats", body),
  /** R5 calendar (ruling 17): set (or clear) the linked world's calendar anchor. */
  setCalendar: (
    chatId: string,
    calendarStart: { year: number; month: number; day: number } | null,
  ) =>
    apiPatch(z.unknown(), `/api/successor-chats/${chatId}`, { calendarStart }),
};
