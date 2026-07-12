import { z } from "zod";
import { factDraftSchema } from "../facts/taxonomy";
import { attributeChangeSchema } from "./agent-results";
import { CHAT_OUTFIT_MAX_CHARS } from "./chat-pulse";
import { DRIVES_MAX, driveUpdateSchema } from "../personality/drives";
import { chatSceneProposalSchema } from "./chat-scene-memory";

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
/** Cap on open loops (character-chat-standalone.spec.md §6.2) — a short list stays a pull, not a backlog. */
export const CHAT_ARCHIVIST_MAX_OPEN_LOOPS = 3;

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
  /**
   * The character's unfinished business (spec §6.2): the FULL list each exchange —
   * still-open items carried, resolved ones dropped, new ones added — so stale loops
   * fall off naturally without a separate resolution signal. Rendered as the
   * "Unfinished business" state line and read by "has something to say" (§8.4).
   */
  openLoops: z
    .array(z.string().trim().min(1))
    .catch([])
    .default([])
    .transform((loops) => loops.slice(0, CHAT_ARCHIVIST_MAX_OPEN_LOOPS)),
  /**
   * Optional scene reconciliation (chat scene memory): ONLY what the fiction actually
   * established this exchange — a current-place confirmation, a time-of-day hint, and new
   * place details/connections. Lenient (a bad proposal parses to an empty object and
   * merges as a no-op via `mergeSceneMemory`), so it never fails the turn.
   */
  scene: chatSceneProposalSchema,
  /**
   * Optional outfit change (chat-scene-fidelity.plan.md slice 1): what the character is
   * WEARING when this exchange changed it — they dressed, changed clothes, or removed
   * clothing (partly or fully). `description` is a FULL replacement of the tracked outfit
   * (the complete current look, never a delta); `exposed` = intimate areas are bared. An
   * empty description is the no-change no-op (the common case), so `{}` parses clean and
   * a bad proposal never fails the turn. Consumed by `finalizeChatState` into
   * `state.outfit`/`outfitExposed`, which drive the narrator's wearing-line and the scene
   * image's authoritative outfit override.
   */
  outfit: z
    .object({
      // Truncate, never reject: an overlong description must not degrade to "no change".
      description: z
        .string()
        .catch("")
        .default("")
        .transform((s) => s.trim().slice(0, CHAT_OUTFIT_MAX_CHARS)),
      exposed: z.boolean().catch(false).default(false),
    })
    .catch({ description: "", exposed: false })
    .default({ description: "", exposed: false }),
  /**
   * Drive updates (character-drives.plan.md): progress/reveal/resolution on the
   * character's EXISTING drives (matched by `want` text — unmatched entries drop).
   * `revealed` = the character spoke a secret drive aloud to the player THIS
   * exchange (the `secret_shared` milestone source). Lenient; [] = no movement.
   */
  driveUpdates: z
    .array(driveUpdateSchema)
    .catch([])
    .default([])
    .transform((u) => u.slice(0, DRIVES_MAX)),
  /**
   * Presence transitions the fiction actually played this exchange
   * (multi-character-chat.plan.md slice 3 — the archivist's confirming half of
   * activity tracking): a roster character who ENTERED the player's scene or
   * LEFT it, by name. Only emitted for multi-character conversations (the
   * prompt instruction renders only with a roster) and only for real
   * transitions — [] is the common no-change case. Lenient; unmatched names
   * drop at the fold.
   */
  presence: z
    .array(
      z.object({
        name: z.string().trim().min(1),
        presence: z.enum(["present", "away"]).catch("present"),
      }),
    )
    .catch([])
    .default([])
    .transform((entries) => entries.slice(0, 4)),
});

export type ChatArchivist = z.infer<typeof chatArchivistSchema>;

/** Degraded default: nothing extracted — the turn keeps its reply and the summary+window memory. */
export function degradedChatArchivist(): ChatArchivist {
  return {
    episodeSummary: "",
    facts: [],
    memoryQueries: [],
    attributeChanges: [],
    openLoops: [],
    scene: { places: [] },
    outfit: { description: "", exposed: false },
    driveUpdates: [],
    presence: [],
  };
}

/**
 * The per-member personal pass (multi-character-chat.followups.md ruling 10): in an
 * ensemble, the shared archivist keeps the scene-level reads (episode, facts, queries,
 * scene, presence) while each present member gets this small focused extraction — the
 * four PERSONAL fields folded into their own state row. Field shapes are the archivist's
 * exactly, so the folds are shared. The classic 1-on-1 never runs it (the combined call
 * already covers the primary).
 */
export const chatPersonalNotesSchema = z.object({
  openLoops: z
    .array(z.string().trim().min(1))
    .catch([])
    .default([])
    .transform((loops) => loops.slice(0, CHAT_ARCHIVIST_MAX_OPEN_LOOPS)),
  attributeChanges: z.array(attributeChangeSchema).catch([]).default([]),
  outfit: z
    .object({
      description: z
        .string()
        .catch("")
        .default("")
        .transform((s) => s.trim().slice(0, CHAT_OUTFIT_MAX_CHARS)),
      exposed: z.boolean().catch(false).default(false),
    })
    .catch({ description: "", exposed: false })
    .default({ description: "", exposed: false }),
  driveUpdates: z
    .array(driveUpdateSchema)
    .catch([])
    .default([])
    .transform((u) => u.slice(0, DRIVES_MAX)),
});

export type ChatPersonalNotes = z.infer<typeof chatPersonalNotesSchema>;

/** Degraded default: nothing personal extracted — the member keeps their prior fields. */
export function degradedChatPersonalNotes(): ChatPersonalNotes {
  return {
    openLoops: [],
    attributeChanges: [],
    outfit: { description: "", exposed: false },
    driveUpdates: [],
  };
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
  /**
   * Per-hit retrieval detail (spec §6.3 #2 — per-source attribution): what each
   * retrieved fact/episode scored and WHICH queries surfaced it (RRF fusion inputs).
   * Old rows without it parse to [] (texts-only trace stays readable).
   */
  retrievedDetail: z
    .array(
      z.object({
        kind: z.enum(["fact", "episode"]).catch("fact"),
        id: z.string().catch(""),
        text: z.string().catch(""),
        score: z.number().catch(0),
        pinned: z.boolean().catch(false),
        sources: z.array(z.string()).catch([]),
      }),
    )
    .catch([])
    .default([]),
  /** True when the archivist leg degraded (demo / timeout / parse) — no memory written. */
  degraded: z.boolean().catch(false).default(false),
});

export type ChatMemoryTrace = z.infer<typeof chatMemoryTraceSchema>;

/** One retrieved-hit detail row (spec §6.3 #2 per-source attribution). */
export type RetrievedMemoryDetail = ChatMemoryTrace["retrievedDetail"][number];

export function emptyChatMemoryTrace(): ChatMemoryTrace {
  return chatMemoryTraceSchema.parse({});
}
