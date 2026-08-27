import { eq } from "drizzle-orm";
import {
  DEFAULT_ENGINE_AUTHORITY,
  chatEngineAuthorityStateSchema,
  type ChatEngineAuthorityState,
  type EngineAuthority,
} from "@vesper/simulation-core/contracts/authority";
import { parseOr } from "@/lib/parse";
import { characterChats, events, db, type Db } from "@/server/db";

/**
 * The one seam a chat's engine authority is
 * read and flipped through. Reads pass the fail-closed boundary (a malformed
 * or missing value degrades to `legacy_chat`, never throws — resilience.md),
 * and every flip lands an audit row in the app `events` table in the same
 * transaction (the agent-health precedent: that table exists for exactly
 * this kind of durable operational record).
 */

export interface ChatAuthorityRow {
  engineAuthority: string;
  successorRagEligibility: boolean;
  simBranchId: string | null;
  simPlayerActorId: string | null;
  simPrimaryActorId: string | null;
}

/** Pure row → state, degraded default at the boundary. */
export function chatAuthorityStateFromRow(row: ChatAuthorityRow): ChatEngineAuthorityState {
  return parseOr(
    chatEngineAuthorityStateSchema,
    {
      authority: row.engineAuthority,
      ragEligibility: row.successorRagEligibility,
      simBranchId: row.simBranchId,
      simPlayerActorId: row.simPlayerActorId,
      simPrimaryActorId: row.simPrimaryActorId,
    },
    {
      authority: DEFAULT_ENGINE_AUTHORITY,
      ragEligibility: false,
      simBranchId: null,
      simPlayerActorId: null,
      simPrimaryActorId: null,
    },
    undefined,
    "character_chats.engine_authority",
  );
}

/** The chat's current authority state, or null when the chat does not exist. */
export async function readChatEngineAuthority(
  chatId: string,
  database: Db = db(),
): Promise<ChatEngineAuthorityState | null> {
  const [row] = await database
    .select({
      engineAuthority: characterChats.engineAuthority,
      successorRagEligibility: characterChats.successorRagEligibility,
      simBranchId: characterChats.simBranchId,
      simPlayerActorId: characterChats.simPlayerActorId,
      simPrimaryActorId: characterChats.simPrimaryActorId,
    })
    .from(characterChats)
    .where(eq(characterChats.id, chatId))
    .limit(1);
  return row ? chatAuthorityStateFromRow(row) : null;
}

export interface SetChatEngineAuthorityInput {
  chatId: string;
  /** The acting admin — stamped on the audit row. */
  byUserId: string;
  authority?: EngineAuthority;
  ragEligibility?: boolean;
  /** Explicit null unlinks; undefined leaves the link untouched. */
  simBranchId?: string | null;
  simPlayerActorId?: string | null;
  simPrimaryActorId?: string | null;
}

export interface SetChatEngineAuthorityResult {
  before: ChatEngineAuthorityState;
  after: ChatEngineAuthorityState;
}

/**
 * Flip a chat's authority state atomically with its audit record. Returns
 * null when the chat does not exist. A no-op flip (nothing changes) still
 * returns before/after but writes no audit row — the trail records changes,
 * not reads.
 */
export async function setChatEngineAuthority(
  input: SetChatEngineAuthorityInput,
  database: Db = db(),
): Promise<SetChatEngineAuthorityResult | null> {
  return database.transaction(async (tx) => {
    const [row] = await tx
      .select({
        engineAuthority: characterChats.engineAuthority,
        successorRagEligibility: characterChats.successorRagEligibility,
        simBranchId: characterChats.simBranchId,
        simPlayerActorId: characterChats.simPlayerActorId,
        simPrimaryActorId: characterChats.simPrimaryActorId,
      })
      .from(characterChats)
      .where(eq(characterChats.id, input.chatId))
      .limit(1)
      .for("update");
    if (!row) return null;

    const before = chatAuthorityStateFromRow(row);
    const after: ChatEngineAuthorityState = {
      authority: input.authority ?? before.authority,
      ragEligibility: input.ragEligibility ?? before.ragEligibility,
      simBranchId: input.simBranchId === undefined ? before.simBranchId : input.simBranchId,
      simPlayerActorId:
        input.simPlayerActorId === undefined ? before.simPlayerActorId : input.simPlayerActorId,
      simPrimaryActorId:
        input.simPrimaryActorId === undefined ? before.simPrimaryActorId : input.simPrimaryActorId,
    };
    if (
      after.authority === before.authority &&
      after.ragEligibility === before.ragEligibility &&
      after.simBranchId === before.simBranchId &&
      after.simPlayerActorId === before.simPlayerActorId &&
      after.simPrimaryActorId === before.simPrimaryActorId
    ) {
      return { before, after };
    }

    await tx
      .update(characterChats)
      .set({
        engineAuthority: after.authority,
        successorRagEligibility: after.ragEligibility,
        simBranchId: after.simBranchId,
        simPlayerActorId: after.simPlayerActorId,
        simPrimaryActorId: after.simPrimaryActorId,
      })
      .where(eq(characterChats.id, input.chatId));
    await tx.insert(events).values({
      type: "engine_authority_changed",
      payload: {
        chatId: input.chatId,
        byUserId: input.byUserId,
        before,
        after,
      },
    });
    return { before, after };
  });
}
