import { z } from "zod";

/**
 * Why the last chat exchange produced NO reply (docs/character-chat/pipeline.md
 * §Reply failures). Persisted on `character_chats.last_reply_failure` when an
 * exchange ends with zero streamed text, cleared by the next exchange that
 * settles — the client reads it back on its post-exchange transcript refetch
 * and shows cause-specific copy instead of guessing at the reason.
 *
 * The vocabulary is a closed registry (the extension point): a new failure
 * class is a new literal here plus a copy entry in the client map — never a
 * schema migration. An unrecognized stored code parses to "unknown".
 */
export const chatReplyFailureCodes = [
  /** The server-side watchdog aborted a silent stream (no first token in time). */
  "timeout",
  /** 429 — the provider or account is being rate-limited right now. */
  "rate_limited",
  /** 402 — the provider account is out of credits. */
  "no_credits",
  /** 401 / plain 403 — the API key was rejected. */
  "auth_failed",
  /** The provider refused to generate this reply (content moderation). */
  "moderation_blocked",
  /** The conversation no longer fits the model's context window. */
  "context_too_long",
  /** An upstream 4xx/5xx provider failure with no more specific class. */
  "provider_error",
  /** A socket/DNS/fetch-level failure before any provider verdict. */
  "network",
  /** A clean stream that carried zero tokens — no error, just nothing. */
  "empty_reply",
  "unknown",
] as const;

export type ChatReplyFailureCode = (typeof chatReplyFailureCodes)[number];

/**
 * A refinement of `empty_reply`, for the cases where the server knows WHY no text
 * arrived (`server/ai/narrator-completion.ts` reads it off the generation's own
 * finish metadata). Separate from the code vocabulary above rather than four more
 * literals in it, because the distinction changes only the copy shown for one
 * class — every reader that branches on `code` keeps working, and a record written
 * before this field existed simply carries no cause.
 *
 * - `model_silent` — a clean stop with nothing generated. The one case where
 *   "it finished without saying anything" is literally true.
 * - `reasoning_spent` — the provider REPORTED reasoning tokens and no prose. The
 *   only cause allowed to blame a thinking chain, because it is the only one a
 *   measured reasoning count backs.
 * - `length_capped` — the generation hit the length cap with no prose, and the
 *   provider attributed no tokens to reasoning.
 * - `hidden_output` — the provider billed output tokens that never arrived as
 *   text, on a clean finish, with no reasoning split reported.
 * - `normalizer_erased` — the model DID write prose and Vesper's own output
 *   normalizers discarded all of it. This one is not the model's fault.
 *
 * The middle three were ONE cause (`reasoning_or_length`) whose copy asserted a
 * reasoning chain in all three cases. That is false wherever thinking is off: the
 * Featherless narrators send `enable_thinking: false` and report no
 * `completion_tokens_details` at all, so a burned budget there can never be
 * evidence of reasoning. A cause may only name a mechanism the generation
 * metadata actually measured.
 */
export const chatReplyFailureCauses = [
  "model_silent",
  "reasoning_spent",
  "length_capped",
  "hidden_output",
  "normalizer_erased",
] as const;

export type ChatReplyFailureCause = (typeof chatReplyFailureCauses)[number];

export const chatReplyFailureSchema = z.object({
  code: z.enum(chatReplyFailureCodes).catch("unknown"),
  /** What the provider actually said (classifyProviderError) — the popup's fine print. */
  detail: z.string().catch(""),
  /**
   * Why an `empty_reply` was empty, when the generation metadata said. Absent
   * otherwise — including for a row written under a retired cause name, which
   * catches to undefined and falls back to the unrefined `empty_reply` copy
   * rather than to a stale explanation.
   */
  cause: z.enum(chatReplyFailureCauses).optional().catch(undefined),
  /** The narrator model the failed exchange ran, so the popup can name it. */
  model: z.string().catch(""),
  /** ISO timestamp of the failure — readers treat an old record as stale. */
  at: z.string().catch(""),
});

export type ChatReplyFailure = z.infer<typeof chatReplyFailureSchema>;
