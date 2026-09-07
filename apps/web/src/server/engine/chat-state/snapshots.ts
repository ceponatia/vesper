import type { ChatScenario, ChatState } from "./types";
import { type DbWriter, db, characterChatMessages, characterChats, characterChatState } from "../../db";
import { sql, eq, and } from "drizzle-orm";
import { parseOrNull } from "@/lib/parse";
import {
  chatScenarioSchema,
  sceneOrEmpty,
  metersSchema,
  conditionsSchema,
  wornItemIdsSchema,
  surfacedCuesSchema,
  memoryQueriesSchema,
  attributeOverlaysSchema,
  traitOverlaysSchema,
  relationshipHistorySchema,
  milestonesSchema,
} from "./store";
import { z } from "zod";
import {
  relationshipTextureSchema,
  emptyRelationshipTexture,
  chatPulseTraceSchema,
  chatMemoryTraceSchema,
  chatDrivesSchema,
  bodySurfaceStateSchema,
  emptyBodySurfaceState,
  clampRegard,
} from "@/contracts";
import { voiceExemplarsSchema } from "../chat-voice";
import { callbackHistorySchema } from "../chat-callback";
import { chatFeelingStateSchema, emptyChatFeelingState } from "../chat-feeling";
import { selfieHistorySchema } from "../chat-selfie";

/**
 * Persist the scenario rollback anchor ("another take"'s other half). `null` ⇒ `{}`.
 *
 * The WHOLE scenario object is serialized in one blob, which is why a new
 * scenario field inherits the anchor with no new snapshot machinery — `scene`
 * (and the contact projection housed in it) rides here for free, exactly as
 * `garments` and `environment` do.
 *
 * `writer` defaults to the root client; pass a transaction handle to fold the
 * anchor into a caller's atomic settlement (`persistSurfaceTransferSettlement`).
 */
export async function savePreExchangeScenario(
  chatId: string,
  scenario: ChatScenario | null,
  guardMessageId?: string,
  writer: DbWriter = db(),
): Promise<void> {
  const guard = guardMessageId
    ? sql`exists (select 1 from ${characterChatMessages} where id = ${guardMessageId})`
    : sql`true`;
  await writer.execute(
    sql`update ${characterChats} set pre_exchange_scenario = ${JSON.stringify(scenario ?? {})}::jsonb where id = ${chatId} and ${guard}`,
  );
}

/**
 * Roll the scenario back to the pre-exchange anchor for "another take"
 * (regenerate / an applicable rerun) — PURE. The discarded take's clock tick,
 * skip-note clear and scene merge all undo, but the supporting cast NEVER
 * rolls back: it is accrete-only and author-curated between takes (owner
 * report: a member added after the discarded reply vanished when that reply
 * was redone), so the live list always wins. Cast entries only ever leave via
 * the panel's Remove or the SUPPORTING_CAST_MAX oldest-out eviction. Plans, by
 * contrast, DO roll back (they ride `...anchor` — ruling B): a regenerated reply
 * that struck a plan must not double-mint it, and plans are fiction state, not
 * author curation.
 *
 * `environment`, `affordanceCues` and `scene` ride `...anchor` too, and that is
 * the whole capture mechanism for the affordance read: the read is a pure
 * function of committed state plus its cue memory, so restoring them here is
 * what makes a retake reproduce the
 * identical read rather than resolving against later weather or a pose from a
 * beat that no longer exists. `scene` carries the active-contact projection, so
 * the discarded take's touches un-happen with it — the ledger half of that
 * rollback is `deleteChatContactEventsForGuard` (chat-contact-events.ts), which
 * the pipeline runs before the new take re-commits.
 */
export function rollbackScenario(anchor: ChatScenario, live: ChatScenario | null): ChatScenario {
  return { ...anchor, supportingCast: live?.supportingCast ?? anchor.supportingCast };
}

/** Load the scenario rollback anchor; `{}` (the sentinel) or a bad parse ⇒ null (keep live). */
export async function loadPreExchangeScenario(chatId: string): Promise<ChatScenario | null> {
  const [row] = await db()
    .select({ preExchangeScenario: characterChats.preExchangeScenario })
    .from(characterChats)
    .where(eq(characterChats.id, chatId))
    .limit(1);
  if (!row || isEmptyJsonObject(row.preExchangeScenario)) return null;
  const parsed = parseOrNull(chatScenarioSchema, row.preExchangeScenario);
  if (!parsed) return null;
  // The scene rides the anchor as raw bytes (see the schema slot); this is where
  // they meet their own parser. An anchor written before the field existed has no
  // `scene` key at all, which `sceneOrEmpty` reads as the empty scene — nobody
  // placed, which is the restoration that can never be wrong in a harmful
  // direction. No sink: a legacy anchor is not a corruption to report.
  return { ...parsed, scene: sceneOrEmpty(parsed.scene) };
}

/**
 * The persisted-snapshot shape. New fields are `.catch/.default`ed so snapshots
 * written before the field existed keep parsing — a broken parse here would
 * silently kill every existing "another take" rollback anchor.
 */
const storedChatStateSchema = z.object({
  meters: metersSchema,
  regard: z.number(),
  familiarity: z.number().catch(0).default(0),
  familiaritySceneGain: z.number().catch(0).default(0),
  relationship: relationshipTextureSchema.catch(emptyRelationshipTexture()).default(emptyRelationshipTexture()),
  conditions: conditionsSchema,
  mindNote: z.string(),
  wornItemIds: wornItemIdsSchema.catch([]).default([]),
  outfitPresetId: z.string().catch("").default(""),
  outfit: z.string(),
  outfitExposed: z.boolean(),
  surfacedCues: surfacedCuesSchema,
  memoryQueries: memoryQueriesSchema,
  openLoops: memoryQueriesSchema.catch([]).default([]),
  attributeOverlays: attributeOverlaysSchema,
  traitOverlays: traitOverlaysSchema.catch([]).default([]),
  voiceExemplars: voiceExemplarsSchema.catch([]).default([]),
  lastPulseTrace: chatPulseTraceSchema,
  lastMemoryTrace: chatMemoryTraceSchema,
  relationshipHistory: relationshipHistorySchema.catch([]).default([]),
  milestones: milestonesSchema.catch([]).default([]),
  callbackHistory: callbackHistorySchema.catch([]).default([]),
  feeling: chatFeelingStateSchema.catch(emptyChatFeelingState()).default(emptyChatFeelingState()),
  selfieHistory: selfieHistorySchema.catch([]).default([]),
  drives: chatDrivesSchema.catch([]).default([]),
  bodySurface: bodySurfaceStateSchema.catch(emptyBodySurfaceState()).default(emptyBodySurfaceState()),
  presence: z.enum(["present", "away"]).catch("present").default("present"),
  whereabouts: z.string().catch("").default(""),
  quietExchanges: z.number().catch(0).default(0),
});

/**
 * Persist the "another take" rollback anchor: the state as it stood before the
 * exchange. Targeted UPDATE — the row exists by the time the finalizer
 * calls this (saveChatState upserted it just before). `null` ⇒ `{}` — the recorded
 * sentinel for "there was no pre-exchange state" (a first exchange seeded from the
 * authored defaults); `loadPreExchangeState` maps `{}` back to a null rollback
 * target (re-seed). With `guardMessageId` the write only lands while that prompting
 * message still exists — same guard as the paired `saveChatState`, so a mid-stream
 * delete can't leave the anchor pointing at a state that was never saved.
 *
 * `writer` defaults to the root client; pass a transaction handle to fold the
 * anchor into a caller's atomic settlement (`persistSurfaceTransferSettlement`).
 */
export async function savePreExchangeSnapshot(
  chatId: string,
  characterId: string,
  state: ChatState | null,
  guardMessageId?: string,
  writer: DbWriter = db(),
): Promise<void> {
  const guard = guardMessageId
    ? sql`exists (select 1 from ${characterChatMessages} where id = ${guardMessageId})`
    : sql`true`;
  await writer
    .update(characterChatState)
    .set({ preExchangeState: state ?? {} })
    .where(and(eq(characterChatState.chatId, chatId), eq(characterChatState.characterId, characterId), guard));
}

/**
 * Load the "another take" rollback anchor (followups F3). Three outcomes, because a
 * first exchange's anchor and a missing/corrupt one must NOT collapse to the same
 * thing (the old bug: regenerating the first reply parsed the recorded `{}`, failed,
 * and silently fell back to the POST-exchange state — double-ticking the clock and
 * re-applying the pulse):
 * - `{ found: true, state }` — a recorded prior state to roll back to.
 * - `{ found: true, state: null }` — the anchor is `{}` (first exchange, no prior
 *   state): the caller re-seeds from the authored defaults, exactly as the live
 *   first exchange did.
 * - `{ found: false, state: null }` — no row: degrade to no-rollback with a diagnostic.
 */
export async function loadPreExchangeState(
  chatId: string,
  characterId: string,
): Promise<{ found: boolean; state: ChatState | null }> {
  const [row] = await db()
    .select({ preExchangeState: characterChatState.preExchangeState })
    .from(characterChatState)
    .where(and(eq(characterChatState.chatId, chatId), eq(characterChatState.characterId, characterId)))
    .limit(1);
  if (!row) return { found: false, state: null };
  // `{}` (the null-pre-state sentinel, and the column default) ⇒ re-seed on rollback.
  if (isEmptyJsonObject(row.preExchangeState)) return { found: true, state: null };
  const parsed = parseOrNull(storedChatStateSchema, row.preExchangeState);
  if (!parsed) return { found: false, state: null };
  return { found: true, state: { ...parsed, regard: clampRegard(parsed.regard) } };
}

/** True for a jsonb `{}` — the recorded "no pre-exchange state" rollback sentinel. */
function isEmptyJsonObject(value: unknown): boolean {
  return typeof value === "object" && value !== null && !Array.isArray(value) && Object.keys(value).length === 0;
}