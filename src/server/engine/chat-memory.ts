import {
  chatArchivistSchema,
  degradedChatArchivist,
  diag,
  type ChatArchivist,
  type DiagnosticSink,
  type FactDraft,
  type RetrievedMemoryDetail,
} from "@/contracts";
import type { Milestone } from "@/contracts/relationships/history";
import { agentModelId, embedText, generateChecked, isDemoMode, toVectorLiteral, withGenerateTimeout } from "../ai";
import type { DbWriter } from "../db";
import {
  addFacts,
  appendEpisode,
  callbackEpisodeCandidates,
  chatScope,
  deleteEpisodeForMessage,
  deleteEpisodesForScope,
  deleteFactsForScope,
  FACT_RETRIEVAL_LIMIT,
  latestEpisodeNumber,
  retractFactsForMessage,
  retrieveEpisodesFused,
  retrieveFactsFused,
  type FactDraftInput,
} from "../memory";
import {
  CHAT_CALLBACK_CANDIDATE_LIMIT,
  CHAT_CALLBACK_MIN_AGE_TURNS,
  selectChatCallback,
  type ChatCallback,
} from "./chat-callback";
import { CHAT_ARCHIVIST_MAX_OUTPUT_TOKENS, CHAT_ARCHIVIST_TIMEOUT_MS } from "./constants";
import { buildChatArchivistPrompt, CHAT_ARCHIVIST_SYSTEM } from "./prompts/chat-archivist";

/**
 * Character-chat long-term memory (character-chat-primary.spec.md §2), the RAG half the
 * sessionless chat previously lacked. Three concerns:
 *
 * - `retrieveChatMemory` — PRE-turn recall: cosine RAG over the participant's memory group
 *   (spec §1.3), keyed on last turn's `memoryQueries` + the player input.
 * - `runChatArchivist` — POST-turn extraction: one cheap structured call (the pulse recipe —
 *   reasoning off, latency-sorted routing, no repair, hard timeout) emitting an episode summary,
 *   durable facts, and next-turn queries. Runs in parallel with the reaction pulse.
 * - `writeChatMemory` — persists that extraction through the shared `appendEpisode` / `addFacts`
 *   memory API under the chat scope (`sourceTurnId = null`, the inner-note template).
 *
 * Everything degrades to a diagnostic, never a failed reply: a missed extraction leaves the
 * chat on the verbatim-window + rolling-summary memory it always had.
 */

export interface ChatMemoryHits {
  /** Retrieved fact texts (pinned force-includes first, then fused top-k). */
  facts: string[];
  /** Retrieved episode summaries (older than the recency window). */
  episodes: string[];
  /** Per-hit retrieval detail (spec §6.3 #2 — scores + per-source attribution) for the trace. */
  detail: RetrievedMemoryDetail[];
}

/**
 * Per-turn RAG recall (spec §6.3 #2): each query — last turn's `memoryQueries` plus
 * the player's input — is embedded separately and retrieved independently, then
 * fused by reciprocal rank (`retrieveFactsFused`/`retrieveEpisodesFused`); pinned
 * player facts (§6.4) ride ahead of the top-k regardless of similarity. With no
 * usable queries (an opening beat) the recall is pinned-facts-only — a pinned note
 * always reaches the character.
 */
export async function retrieveChatMemory(input: {
  /** The participant's memory group (character-chat-standalone.spec.md §1.3). */
  groupId: string;
  /** Last turn's `memoryQueries` (persisted on the chat state). */
  queries: readonly string[];
  /** This turn's player input. */
  input: string;
  /**
   * Per-leg k override (multi-character-chat.plan.md ruling 5): an ensemble
   * tightens each member's leg as the active count grows. Absent ⇒ the defaults.
   */
  limit?: number;
  sink?: DiagnosticSink;
}): Promise<ChatMemoryHits> {
  const queries = [...input.queries, input.input];
  const scope = chatScope(input.groupId);
  const [ep, fa] = await Promise.allSettled([
    retrieveEpisodesFused(scope, queries, input.limit, input.sink),
    retrieveFactsFused(scope, queries, input.limit ?? FACT_RETRIEVAL_LIMIT, input.sink),
  ]);

  if (ep.status === "rejected") {
    input.sink?.push(diag("error", "chat_memory.episodes_failed", `episode recall failed: ${errText(ep.reason)}`));
  }
  if (fa.status === "rejected") {
    input.sink?.push(diag("error", "chat_memory.facts_failed", `fact recall failed: ${errText(fa.reason)}`));
  }
  const factHits = fa.status === "fulfilled" ? fa.value : [];
  const episodeHits = ep.status === "fulfilled" ? ep.value : [];
  return {
    episodes: episodeHits.map((h) => h.summary),
    facts: factHits.map((h) => h.text),
    detail: [
      ...factHits.map((h) => ({
        kind: "fact" as const,
        id: h.id,
        text: h.text,
        score: h.score,
        pinned: h.pinned,
        sources: h.sources,
      })),
      ...episodeHits.map((h) => ({
        kind: "episode" as const,
        id: h.id,
        text: h.summary,
        score: h.score,
        pinned: false,
        sources: h.sources,
      })),
    ],
  };
}

/**
 * Pick this turn's memory callback (memory-callbacks.plan.md), if any: embed the
 * player's input once, fetch old episodes with their similarity to it, and run the
 * pure selector (old + milestone-boosted + topic-distant + never repeated). The
 * eligibility gate already passed (pipeline-side, pure) before this cost is paid.
 * Any failure degrades to null with `chat_memory.callback.failed` — a missing
 * callback is just an ordinary turn, never a failed reply.
 */
export async function retrieveChatCallback(input: {
  groupId: string;
  /** This turn's player input — the anti-echo anchor. */
  input: string;
  milestones: readonly Milestone[];
  /** Refs already offered (the state's callback ring) — never repeated. */
  usedRefs: readonly string[];
  sink?: DiagnosticSink;
}): Promise<ChatCallback | null> {
  try {
    const scope = chatScope(input.groupId);
    const latestTurn = await latestEpisodeNumber(scope);
    const maxTurn = latestTurn - CHAT_CALLBACK_MIN_AGE_TURNS;
    if (maxTurn < 1) return null;
    const embedded = await embedText(input.input);
    const candidates = await callbackEpisodeCandidates(scope, toVectorLiteral(embedded.vector), {
      maxTurn,
      excludeIds: input.usedRefs.filter((r) => r.startsWith("e:")).map((r) => r.slice(2)),
      limit: CHAT_CALLBACK_CANDIDATE_LIMIT,
    });
    return selectChatCallback({ candidates, milestones: input.milestones, usedRefs: input.usedRefs, latestTurn });
  } catch (err) {
    input.sink?.push(diag("warn", "chat_memory.callback.failed", `callback retrieval failed: ${errText(err)}`));
    return null;
  }
}

export interface ChatArchivistInput {
  characterName: string;
  playerName: string;
  exchange: { player: string; assistant: string };
  /** The standing open-loops list (spec §6.2) — re-emitted in full so resolved loops fall off. */
  openLoops?: readonly string[];
  /** The standing drives (character-drives.plan.md) — the driveUpdates match targets. */
  drives?: readonly { want: string; secrecy: string; revealed: boolean }[];
  /** The roster with live presence (multi-character-chat.plan.md) — arms the presence field. */
  roster?: readonly { name: string; presence: "present" | "away" }[];
  sink?: DiagnosticSink;
}

/**
 * Run the archivist-lite leg. Mirrors `runChatPulse`'s resilience recipe; returns `null`
 * on demo mode / timeout / parse failure so the caller writes no memory and carries no
 * stale queries. Uses the cheap AGENT model, never the narrator model.
 */
export async function runChatArchivist(
  input: ChatArchivistInput,
): Promise<{ value: ChatArchivist | null; degraded: boolean }> {
  if (isDemoMode()) {
    input.sink?.push(diag("info", "chat_archivist.degraded", "demo mode; skipping chat memory extraction"));
    return { value: null, degraded: true };
  }

  const controller = new AbortController();
  const work = generateChecked<ChatArchivist>({
    schema: chatArchivistSchema,
    system: CHAT_ARCHIVIST_SYSTEM,
    prompt: buildChatArchivistPrompt({
      characterName: input.characterName,
      playerName: input.playerName,
      exchange: input.exchange,
      openLoops: input.openLoops,
      drives: input.drives,
      roster: input.roster,
    }),
    modelId: agentModelId(),
    temperature: 0,
    maxOutputTokens: CHAT_ARCHIVIST_MAX_OUTPUT_TOKENS,
    code: "chat_archivist.extract",
    sink: input.sink,
    fallback: degradedChatArchivist,
    signal: controller.signal,
    disableReasoning: true,
    lowLatencyRouting: true,
    repair: false,
    degradeSeverity: "warn",
  });

  const { value, degraded } = await withGenerateTimeout(
    work,
    controller,
    CHAT_ARCHIVIST_TIMEOUT_MS,
    "chat_archivist.timeout",
    input.sink,
  );
  return { value: degraded ? null : value, degraded };
}

/**
 * Persist a finished archivist extraction under the chat scope: append the episode (its
 * `turnNumber` is a per-chat exchange ordinal) and add the durable facts (`sourceTurnId =
 * null`, witnessed by the character — the write-only interim witness set). A `null` /
 * degraded archivist is a no-op. Each write degrades internally (embedding failure keeps
 * the row's audit value, drops it from RAG).
 */
export async function writeChatMemory(input: {
  /** The participant's memory group (spec §1.3). */
  groupId: string;
  /** The speaking character — the interim write-only witness set. */
  characterId: string;
  /** Provenance anchor (spec §4.3): the assistant message this exchange's memory came from. */
  assistantMessageId: string | null;
  archivist: ChatArchivist | null;
  sink?: DiagnosticSink;
}): Promise<void> {
  const result = input.archivist;
  if (!result) return;
  const scope = chatScope(input.groupId);

  const summary = result.episodeSummary.trim();
  if (summary) {
    const turnNumber = (await latestEpisodeNumber(scope)) + 1;
    await appendEpisode(scope, turnNumber, summary, [], input.sink, [input.characterId], input.assistantMessageId);
  }
  if (result.facts.length) {
    const drafts: FactDraftInput[] = result.facts.map((fact: FactDraft) => ({
      ...fact,
      witnessedBy: [input.characterId],
    }));
    await addFacts(scope, drafts, { messageId: input.assistantMessageId }, input.sink);
  }
}

/**
 * Undo one assistant message's extracted memory (spec §4.3): retract its facts
 * (status flip, audit kept) and delete its episode. The reconciliation behind
 * message delete/edit and "another take" — without it the recovery levers clean
 * the window but leave the poisoned memory in RAG.
 */
export async function reconcileMessageMemory(messageId: string, sink?: DiagnosticSink): Promise<void> {
  const retracted = await retractFactsForMessage(messageId);
  const episodes = await deleteEpisodeForMessage(messageId);
  if (retracted.length || episodes) {
    sink?.push(
      diag(
        "info",
        "chat_memory.reconciled",
        `retracted ${retracted.length} fact(s), deleted ${episodes} episode(s) for message ${messageId}`,
      ),
    );
  }
}

/**
 * Purge a memory group's facts + episodes. Called by `deleteChat` when the deleted
 * conversation was the LAST one referencing its group (character-chat-standalone.spec.md
 * §1.4) — shared-history siblings keep the group alive.
 */
export async function deleteChatMemory(groupId: string, dbc?: DbWriter): Promise<void> {
  const scope = chatScope(groupId);
  await deleteFactsForScope(scope, dbc);
  await deleteEpisodesForScope(scope, dbc);
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
