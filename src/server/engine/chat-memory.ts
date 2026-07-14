import {
  chatCharacterNotesSchema,
  chatContinuitySchema,
  chatMemoryScribeSchema,
  chatPersonalNotesSchema,
  degradedChatArchivist,
  degradedChatPersonalNotes,
  diag,
  mergeChatExtractions,
  type ChatArchivist,
  type ChatCharacterNotes,
  type ChatContinuity,
  type ChatExtractionLegs,
  type ChatMemoryScribe,
  type ChatPersonalNotes,
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
  type QueryEmbeddings,
} from "../memory";
import {
  CHAT_CALLBACK_CANDIDATE_LIMIT,
  CHAT_CALLBACK_MIN_AGE_TURNS,
  selectChatCallback,
  type ChatCallback,
} from "./chat-callback";
import {
  CHAT_CHARACTER_NOTES_MAX_OUTPUT_TOKENS,
  CHAT_CONTINUITY_MAX_OUTPUT_TOKENS,
  CHAT_EXTRACTOR_TIMEOUT_MS,
  CHAT_MEMORY_SCRIBE_MAX_OUTPUT_TOKENS,
  CHAT_PERSONAL_NOTES_MAX_OUTPUT_TOKENS,
  CHAT_PERSONAL_NOTES_TIMEOUT_MS,
} from "./constants";
import {
  buildChatExtractorPrompt,
  buildChatExtractorSystem,
  type ChatExtractorContext,
  type ChatExtractorLegId,
} from "./prompts/chat-extractors";

/**
 * Character-chat long-term memory (character-chat-primary.spec.md §2), the RAG half the
 * sessionless chat previously lacked. Three concerns:
 *
 * - `retrieveChatMemory` — PRE-turn recall: cosine RAG over the participant's memory group
 *   (spec §1.3), keyed on last turn's `memoryQueries` + the player input.
 * - `runChatExtraction` — POST-turn extraction: THREE cheap structured calls (the pulse recipe —
 *   reasoning off, latency-sorted routing, no repair, hard timeout) run in parallel with each
 *   other and with the reaction pulse — the memory scribe (episode + facts + next-turn queries),
 *   the continuity tracker (scene/outfit/appearance/presence/cast), and the character tracker
 *   (loops/drives/voice/slip/trait shifts). Composed from the field library
 *   (`prompts/chat-extractors.ts`) and merged back into one aggregate; formerly a single
 *   13-field `runChatArchivist` (chat-agent-improvements.plan.md).
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
  /**
   * The turn's shared query-embedding cache (chat-agent-improvements slice 3) — one embed
   * batch serves the fact leg, the episode leg, EVERY ensemble member's legs, and the
   * callback picker. Absent ⇒ each leg embeds its own (unchanged behavior).
   */
  embeddings?: QueryEmbeddings;
  sink?: DiagnosticSink;
}): Promise<ChatMemoryHits> {
  const queries = [...input.queries, input.input];
  const scope = chatScope(input.groupId);
  const [ep, fa] = await Promise.allSettled([
    retrieveEpisodesFused(scope, queries, input.limit, input.sink, input.embeddings),
    retrieveFactsFused(scope, queries, input.limit ?? FACT_RETRIEVAL_LIMIT, input.sink, input.embeddings),
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
  /**
   * The turn's shared query-embedding cache (chat-agent-improvements slice 3): the player's
   * input is ALREADY embedded for the recall legs, so the callback picker reuses that vector
   * instead of paying for a third embed of the same text. Absent ⇒ it embeds its own.
   */
  embeddings?: QueryEmbeddings;
  sink?: DiagnosticSink;
}): Promise<ChatCallback | null> {
  try {
    const scope = chatScope(input.groupId);
    const latestTurn = await latestEpisodeNumber(scope);
    const maxTurn = latestTurn - CHAT_CALLBACK_MIN_AGE_TURNS;
    if (maxTurn < 1) return null;
    const cached = input.embeddings?.vectorFor(input.input);
    const vector = cached ?? toVectorLiteral((await embedText(input.input)).vector);
    const candidates = await callbackEpisodeCandidates(scope, vector, {
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

export interface ChatExtractionInput extends Omit<ChatExtractorContext, "personal"> {
  sink?: DiagnosticSink;
}

/**
 * Per-leg degradation (chat-agent-improvements slice 1b). The folds need to tell "the
 * model said nothing" from "we never heard back", and now they can do it PER LEG: a
 * degraded character leg keeps the standing open loops instead of wiping them, a degraded
 * scribe drops the stale memory queries. One leg failing costs only its own fields.
 */
export interface ChatExtractionResult {
  /** The merged aggregate every fold consumes — degraded legs contribute empty fields. */
  value: ChatArchivist | null;
  /** True when EVERY leg degraded (the old whole-archivist degrade). */
  degraded: boolean;
  legs: ChatExtractionLegs;
}

/**
 * One extraction leg: the shared resilience recipe (cheap AGENT model, reasoning off,
 * latency-sorted routing, no repair, hard timeout, degrade-to-null) applied to a composed
 * sheet from the field library. Generic over the leg's picked schema.
 */
async function runExtractorLeg<T>(args: {
  legId: ChatExtractorLegId;
  ctx: ChatExtractorContext;
  schema: Parameters<typeof generateChecked<T>>[0]["schema"];
  fallback: () => T;
  maxOutputTokens: number;
  timeoutMs: number;
  code: string;
  sink?: DiagnosticSink;
}): Promise<{ value: T | null; degraded: boolean }> {
  const controller = new AbortController();
  const work = generateChecked<T>({
    schema: args.schema,
    system: buildChatExtractorSystem(args.legId, args.ctx),
    prompt: buildChatExtractorPrompt(args.legId, args.ctx),
    modelId: agentModelId(),
    temperature: 0,
    maxOutputTokens: args.maxOutputTokens,
    code: `${args.code}.extract`,
    sink: args.sink,
    fallback: args.fallback,
    signal: controller.signal,
    disableReasoning: true,
    lowLatencyRouting: true,
    repair: false,
    degradeSeverity: "warn",
  });

  const { value, degraded } = await withGenerateTimeout(work, controller, args.timeoutMs, `${args.code}.timeout`, args.sink);
  return { value: degraded ? null : value, degraded };
}

/**
 * The post-turn extraction (chat-agent-improvements.plan.md slice 1b — formerly the single
 * 13-field `runChatArchivist`): three focused legs over the same exchange, run in PARALLEL
 * with each other AND with the reaction pulse, all inside the post-flush finalizer — so the
 * split costs two extra small calls and NO perceived latency. Each leg carries 3–5
 * assignments on a sheet composed from the field library (`prompts/chat-extractors.ts`)
 * instead of thirteen on a hand-written monolith.
 *
 * Merged back into the one `ChatArchivist` aggregate (`mergeChatExtractions`), so every
 * downstream fold in `finalizeChatState` is untouched by the split.
 */
export async function runChatExtraction(input: ChatExtractionInput): Promise<ChatExtractionResult> {
  if (isDemoMode()) {
    input.sink?.push(diag("info", "chat_archivist.degraded", "demo mode; skipping chat memory extraction"));
    return { value: null, degraded: true, legs: { memory: true, continuity: true, character: true } };
  }

  const ctx: ChatExtractorContext = { ...input };
  const empty = degradedChatArchivist();

  const [memory, continuity, character] = await Promise.all([
    runExtractorLeg<ChatMemoryScribe>({
      legId: "memory",
      ctx,
      schema: chatMemoryScribeSchema,
      fallback: () => ({ episodeSummary: empty.episodeSummary, facts: empty.facts, memoryQueries: empty.memoryQueries }),
      maxOutputTokens: CHAT_MEMORY_SCRIBE_MAX_OUTPUT_TOKENS,
      timeoutMs: CHAT_EXTRACTOR_TIMEOUT_MS,
      code: "chat_memory_scribe",
      sink: input.sink,
    }),
    runExtractorLeg<ChatContinuity>({
      legId: "continuity",
      ctx,
      schema: chatContinuitySchema,
      fallback: () => ({
        scene: empty.scene,
        outfit: empty.outfit,
        attributeChanges: empty.attributeChanges,
        presence: empty.presence,
        cast: empty.cast,
      }),
      maxOutputTokens: CHAT_CONTINUITY_MAX_OUTPUT_TOKENS,
      timeoutMs: CHAT_EXTRACTOR_TIMEOUT_MS,
      code: "chat_continuity",
      sink: input.sink,
    }),
    runExtractorLeg<ChatCharacterNotes>({
      legId: "character",
      ctx,
      schema: chatCharacterNotesSchema,
      fallback: () => ({
        openLoops: empty.openLoops,
        driveUpdates: empty.driveUpdates,
        voiceExemplar: empty.voiceExemplar,
        characterSlip: empty.characterSlip,
        traitShifts: empty.traitShifts,
      }),
      maxOutputTokens: CHAT_CHARACTER_NOTES_MAX_OUTPUT_TOKENS,
      timeoutMs: CHAT_EXTRACTOR_TIMEOUT_MS,
      code: "chat_character_notes",
      sink: input.sink,
    }),
  ]);

  const legs = { memory: memory.degraded, continuity: continuity.degraded, character: character.degraded };
  const allDegraded = legs.memory && legs.continuity && legs.character;
  return {
    // Every leg down ⇒ null (the pre-split contract: no memory written, nothing folded).
    value: allDegraded
      ? null
      : mergeChatExtractions({ memory: memory.value, continuity: continuity.value, character: character.value }),
    degraded: allDegraded,
    legs,
  };
}

/**
 * The memory scribe ALONE, merged into the aggregate `writeChatMemory` consumes. The
 * edited-reply re-extraction (`reextractEditedReply`) re-files an edited exchange's
 * long-term memory and nothing else — no state row is rewritten, no scene/outfit/loops are
 * folded — so it pays for exactly the one leg whose output it uses. (Before the split it
 * re-ran all thirteen fields and discarded eleven of them.)
 */
export async function runChatMemoryScribe(input: ChatExtractionInput): Promise<{ value: ChatArchivist | null; degraded: boolean }> {
  if (isDemoMode()) {
    input.sink?.push(diag("info", "chat_archivist.degraded", "demo mode; skipping chat memory extraction"));
    return { value: null, degraded: true };
  }
  const empty = degradedChatArchivist();
  const { value, degraded } = await runExtractorLeg<ChatMemoryScribe>({
    legId: "memory",
    ctx: { ...input },
    schema: chatMemoryScribeSchema,
    fallback: () => ({ episodeSummary: empty.episodeSummary, facts: empty.facts, memoryQueries: empty.memoryQueries }),
    maxOutputTokens: CHAT_MEMORY_SCRIBE_MAX_OUTPUT_TOKENS,
    timeoutMs: CHAT_EXTRACTOR_TIMEOUT_MS,
    code: "chat_memory_scribe",
    sink: input.sink,
  });
  return {
    value: value ? mergeChatExtractions({ memory: value, continuity: null, character: null }) : null,
    degraded,
  };
}

export interface ChatPersonalNotesInput {
  characterName: string;
  playerName: string;
  exchange: { player: string; assistant: string };
  /** This member's standing open-loops list — re-emitted in full so resolved loops fall off. */
  openLoops?: readonly string[];
  /** This member's standing drives — the driveUpdates match targets. */
  drives?: readonly { want: string; secrecy: string; revealed: boolean }[];
  sink?: DiagnosticSink;
}

/**
 * Run one ensemble member's personal pass (multi-character-chat.followups.md ruling 10):
 * the four per-character fields the shared legs cover only for the primary — composed from
 * the SAME field library (slice 1a), so its instructions are no longer a second copy of the
 * shared ones. `null` on demo / timeout / parse failure, so the member keeps their prior
 * loops/outfit/drives. Cheap AGENT model.
 */
export async function runChatPersonalNotes(
  input: ChatPersonalNotesInput,
): Promise<{ value: ChatPersonalNotes | null; degraded: boolean }> {
  if (isDemoMode()) {
    input.sink?.push(diag("info", "chat_personal_notes.degraded", "demo mode; skipping member personal pass"));
    return { value: null, degraded: true };
  }

  return runExtractorLeg<ChatPersonalNotes>({
    legId: "personal",
    ctx: {
      characterName: input.characterName,
      playerName: input.playerName,
      exchange: input.exchange,
      openLoops: input.openLoops,
      drives: input.drives,
      personal: true,
    },
    schema: chatPersonalNotesSchema,
    fallback: degradedChatPersonalNotes,
    maxOutputTokens: CHAT_PERSONAL_NOTES_MAX_OUTPUT_TOKENS,
    timeoutMs: CHAT_PERSONAL_NOTES_TIMEOUT_MS,
    code: "chat_personal_notes",
    sink: input.sink,
  });
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
