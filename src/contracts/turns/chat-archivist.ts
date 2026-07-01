import { z } from "zod";
import { factDraftSchema } from "../facts/taxonomy";
import { attributeChangeSchema } from "./agent-results";

/**
 * The character-chat archivist-lite (character-chat-primary.spec.md §2): one small
 * structured agent call after a chat reply settles, run in PARALLEL with the reaction
 * pulse (D2). Where the pulse tracks disposition (playerAct + mindNote), the archivist
 * condenses the exchange into long-term memory — the RAG half chat previously lacked:
 *
 * - "episodeSummary": a 1–3 sentence past-tense summary of what just happened, embedded
 *   and recalled by similarity across the summary horizon (mirrors the session archivist).
 * - "facts": durable `FactDraft[]` (declarative knowledge about the character / player /
 *   relationship), inserted through the standard `addFacts` supersedence path.
 * - "memoryQueries": 0–3 short retrieval queries anticipating what the NEXT turn should
 *   recall (mirrors the session director's `memoryQueries`); persisted on the chat state
 *   and consumed at the next prompt build.
 * - "attributeChanges": rare LASTING physical changes (a haircut, a dye job, a new tattoo)
 *   in the shared simulant shape (§3, D3), applied through the inherent-trait guard. Folded
 *   into this leg rather than a separate proposer call — attribute changes are rare and the
 *   archivist already extracts durable change (spec §2 "fewest model calls").
 *
 * Fully `.default()`/`.catch()`ed so a parsed-empty object IS the degraded fallback
 * (docs/resilience.md §3) — a failed extraction degrades to the summary+window path with
 * a diagnostic, never a failed reply.
 */

/** Cap on facts extracted per exchange (a chat turn is small; keep the write cheap). */
export const CHAT_ARCHIVIST_MAX_FACTS = 6;
/** Cap on memory queries carried to the next turn. */
export const CHAT_ARCHIVIST_MAX_QUERIES = 3;

export const chatArchivistSchema = z.object({
  episodeSummary: z.string().catch("").default(""),
  facts: z
    .array(factDraftSchema)
    .catch([])
    .default([])
    .transform((facts) => facts.slice(0, CHAT_ARCHIVIST_MAX_FACTS)),
  memoryQueries: z
    .array(z.string().trim().min(1))
    .catch([])
    .default([])
    .transform((queries) => queries.slice(0, CHAT_ARCHIVIST_MAX_QUERIES)),
  attributeChanges: z.array(attributeChangeSchema).catch([]).default([]),
});

export type ChatArchivist = z.infer<typeof chatArchivistSchema>;

/** Degraded default: nothing extracted — the turn keeps its reply and the summary+window memory. */
export function degradedChatArchivist(): ChatArchivist {
  return { episodeSummary: "", facts: [], memoryQueries: [], attributeChanges: [] };
}

/**
 * Last-turn memory debug trace persisted beside the chat state for the dev inspector
 * (character-chat-primary.spec.md §5): what RAG retrieved this turn (facts + episodes) and
 * what the archivist extracted (episode summary, fact count, queries, attribute changes).
 * Parsed defensively from the jsonb column, `.default()`ed so an old/empty row reads clean.
 */
export const chatMemoryTraceSchema = z.object({
  /** Fact texts injected into the prompt this turn. */
  retrievedFacts: z.array(z.string()).catch([]).default([]),
  /** Episode summaries recalled this turn. */
  retrievedEpisodes: z.array(z.string()).catch([]).default([]),
  /** The episode summary the archivist wrote (""=nothing memorable / degraded). */
  episodeSummary: z.string().catch("").default(""),
  /** How many durable facts were added this turn. */
  factsAdded: z.number().int().catch(0).default(0),
  /** Queries carried to the next turn's recall. */
  memoryQueries: z.array(z.string()).catch([]).default([]),
  /** Applied attribute overlays this turn, rendered "id=value". */
  attributeChanges: z.array(z.string()).catch([]).default([]),
  /** True when the archivist leg degraded (demo / timeout / parse) — no memory written. */
  degraded: z.boolean().catch(false).default(false),
});

export type ChatMemoryTrace = z.infer<typeof chatMemoryTraceSchema>;

export function emptyChatMemoryTrace(): ChatMemoryTrace {
  return chatMemoryTraceSchema.parse({});
}
