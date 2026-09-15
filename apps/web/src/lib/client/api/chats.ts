import { z } from "zod";

import { newId } from "@/lib/ids";

import {
  milestoneSchema,
  type ChatSkipAmount,
  socialReactionCardSchema,
  type SocialReactionCard,
} from "@/contracts";

import {
  apiDelete,
  apiGet,
  apiPatch,
  apiPost,
  apiPut,
  type ApiResult,
  withQuery,
} from "./http";

import { imageRecordSchema } from "./images";
import { arrayOf, createdRefSchema, idSchema, listOf, textOr } from "./shared";
import {
  type AuthoredEdgeRecord,
  type ChatStateEdit,
  type ChatStateSnapshot,
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

const hasFields = (value: Record<string, unknown>): boolean => Object.keys(value).length > 0;
const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
const focusedWardrobeResultSchema = z.object({
  garmentDiagnostics: z
    .array(z.object({ code: z.string(), message: z.string().catch("") }))
    .catch([]),
});

/**
 * Transitional client adapter for the old UI edit shape. It no longer sends the
 * mixed PATCH /state request: fields are partitioned by their focused authority,
 * written to those resources, then the aggregate GET projection is refreshed.
 * The legacy HTTP PATCH remains server-side only for external compatibility while
 * the remaining call sites are renamed around the focused types.
 */
async function editStateThroughFocusedResources(
  chatId: string,
  patch: ChatStateEdit,
  characterId?: string,
): Promise<ApiResult<ChatStateSnapshot>> {
  const needsCharacter =
    patch.regard !== undefined ||
    patch.familiarity !== undefined ||
    patch.relationship !== undefined ||
    patch.mindNote !== undefined ||
    patch.meters !== undefined ||
    patch.conditions !== undefined ||
    patch.whereabouts !== undefined ||
    patch.wornItemIds !== undefined ||
    patch.outfitPresetId !== undefined ||
    patch.outfit !== undefined ||
    patch.outfitExposed !== undefined ||
    patch.garmentOperations !== undefined ||
    patch.openLoops !== undefined ||
    patch.memoryQueries !== undefined ||
    patch.surfacedCues !== undefined ||
    patch.attributeOverlays !== undefined;

  // Non-first-party compatibility only. Every current sheet supplies the roster
  // character id, but retaining this fallback avoids silently changing the public
  // helper's historic primary-target behavior for callers outside the migrated UI.
  if (needsCharacter && !characterId) {
    return apiPatch(chatStateSnapshotSchema, `/api/chats/${chatId}/state`, patch);
  }

  // The state-tools form is intentionally convenient and keeps local copies of the
  // whole sheet, but the focused resources express write INTENT. Diff against the
  // current aggregate read model before partitioning so a save of mindNote does not
  // also manufacture writes for unchanged successor-owned meters/relationship or
  // wardrobe fields. This is also useful for legacy chats: focused endpoints only
  // receive fields the caller actually changed.
  let current: ChatStateSnapshot | undefined;
  if (needsCharacter && characterId) {
    const result = await apiGet(chatStateSnapshotSchema, `/api/chats/${chatId}/state?characterId=${characterId}`);
    if (!result.ok) return result;
    current = result.data;
  }

  const scenario: Record<string, unknown> = {};
  if (patch.premise !== undefined) scenario.premise = patch.premise;
  if (patch.activeSocialCards !== undefined) scenario.activeSocialCards = patch.activeSocialCards;
  if (patch.sceneAuto !== undefined) scenario.sceneAuto = patch.sceneAuto;
  if (patch.sceneModel !== undefined) scenario.sceneModel = patch.sceneModel;
  if (patch.supportingCast !== undefined) scenario.supportingCast = patch.supportingCast;
  if (patch.plans !== undefined) scenario.plans = patch.plans;
  if (patch.calendarStart !== undefined) scenario.calendarStart = patch.calendarStart;
  if (hasFields(scenario)) {
    const result = await apiPatch(z.unknown(), `/api/chats/${chatId}/scenario`, scenario);
    if (!result.ok) return { ok: false, error: result.error };
  }

  if (patch.playerState !== undefined) {
    const result = await apiPatch(z.unknown(), `/api/chats/${chatId}/player-state`, {
      personaId: patch.playerState.personaId,
    });
    if (!result.ok) return { ok: false, error: result.error };
  }

  let garmentDiagnostics: ChatStateSnapshot["garmentDiagnostics"] = [];
  if (characterId) {
    const participant: Record<string, unknown> = {};
    if (patch.regard !== undefined && patch.regard !== current?.regard) participant.regard = patch.regard;
    if (patch.familiarity !== undefined && patch.familiarity !== current?.familiarity) {
      participant.familiarity = patch.familiarity;
    }
    if (patch.relationship !== undefined && !sameJson(patch.relationship, current?.relationship)) {
      participant.relationship = patch.relationship;
    }
    if (patch.mindNote !== undefined && patch.mindNote !== current?.mindNote) participant.mindNote = patch.mindNote;
    if (patch.meters !== undefined && !sameJson(patch.meters, current?.meters)) participant.meters = patch.meters;
    if (patch.conditions !== undefined && !sameJson(patch.conditions, current?.conditions)) {
      participant.conditions = patch.conditions;
    }
    // `whereabouts` is intentionally absent from the aggregate compatibility snapshot,
    // so an explicit caller value remains an explicit focused write.
    if (patch.whereabouts !== undefined) participant.whereabouts = patch.whereabouts;
    if (hasFields(participant)) {
      const result = await apiPatch(
        z.unknown(),
        `/api/chats/${chatId}/participants/${characterId}/state`,
        participant,
      );
      if (!result.ok) return { ok: false, error: result.error };
    }

    const wardrobe: Record<string, unknown> = {};
    if (patch.wornItemIds !== undefined && !sameJson(patch.wornItemIds, current?.wornItemIds)) {
      wardrobe.wornItemIds = patch.wornItemIds;
    }
    if (patch.outfitPresetId !== undefined && patch.outfitPresetId !== current?.outfitPresetId) {
      wardrobe.outfitPresetId = patch.outfitPresetId;
    }
    if (patch.outfit !== undefined && patch.outfit !== current?.outfit) wardrobe.outfit = patch.outfit;
    if (patch.outfitExposed !== undefined && patch.outfitExposed !== current?.outfitExposed) {
      wardrobe.outfitExposed = patch.outfitExposed;
    }
    if ((patch.garmentOperations?.length ?? 0) > 0) wardrobe.garmentOperations = patch.garmentOperations;
    if (hasFields(wardrobe)) {
      const result = await apiPatch(
        focusedWardrobeResultSchema,
        `/api/chats/${chatId}/participants/${characterId}/wardrobe`,
        wardrobe,
      );
      if (!result.ok) return { ok: false, error: result.error };
      // Rejected garment operations are successful writes with diagnostics. The
      // aggregate GET is deliberately stateless and returns [], so retain the
      // focused response and merge it back after the refresh below.
      garmentDiagnostics = result.data.garmentDiagnostics;
    }

    const inspector: Record<string, unknown> = {};
    if (patch.openLoops !== undefined && !sameJson(patch.openLoops, current?.openLoops)) {
      inspector.openLoops = patch.openLoops;
    }
    if (patch.memoryQueries !== undefined && !sameJson(patch.memoryQueries, current?.memoryQueries)) {
      inspector.memoryQueries = patch.memoryQueries;
    }
    if (patch.surfacedCues !== undefined && !sameJson(patch.surfacedCues, current?.surfacedCues)) {
      inspector.surfacedCues = patch.surfacedCues;
    }
    if (patch.attributeOverlays !== undefined && !sameJson(patch.attributeOverlays, current?.attributeOverlays)) {
      inspector.attributeOverlays = patch.attributeOverlays;
    }
    if (hasFields(inspector)) {
      const result = await apiPatch(
        z.unknown(),
        `/api/admin/self/chat-inspector/${chatId}/participants/${characterId}/state`,
        inspector,
      );
      // The sheet keeps these controls hidden for non-admins. A role-hidden edit
      // therefore degrades to "no inspector edit" rather than breaking the normal
      // gameplay save; real inspector failures still surface for admins.
      if (!result.ok && result.error.status !== 403 && result.error.status !== 404) {
        return { ok: false, error: result.error };
      }
    }
  }

  const refreshed = await apiGet(
    chatStateSnapshotSchema,
    `/api/chats/${chatId}/state${characterId ? `?characterId=${characterId}` : ""}`,
  );
  if (!refreshed.ok) return refreshed;
  return {
    ok: true,
    data: { ...refreshed.data, garmentDiagnostics },
  };
}

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
  // The aggregate read model stays during the migration so the conversation can
  // refresh one projection after focused writes without multiplying GET requests.
  state: (chatId: string, characterId?: string) =>
    apiGet(
      chatStateSnapshotSchema,
      `/api/chats/${chatId}/state${characterId ? `?characterId=${characterId}` : ""}`,
    ),
  /** @deprecated UI compatibility shape; writes are dispatched to focused resources. */
  editState: editStateThroughFocusedResources,
  /** Upload ONE player photo for this conversation. */
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
  /** Rendered scenes for the conversation, newest first. */
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
  generateScene: (chatId: string) =>
    apiPost(z.unknown(), `/api/chats/${chatId}/scene`, {}),
  stop: (chatId: string) => apiPost(z.unknown(), `/api/chats/${chatId}/stop`),
  remember: (chatId: string, content: string) =>
    apiPost(
      z.object({ id: z.string().nullable().catch(null) }),
      `/api/chats/${chatId}/remember`,
      { content },
    ),
  timeSkip: (chatId: string, amount: ChatSkipAmount) =>
    apiPost(chatStateSnapshotSchema, `/api/chats/${chatId}/time-skip`, {
      amount,
    }),
  simAdvanceTime: (chatId: string, minutes: number) =>
    apiPost(
      z.object({
        status: z.string().catch(""),
        toStorySecond: z.number().nullable().catch(null),
      }),
      `/api/chats/${chatId}/sim-command`,
      { kind: "advance_time", minutes, requestId: newId() },
    ),
  world: (chatId: string) =>
    apiGet(chatWorldSchema, `/api/chats/${chatId}/world`),
  simTravel: (chatId: string, toZoneId: string) =>
    apiPost(simTravelResultSchema, `/api/chats/${chatId}/sim-command`, {
      kind: "travel",
      toZoneId,
      requestId: newId(),
    }),
  simMoveTogether: (chatId: string, toZoneId: string) =>
    apiPost(simMoveTogetherResultSchema, `/api/chats/${chatId}/sim-command`, {
      kind: "move_together",
      toZoneId,
      requestId: newId(),
    }),
  simGiveItem: (chatId: string, itemId: string) =>
    apiPost(simGiveItemResultSchema, `/api/chats/${chatId}/sim-command`, {
      kind: "give_item",
      itemId,
      requestId: newId(),
    }),
  simDoActivity: (chatId: string, actionDefinitionId: string) =>
    apiPost(simDoActivityResultSchema, `/api/chats/${chatId}/sim-command`, {
      kind: "do_activity",
      actionDefinitionId,
      requestId: newId(),
    }),
  simEndScene: (chatId: string) =>
    apiPost(
      z.object({ status: z.string().catch("") }),
      `/api/chats/${chatId}/sim-command`,
      {
        kind: "end_scene",
        requestId: newId(),
      },
    ),
  relationship: (chatId: string) =>
    apiGet(chatRelationshipSchema, `/api/chats/${chatId}/relationship`),
  relationships: (chatId: string) =>
    apiGet(chatRelationshipsSchema, `/api/chats/${chatId}/relationships`),
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
  addParticipant: (
    chatId: string,
    characterId: string,
    memory: "shared" | "fresh" = "shared",
  ) =>
    apiPost(z.unknown(), `/api/chats/${chatId}/participants`, {
      characterId,
      memory,
    }),
  removeParticipant: (chatId: string, characterId: string) =>
    apiDelete(`/api/chats/${chatId}/participants/${characterId}`),
  setPresence: (
    chatId: string,
    characterId: string,
    presence: "present" | "away",
  ) =>
    apiPatch(z.unknown(), `/api/chats/${chatId}/participants/${characterId}`, {
      presence,
    }),
  markMoment: (chatId: string, messageId: string, label?: string) =>
    apiPost(
      z.object({ milestones: z.array(milestoneSchema).catch([]) }),
      `/api/chats/${chatId}/milestones`,
      {
        messageId,
        label,
      },
    ),
  rebuildSummary: (chatId: string) =>
    apiPost(
      z.object({ summary: z.string().catch("") }),
      `/api/chats/${chatId}/summary/rebuild`,
      {},
    ),
  exportUrl: (chatId: string, format: "md" | "json", memory: boolean) =>
    `/api/chats/${chatId}/export?format=${format}${memory ? "&memory=1" : ""}`,
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

export const successorChatsApi = {
  list: () =>
    apiGet(
      z.object({ chats: z.array(successorChatSummarySchema).catch([]) }),
      "/api/successor-chats",
    ),
  create: (body: { characterId: string; title?: string; requestId: string }) =>
    apiPost(z.object({ id: z.string().min(1) }), "/api/successor-chats", body),
  setCalendar: (
    chatId: string,
    calendarStart: { year: number; month: number; day: number } | null,
  ) =>
    apiPatch(z.unknown(), `/api/successor-chats/${chatId}`, { calendarStart }),
};
