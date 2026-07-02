import {
  chatArchivistSchema,
  degradedChatArchivist,
  diag,
  type ChatArchivist,
  type DiagnosticSink,
  type FactDraft,
} from "@/contracts";
import { agentModelId, generateChecked, isDemoMode, withGenerateTimeout } from "../ai";
import type { DbWriter } from "../db";
import {
  addFacts,
  appendEpisode,
  chatScope,
  deleteEpisodesForScope,
  deleteFactsForScope,
  FACT_RETRIEVAL_LIMIT,
  latestEpisodeNumber,
  retrieveEpisodes,
  retrieveFacts,
  type FactDraftInput,
} from "../memory";
import { CHAT_ARCHIVIST_MAX_OUTPUT_TOKENS, CHAT_ARCHIVIST_TIMEOUT_MS } from "./constants";
import { buildChatArchivistPrompt, CHAT_ARCHIVIST_SYSTEM } from "./prompts/chat-archivist";

/**
 * Character-chat long-term memory (character-chat-primary.spec.md §2), the RAG half the
 * sessionless chat previously lacked. Three concerns:
 *
 * - `retrieveChatMemory` — PRE-turn recall: cosine RAG over the chat's own facts + episodes
 *   (scoped `(ownerId, characterId)`), keyed on last turn's `memoryQueries` + the player input.
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
  /** Retrieved fact texts (already deduped/limited by `retrieveFacts`). */
  facts: string[];
  /** Retrieved episode summaries (older than the recency window). */
  episodes: string[];
}

export async function retrieveChatMemory(input: {
  ownerId: string;
  characterId: string;
  /** Last turn's `memoryQueries` (persisted on the chat state). */
  queries: readonly string[];
  /** This turn's player input. */
  input: string;
  sink?: DiagnosticSink;
}): Promise<ChatMemoryHits> {
  const queryText = [...input.queries, input.input]
    .map((q) => q.trim())
    .filter(Boolean)
    .join("\n");
  if (!queryText) return { facts: [], episodes: [] };

  const scope = chatScope(input.ownerId, input.characterId);
  const [ep, fa] = await Promise.allSettled([
    retrieveEpisodes(scope, queryText, { sink: input.sink }),
    retrieveFacts(scope, queryText, FACT_RETRIEVAL_LIMIT, input.sink),
  ]);

  if (ep.status === "rejected") {
    input.sink?.push(diag("error", "chat_memory.episodes_failed", `episode recall failed: ${errText(ep.reason)}`));
  }
  if (fa.status === "rejected") {
    input.sink?.push(diag("error", "chat_memory.facts_failed", `fact recall failed: ${errText(fa.reason)}`));
  }
  return {
    episodes: ep.status === "fulfilled" ? ep.value.map((h) => h.summary) : [],
    facts: fa.status === "fulfilled" ? fa.value.map((h) => h.text) : [],
  };
}

export interface ChatArchivistInput {
  characterName: string;
  playerName: string;
  exchange: { player: string; assistant: string };
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
  ownerId: string;
  characterId: string;
  archivist: ChatArchivist | null;
  sink?: DiagnosticSink;
}): Promise<void> {
  const result = input.archivist;
  if (!result) return;
  const scope = chatScope(input.ownerId, input.characterId);

  const summary = result.episodeSummary.trim();
  if (summary) {
    const turnNumber = (await latestEpisodeNumber(scope)) + 1;
    await appendEpisode(scope, turnNumber, summary, [], input.sink, [input.characterId]);
  }
  if (result.facts.length) {
    const drafts: FactDraftInput[] = result.facts.map((fact: FactDraft) => ({
      ...fact,
      witnessedBy: [input.characterId],
    }));
    await addFacts(scope, drafts, null, input.sink);
  }
}

/**
 * Purge a chat's long-term memory — its facts + episodes. Part of the single "Clear Chat"
 * (character-chat-primary.spec.md §4), alongside `deleteChatState` and the transcript/summary
 * wipe. The `character_id` FK cascade already drops these when the character is deleted; this
 * is the in-place clear that keeps the character but resets the conversation.
 */
export async function deleteChatMemory(ownerId: string, characterId: string, dbc?: DbWriter): Promise<void> {
  const scope = chatScope(ownerId, characterId);
  await deleteFactsForScope(scope, dbc);
  await deleteEpisodesForScope(scope, dbc);
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
