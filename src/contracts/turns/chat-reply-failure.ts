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

export const chatReplyFailureSchema = z.object({
  code: z.enum(chatReplyFailureCodes).catch("unknown"),
  /** What the provider actually said (classifyProviderError) — the popup's fine print. */
  detail: z.string().catch(""),
  /** The narrator model the failed exchange ran, so the popup can name it. */
  model: z.string().catch(""),
  /** ISO timestamp of the failure — readers treat an old record as stale. */
  at: z.string().catch(""),
});

export type ChatReplyFailure = z.infer<typeof chatReplyFailureSchema>;
