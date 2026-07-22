import { desc, eq } from "drizzle-orm";
import { newId } from "@/lib/ids";
import { formatStoryClock, storyClockAt } from "@/lib/simulation/clock";
import { log } from "../log";
import {
  characterChatMessages,
  characterChatState,
  chatParticipants,
  db,
  simCharacters,
  simShadowDivergences,
} from "@/server/db";
import { readChatEngineAuthority } from "./chat-authority";
import { loadChatScenario } from "./chat-state";
import { tryKeyedLock } from "./keyed-lock";
import { findOrOpenStandingEngagement, findStandingEngagement } from "./sim-exchange";
import { renderCommittedCut } from "./sim-narrator";
import { advanceBranchStoryTime, prepareEngagementTurn, readDurableBodies } from "./simulation";

/**
 * R4 — shadow mode under chat (engine.rollout.plan.md). A `successor_shadow`
 * chat runs the LEGACY pipeline untouched; after each plain-send exchange
 * settles, this leg computes the successor's view of the same turn against
 * the linked mirror branch and records one divergence row per compared
 * domain (prose · presence · meters · clock). Observations, never effects:
 * nothing here writes chat state or the transcript — the mirror branch is
 * the successor's own world and may advance. Fire-and-forget: every failure
 * degrades to a log line, never a thrown turn (docs/resilience.md).
 */

export interface ShadowExchangeInput {
  chatId: string;
  userId: string;
  /** The settled assistant message — the comparison's anchor + the legacy prose. */
  assistantMessageId: string;
  /** The player's line this exchange answered. */
  content: string;
}

export interface ShadowExchangeResult {
  ran: boolean;
  rows: number;
}

/** One divergence row's write shape, before ids/stamps. */
interface ShadowRow {
  domain: string;
  legacy: unknown;
  successor: unknown;
  detail: string;
}

/**
 * Run one shadow comparison for a settled exchange. Returns `{ran: false}`
 * when the chat is not shadow-routed, a run is already in flight (skip, never
 * queue — the next exchange compares fresher state anyway), or the leg failed.
 */
export async function runShadowChatExchange(input: ShadowExchangeInput): Promise<ShadowExchangeResult> {
  try {
    const authority = await readChatEngineAuthority(input.chatId);
    if (
      !authority ||
      authority.authority !== "successor_shadow" ||
      !authority.simBranchId ||
      !authority.simPlayerActorId ||
      !authority.simPrimaryActorId
    ) {
      return { ran: false, rows: 0 };
    }
    const branchId = authority.simBranchId;
    const playerActorId = authority.simPlayerActorId;
    const primaryActorId = authority.simPrimaryActorId;

    const run = tryKeyedLock(`sim_shadow:${input.chatId}`, () =>
      compareExchange(input, branchId, playerActorId, primaryActorId),
    );
    if (run === null) {
      log.info("engine.shadow", "shadow run already in flight; skipped", { chatId: input.chatId });
      return { ran: false, rows: 0 };
    }
    return await run;
  } catch (error) {
    log.error("engine.shadow", "shadow exchange failed", {
      chatId: input.chatId,
      error: error instanceof Error ? error.message : String(error),
    });
    return { ran: false, rows: 0 };
  }
}

async function compareExchange(
  input: ShadowExchangeInput,
  branchId: string,
  playerActorId: string,
  primaryActorId: string,
): Promise<ShadowExchangeResult> {
  // --- Legacy view -----------------------------------------------------------
  const [assistantRow] = await db()
    .select({ content: characterChatMessages.content })
    .from(characterChatMessages)
    .where(eq(characterChatMessages.id, input.assistantMessageId));
  const legacyProse = assistantRow?.content ?? "";
  const scenario = await loadChatScenario(input.chatId);
  const participantRows = await db()
    .select({ characterId: chatParticipants.characterId, sort: chatParticipants.sort })
    .from(chatParticipants)
    .where(eq(chatParticipants.chatId, input.chatId));
  const primaryCharacterId = participantRows.slice().sort((a, b) => a.sort - b.sort)[0]?.characterId ?? null;
  const stateRows = await db()
    .select({
      characterId: characterChatState.characterId,
      presence: characterChatState.presence,
      meters: characterChatState.meters,
    })
    .from(characterChatState)
    .where(eq(characterChatState.chatId, input.chatId));
  const legacyPresence = Object.fromEntries(stateRows.map((row) => [row.characterId, row.presence]));
  const legacyMeters = stateRows.find((row) => row.characterId === primaryCharacterId)?.meters ?? {};

  // --- Successor view (the mirror branch advances; the chat lane never does) --
  const nameRows = await db()
    .select({ characterId: simCharacters.characterId, name: simCharacters.name })
    .from(simCharacters)
    .where(eq(simCharacters.branchId, branchId));
  const actorNames = Object.fromEntries(nameRows.map((row) => [row.characterId, row.name]));
  const playerName = actorNames[playerActorId] ?? "the player";

  // The tail the LEGACY narrator answered: the transcript before this
  // exchange's own two lines — so both narrators saw the same conversation.
  const tailRows = await db()
    .select({ id: characterChatMessages.id, role: characterChatMessages.role, content: characterChatMessages.content })
    .from(characterChatMessages)
    .where(eq(characterChatMessages.chatId, input.chatId))
    .orderBy(desc(characterChatMessages.createdAt), desc(characterChatMessages.id))
    .limit(8);
  const priorRows = tailRows.filter((row) => row.id !== input.assistantMessageId);
  const newestUserIndex = priorRows.findIndex((row) => row.role === "user");
  if (newestUserIndex >= 0) priorRows.splice(newestUserIndex, 1);
  const dialogueTail = priorRows
    .slice(0, 6)
    .reverse()
    .map((row) => ({
      speaker: row.role === "user" ? `PLAYER (as ${playerName})` : "NARRATION (previous)",
      text: row.content,
    }));

  const rows: ShadowRow[] = [];
  const scene = await findOrOpenStandingEngagement({
    branchId,
    playerActorId,
    primaryActorId,
    userId: input.userId,
    correlationId: `sim-shadow-${input.chatId}`,
  });
  if (scene.ok) {
    const turn = await prepareEngagementTurn({
      branchId,
      engagementId: scene.engagementId,
      viewpointActorId: playerActorId,
      spanSeconds: 60,
      playerActorIds: [playerActorId],
      // Shadow renders skip live deliberation (plan ruling): comparison prose
      // does not justify a second model-call class — deterministic policy only.
      workerId: `sim-shadow-${input.chatId}`,
    });
    const rendered = await renderCommittedCut({
      branchId,
      engagementId: scene.engagementId,
      cutId: turn.cut.id,
      conversation: { playerUtterance: input.content, dialogueTail, viewpointIsPlayer: true, actorNames },
    });
    rows.push({
      domain: "prose",
      legacy: { prose: legacyProse },
      successor: {
        status: rendered.status,
        prose: rendered.prose ?? "",
        cutId: rendered.cutId,
        modelId: rendered.modelId,
        degraded: rendered.degraded,
      },
      detail: rendered.status === "rendered" ? "" : "the successor render was withheld",
    });
  } else {
    rows.push({
      domain: "prose",
      legacy: { prose: legacyProse },
      successor: { status: "refused", code: scene.code, publicReason: scene.publicReason },
      detail: `the mirror scene could not open: ${scene.publicReason}`,
    });
  }

  // Presence: chat-side roster presence vs the mirror's physical truth for the
  // mapped pair (co-located + a standing co-present engagement).
  const standing = await findStandingEngagement(branchId, playerActorId, primaryActorId);
  const primaryPresent = primaryCharacterId === null || (legacyPresence[primaryCharacterId] ?? "present") === "present";
  const pairEngaged = standing.engagementId !== null;
  rows.push({
    domain: "presence",
    legacy: { presence: legacyPresence },
    successor: { standingEngagementId: standing.engagementId },
    detail:
      primaryPresent === pairEngaged
        ? ""
        : primaryPresent
          ? "chat says the primary is present but the mirror pair holds no open scene"
          : "the mirror pair holds an open scene but chat says the primary is away",
  });

  // Meters: the primary's chat meters vs the mapped actor's mirror body meters
  // (ruling 15 made these comparable). Raw capture — the parity report does the
  // scale-aware analysis; an empty mirror map is itself the honest divergence.
  const bodies = await readDurableBodies(branchId);
  const successorMeters = Object.fromEntries(
    bodies.meters
      .filter((meter) => meter.actorId === primaryActorId)
      .map((meter) => [meter.meterKey, meter.valueFixedPoint]),
  );
  rows.push({
    domain: "meters",
    legacy: { meters: legacyMeters },
    successor: { metersFixedPoint: successorMeters },
    detail: Object.keys(successorMeters).length === 0 ? "no body meters instantiated on the mirror actor" : "",
  });

  // Clock: incommensurate absolutes (R4 drift note) — record both raw; deltas
  // across successive rows are the comparable quantity.
  const clock = storyClockAt(bodies.storySecond);
  rows.push({
    domain: "clock",
    legacy: { clockMinutes: scenario?.clockMinutes ?? 0 },
    successor: { storySecond: bodies.storySecond, label: formatStoryClock(clock) },
    detail: "absolutes are incommensurate; compare deltas across successive rows",
  });

  await db()
    .insert(simShadowDivergences)
    .values(
      rows.map((row) => ({
        id: newId(),
        chatId: input.chatId,
        messageId: input.assistantMessageId,
        branchId,
        domain: row.domain,
        legacy: row.legacy,
        successor: row.successor,
        detail: row.detail,
      })),
    );
  return { ran: true, rows: rows.length };
}

/**
 * Mirror a legacy time skip onto the shadow branch (same minutes, bounded
 * drain) so the two clocks keep comparable deltas. No-op for non-shadow
 * chats; failures degrade to a log line.
 */
export async function mirrorShadowTimeSkip(chatId: string, minutes: number): Promise<void> {
  try {
    const authority = await readChatEngineAuthority(chatId);
    if (!authority || authority.authority !== "successor_shadow" || !authority.simBranchId) return;
    const branchId = authority.simBranchId;
    const bodies = await readDurableBodies(branchId);
    const target = bodies.storySecond + minutes * 60;
    for (let calls = 0; ; calls += 1) {
      if (calls > 1_000) {
        log.warn("engine.shadow", "shadow skip drain did not converge", { chatId, branchId });
        return;
      }
      const outcome = await advanceBranchStoryTime(branchId, target, { workerId: `sim-shadow-skip-${newId()}` });
      if (outcome.status === "advanced") return;
    }
  } catch (error) {
    log.error("engine.shadow", "shadow time-skip mirror failed", {
      chatId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
