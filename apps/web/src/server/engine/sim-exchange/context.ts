import { characterProfileSchema, DiagnosticCollector, emptyCharacterProfile } from "@/contracts";
import type { NarratorInstructionSource } from "@/contracts/narrator-prompts";
import type { CharacterProfile } from "@/contracts/world/profile";
import { parseOr } from "@/lib/parse";
import { characterChatMessages, characters, chatParticipants, db, simCharacters, simZones } from "@/server/db";
import { asc, desc, eq } from "drizzle-orm";
import { embedText, embedTexts } from "@/server/ai";
import { resolveChatPersona } from "../../players";
import { readChatEngineAuthority } from "../chat-authority";
import { isWorldBeatMeta } from "../sim-beats";
import { loadChatSummary } from "../chat-summary";
import { log } from "../../log";
import { resolveNarratorInstructionSource } from "@/server/narrator-prompts";
import { narrationShapeId, type NarrationShapeId } from "../prompts/constants";
import { readSimChatOutfit, readSimChatRelationship, zoneDisplayNoun, type SimChatRelationship } from "../sim-surfaces";
import { drainMemoryIndexOutbox, queryMemoryDocuments, type MemoryEmbedder } from "../simulation";
import type { SimChatExchangeResult } from "./types";

/** The live embedder adapter for the memory index — pseudo in demo mode, real otherwise. */
const memoryEmbedder: MemoryEmbedder = async (texts) => {
  const embedded = await embedTexts(texts);
  return { model: embedded[0]?.embedder ?? "pseudo", vectors: embedded.map((entry) => entry.vector) };
};

/**
 * Knowledge/memory — viewpoint recall for one utterance: drain the
 * branch-agnostic index outbox (bounded — recall is current for the scene
 * being played), embed the utterance, and query the viewpoint's documents.
 * Returns epistemic-labeled lines for the prompt; every failure degrades to
 * [] with a log line, never a failed turn.
 */
async function recallViewpointMemory(input: {
  chatId: string;
  branchId: string;
  viewpointActorId: string;
  message: string;
  atStorySecond: number;
}): Promise<string[]> {
  try {
    await drainMemoryIndexOutbox({ workerId: `sim-mem-${input.chatId}`, embed: memoryEmbedder, maxIterations: 25 });
    const embedded = await embedText(input.message);
    const recall = await queryMemoryDocuments({
      branchId: input.branchId,
      viewpointActorId: input.viewpointActorId,
      atStorySecond: input.atStorySecond,
      queryText: input.message,
      queryEmbedding: embedded.vector,
      queryEmbeddingModel: embedded.embedder,
      limit: 6,
    });
    return recall.results.map((result) => `[${result.epistemicLabel}] ${result.text}`);
  } catch (error) {
    log.warn("engine.sim", "viewpoint recall degraded to empty", {
      chatId: input.chatId,
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

/** A chat authority proven routed to the successor engine (branch + actors mapped). */
type RoutedAuthority = NonNullable<Awaited<ReturnType<typeof readChatEngineAuthority>>> & {
  simBranchId: string;
  simPlayerActorId: string;
  simPrimaryActorId: string;
};

/**
 * Is this chat routed to the successor engine? The ONE predicate every sim path
 * shares — an authority past the view threshold, branch-linked, and actor-mapped.
 * A type guard so the route can use it as a boolean (GET affordance flag + POST
 * fork) while the exchange core reuses it AND gets the narrowed branch/actor ids.
 */
export function isSimRoutedAuthority(
  authority: Awaited<ReturnType<typeof readChatEngineAuthority>>,
): authority is RoutedAuthority {
  return (
    authority !== null &&
    authority.authority !== "legacy_chat" &&
    authority.authority !== "successor_shadow" &&
    authority.simBranchId !== null &&
    authority.simPlayerActorId !== null &&
    authority.simPrimaryActorId !== null
  );
}

export interface ResolvedSimExchange {
  branchId: string;
  playerActorId: string;
  primaryActorId: string;
  /** World-truth display names by actor id — ids never read well in prose. */
  actorNames: Record<string, string>;
  playerName: string;
  ragEligibility: boolean;
  /**
   * The ONE narrator instruction source this exchange runs on, resolved once under
   * the exchange lock.
   *
   * It rides the context because every successor turn shape — co-present, solo,
   * departure, accompany, retake — receives this object, so carrying it here is
   * what makes "leaving the primary's physical scene must not silently switch back
   * to production instructions" true by construction rather than by remembering to
   * pass it at five call sites.
   */
  instructionSource: NarratorInstructionSource;
  /** Codes for a selection that failed to resolve — merged into the turn's diagnostics. */
  instructionDiagnostics: readonly string[];
}

/**
 * The shared gate + world-truth names for one exchange: resolve authority, refuse
 * a non-sim chat, load the branch's actor display names, and freeze the narrator
 * instruction source. Every mode starts here so the gate lives in exactly one place.
 *
 * Both callers of `runSimChatExchange` (the ordinary chat send and `/sim-turn`)
 * hold the per-chat exchange lock before they get here, which is the condition the
 * resolver requires: one exact revision per exchange, read after the lock and
 * never re-read.
 */
export async function resolveSimExchange(
  ownerId: string,
  chatId: string,
): Promise<{ ok: true; ctx: ResolvedSimExchange } | { ok: false; result: SimChatExchangeResult }> {
  const authority = await readChatEngineAuthority(chatId);
  if (!isSimRoutedAuthority(authority)) {
    return {
      ok: false,
      result: {
        ok: false,
        code: "not_sim_enabled",
        message: "this chat is not routed to the successor engine (authority + branch + actor mapping required)",
        status: 409,
      },
    };
  }
  const branchId = authority.simBranchId;
  const playerActorId = authority.simPlayerActorId;
  const nameRows = await db()
    .select({ characterId: simCharacters.characterId, name: simCharacters.name })
    .from(simCharacters)
    .where(eq(simCharacters.branchId, branchId));
  const actorNames = Object.fromEntries(nameRows.map((row) => [row.characterId, row.name]));
  // The Prompt Lab selection, resolved ONCE for the whole exchange. It never
  // throws: a template that is gone, soft-deleted or unreadable degrades to
  // production instructions and files the reason, which is then carried on the
  // turn's diagnostics so a silently-degraded experiment is visible.
  const instructions = new DiagnosticCollector();
  const instructionSource = await resolveNarratorInstructionSource(ownerId, chatId, instructions);
  return {
    ok: true,
    ctx: {
      branchId,
      playerActorId,
      primaryActorId: authority.simPrimaryActorId,
      actorNames,
      playerName: actorNames[playerActorId] ?? "the player",
      ragEligibility: authority.ragEligibility,
      instructionSource,
      instructionDiagnostics: instructions.items.map((item) =>
        typeof item.context?.reason === "string" ? `${item.code}:${item.context.reason}` : item.code,
      ),
    },
  };
}

/**
 * The rolling dialogue tail the narrator responds to (oldest first). Assistant
 * lines are labeled NARRATION (previous), never a character — earlier replies may
 * have wrongly voiced the player's character and must read as narration output.
 * `excludeMessageId` drops one row (the reply a retake is re-rendering — it must
 * never read itself back). World-beat rows (travel/skip/scene traces) are
 * skipped — they are a UI trace, never narration the model produced or should echo.
 * 30 lines (~15 exchanges) — the charter's history depth, on top of the memory arc.
 */
export async function loadSimDialogueTail(
  chatId: string,
  playerName: string,
  excludeMessageId?: string,
): Promise<{ speaker: string; text: string }[]> {
  const tailRows = await db()
    .select({
      id: characterChatMessages.id,
      role: characterChatMessages.role,
      content: characterChatMessages.content,
      meta: characterChatMessages.meta,
    })
    .from(characterChatMessages)
    .where(eq(characterChatMessages.chatId, chatId))
    .orderBy(desc(characterChatMessages.createdAt), desc(characterChatMessages.id))
    .limit(excludeMessageId ? 41 : 40);
  return tailRows
    .filter((row) => row.id !== excludeMessageId && !isWorldBeatMeta(row.meta))
    .slice(0, 30)
    .reverse()
    .map((row) => ({
      speaker: row.role === "user" ? `PLAYER (as ${playerName})` : "NARRATION (previous)",
      text: row.content,
    }));
}

/**
 * The presentation context both a fresh turn and a retake feed the narrator:
 * viewpoint recall (rag-gated, and only against a real utterance) plus the rolling
 * conversation summary. Both degrade to absent — a failed recall narrows context,
 * never fails the turn (docs/resilience.md).
 */
export async function loadSimConversationContext(input: {
  chatId: string;
  branchId: string;
  viewpointActorId: string;
  message: string;
  ragEligibility: boolean;
  atStorySecond: number;
}): Promise<{ memory: string[]; conversationSummary: string }> {
  const memory =
    input.ragEligibility && input.message.trim().length > 0
      ? await recallViewpointMemory({
          chatId: input.chatId,
          branchId: input.branchId,
          viewpointActorId: input.viewpointActorId,
          message: input.message,
          atStorySecond: input.atStorySecond,
        })
      : [];
  const conversationSummary = await loadChatSummary(input.chatId)
    .then((row) => row?.summary ?? "")
    .catch(() => "");
  return { memory, conversationSummary };
}

/**
 * The rich charter context both a fresh turn and a retake feed the successor
 * narrator: the primary character's authored
 * profile, the player's persona, the sim wardrobe + relationship projections,
 * and zone display names — plus the active narration shape. EVERY field is
 * best-effort — any single load failure degrades to that field being absent with a
 * log.warn, never a failed turn (docs/resilience.md). The player name always
 * carries (world-truth, no load); the narration shape is a pure lookup.
 */
interface SimPresentationInputs {
  primary?: { name: string; profile: CharacterProfile };
  player: { name: string; persona?: string; voice?: string; intimacy?: string };
  outfitLine?: string;
  relationship?: SimChatRelationship;
  zoneNames?: Record<string, string>;
  narrationShape: NarrationShapeId;
}

/** One `log.warn` shape for a degraded presentation load (never a thrown turn). */
export function simLoadWarn(chatId: string, what: string, error: unknown): void {
  log.warn("engine.sim", what, { chatId, error: error instanceof Error ? error.message : String(error) });
}

/**
 * The primary's authored `CharacterProfile` from the chat's primary participant
 * (sort 0) — the AUTHORED CANON block's source, parsed with the degraded empty
 * default. A query failure narrows the prompt (no canon block), never fails it.
 */
async function loadSimPrimaryProfile(
  chatId: string,
  primaryName: string | undefined,
): Promise<{ name: string; profile: CharacterProfile } | undefined> {
  try {
    const [row] = await db()
      .select({ name: characters.name, profile: characters.profile })
      .from(chatParticipants)
      .innerJoin(characters, eq(characters.id, chatParticipants.characterId))
      .where(eq(chatParticipants.chatId, chatId))
      .orderBy(asc(chatParticipants.sort))
      .limit(1);
    if (!row) return undefined;
    const profile = parseOr(characterProfileSchema, row.profile ?? {}, emptyCharacterProfile(), undefined, "characters.profile");
    return { name: primaryName ?? row.name, profile };
  } catch (error) {
    simLoadWarn(chatId, "primary profile load degraded to absent", error);
    return undefined;
  }
}

/** The player persona's charter fields (persona/voice/intimacy); {} degrades to name-only. */
async function loadSimPlayerPersonaFields(
  userId: string,
  chatId: string,
): Promise<{ persona?: string; voice?: string; intimacy?: string }> {
  try {
    const persona = await resolveChatPersona({ ownerId: userId, chatId });
    return {
      ...(persona.persona?.trim() ? { persona: persona.persona } : {}),
      ...(persona.profile?.voice?.trim() ? { voice: persona.profile.voice } : {}),
      ...(persona.profile?.intimacy?.trim() ? { intimacy: persona.profile.intimacy } : {}),
    };
  } catch (error) {
    simLoadWarn(chatId, "player persona load degraded to name only", error);
    return {};
  }
}

/**
 * Zone display names by id for the branch — the humanized kind (`zoneDisplayNoun`,
 * the shared sim-surfaces map), so raw zone ids never reach the prose surface.
 * Unknown kinds are omitted (the render humanizes their id); absent on any failure.
 */
async function loadSimZoneNames(branchId: string, chatId: string): Promise<Record<string, string> | undefined> {
  try {
    const rows = await db()
      .select({ zoneId: simZones.zoneId, kind: simZones.kind })
      .from(simZones)
      .where(eq(simZones.branchId, branchId));
    const names: Record<string, string> = {};
    for (const row of rows) {
      const label = zoneDisplayNoun(row.kind);
      if (label) names[row.zoneId] = label;
    }
    return Object.keys(names).length > 0 ? names : undefined;
  } catch (error) {
    simLoadWarn(chatId, "zone display names degraded to absent", error);
    return undefined;
  }
}

/** Load the charter context once per exchange — all fields concurrent, each degrading alone. */
export async function loadSimPresentationInputs(input: {
  chatId: string;
  userId: string;
  branchId: string;
  primaryActorId: string;
  actorNames: Record<string, string>;
  playerName: string;
}): Promise<SimPresentationInputs> {
  const [primary, personaFields, outfit, relationship, zoneNames] = await Promise.all([
    loadSimPrimaryProfile(input.chatId, input.actorNames[input.primaryActorId]),
    loadSimPlayerPersonaFields(input.userId, input.chatId),
    // Both reads self-degrade to `null` with their own per-seam diagnostic
    // (the sim-surfaces guards), so no local `.catch` wrapper is needed here.
    readSimChatOutfit(input.chatId),
    readSimChatRelationship(input.chatId),
    loadSimZoneNames(input.branchId, input.chatId),
  ]);
  const outfitLine = outfit?.trim();
  return {
    ...(primary ? { primary } : {}),
    player: { name: input.playerName, ...personaFields },
    ...(outfitLine ? { outfitLine } : {}),
    ...(relationship ? { relationship } : {}),
    ...(zoneNames ? { zoneNames } : {}),
    narrationShape: narrationShapeId("chat"),
  };
}
