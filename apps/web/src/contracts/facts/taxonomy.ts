import { z } from "zod";
import { parseOr } from "@/lib/parse";
import type { DiagnosticSink } from "../diagnostics";

/** Stable fact categories. Extend by adding to the array (docs/contracts/facts.md). */
export const factKindIds = [
  "relationship",
  "knowledge",
  "commitment",
  "attribute_revelation",
  "item",
  "location",
  "event",
  "preference",
  "secret",
] as const;

export const factKindSchema = z.enum(factKindIds);
export type FactKind = z.infer<typeof factKindSchema>;

/** Optional normalized verbs (aionchat-style second dimension, starter set). */
export const factVerbIds = [
  "promise",
  "threaten",
  "request",
  "refuse",
  "confess",
  "reveal_trait",
  "reveal_history",
  "show_affection",
  "show_trust",
  "show_fear",
  "show_anger",
  "reject_advance",
  "accept_advance",
  "acquire",
  "lose",
  "discover",
  "learn",
] as const;

export const factVerbSchema = z.enum(factVerbIds);
export type FactVerb = z.infer<typeof factVerbSchema>;

export const factSubjectKinds = ["character", "player", "location", "item", "world"] as const;
export const factSubjectKindSchema = z.enum(factSubjectKinds);
export type FactSubjectKind = z.infer<typeof factSubjectKindSchema>;

export const factStatusSchema = z.enum(["active", "superseded", "retracted"]);
export type FactStatus = z.infer<typeof factStatusSchema>;

/**
 * The channel a fact was established through (player-input-perception.plan.md slice 6 —
 * the RAG visibility fence). Forward-compatible TEXT vocabulary, NOT a pg enum
 * (forward-compatible-schema preference), so widening it is a data/prompt edit:
 *
 * - `perceived` — quoted speech / visible action the character actually saw or heard.
 *   Renders to the narrator as established knowledge ("treat as true").
 * - `private` — derived from the player's unspoken thoughts. NEVER reaches the narrator
 *   prompt (owner ruling 2026-07-09 — no intuition-grade framing); the pulse still reads it.
 * - `ooc` — from `((out-of-character))` direction. Generally not stored at all; if one is
 *   filed anyway it never enters the narrator's in-world memory.
 *
 * Degraded default `perceived` — an unknown/missing channel never blocks a write or a read
 * (docs/resilience.md); existing rows migrate to it. Mirrors `spanChannel`'s return in
 * `@/lib/message-spans` (the parser feeds this vocabulary).
 */
export const factChannelIds = ["perceived", "private", "ooc"] as const;
export const factChannelSchema = z.enum(factChannelIds);
export type FactChannel = z.infer<typeof factChannelSchema>;
export const DEFAULT_FACT_CHANNEL: FactChannel = "perceived";

/**
 * Trust-boundary parse for a fact channel (DB jsonb/text column, LLM draft). A present-but-
 * unknown value degrades to `perceived` with a `parse.boundary_failed` diagnostic at
 * `facts.channel`; an absent value (null / "" / undefined) is the ordinary un-classified
 * write (the session lane, existing rows) and degrades silently — no per-write noise.
 */
export function parseFactChannel(raw: unknown, sink?: DiagnosticSink, path = "facts.channel"): FactChannel {
  if (raw == null || raw === "") return DEFAULT_FACT_CHANNEL;
  return parseOr(factChannelSchema, raw, DEFAULT_FACT_CHANNEL, sink, path);
}

/**
 * The narrator's visibility fence (slice 6): only `perceived` facts may reach the narrator
 * prompt's "What you know" block. `private` (thought-derived) and `ooc` facts are excluded
 * from narrator-bound retrieval entirely (so they never eat the retrieval cap's slots) but
 * stay in the store for the pulse and the dev inspector. Exhaustive over every channel.
 */
export function factChannelReachesNarrator(channel: FactChannel): boolean {
  switch (channel) {
    case "perceived":
      return true;
    case "private":
    case "ooc":
      return false;
  }
}

/** The channels the narrator retrieval query may return (derived from the fence — one source of truth). */
export const NARRATOR_VISIBLE_FACT_CHANNELS = factChannelIds.filter(factChannelReachesNarrator);

export const factDraftSchema = z.object({
  kind: factKindSchema.catch("knowledge"),
  verb: factVerbSchema.optional().catch(undefined),
  subjectName: z.string().min(1),
  subjectKind: factSubjectKindSchema.catch("character"),
  text: z.string().min(1),
  tags: z
    .array(z.string().min(1))
    .default([])
    .transform((tags) => tags.map((t) => t.toLowerCase())),
  confidence: z.number().min(0).max(1).catch(0.5),
  /**
   * The channel the fact was established through (slice 6). Raw passthrough — kept even when
   * the model omits it or emits garbage, so a bad channel never drops the fact; validated to
   * the vocabulary (with a diagnostic on an unknown string) at the `addFacts` write boundary
   * via `parseFactChannel`. A non-string catches to undefined ⇒ the `perceived` default.
   */
  channel: z.string().optional().catch(undefined),
});

export type FactDraft = z.infer<typeof factDraftSchema>;
