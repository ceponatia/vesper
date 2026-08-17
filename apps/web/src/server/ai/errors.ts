import { APICallError, RetryError } from "ai";
import type { ChatReplyFailureCode } from "@/contracts";

/**
 * A human-meaningful message for an image/text generation failure.
 *
 * The OpenRouter provider throws a generic `APICallError("Invalid JSON
 * response")` when an upstream provider rejects a request AFTER OpenRouter has
 * already committed an HTTP 200: image generation is slow, so OpenRouter sends
 * whitespace keep-alive padding with the 200 status, and a late
 * moderation/error verdict can then only arrive in the body — which has no
 * `choices`/`model`, so the success-schema parse fails and the real reason is
 * lost behind "Invalid JSON response". The actual cause (e.g. a BFL Flux
 * "Sexual Content" moderation block) lives in `responseBody`; this digs it out
 * so a failed image row — or a failed narrator reply — records WHY. Falls back
 * to the plain error message for anything that isn't a provider APICallError.
 */
export function describeProviderError(err: unknown): string {
  if (!APICallError.isInstance(err)) {
    if (err instanceof Error) return err.message;
    // A provider error envelope reported IN-STREAM rather than thrown — see
    // `streamErrorEnvelope`. `String(err)` on one of these is "[object Object]".
    const envelope = streamErrorEnvelope(err);
    if (envelope) return envelope.code ? `${envelope.message} (${envelope.code})` : envelope.message;
    return String(err);
  }
  return providerErrorMessage(err.responseBody) ?? err.message;
}

/**
 * A provider error object the AI SDK reported through the STREAM instead of throwing.
 *
 * When an upstream answers HTTP 200 and then puts `{"error": {...}}` in an SSE frame —
 * which is what a Featherless cold start does, observed live 2026-08-17 — the
 * openai-compatible transport enqueues an error part carrying that raw JSON object
 * verbatim. It is a plain record, not an `APICallError`: there is no status code, no
 * response body, and it is not even an `Error`. Read as one, it degrades to the string
 * "[object Object]" and the class `unknown`, which is how a warming model came to be
 * indistinguishable from a silent one.
 *
 * Recognized only when the record actually looks like a provider envelope (a string
 * `message` or `code`), so an unrelated object thrown from Vesper's own code still
 * classifies as `unknown` rather than being dressed up as an upstream failure.
 */
function streamErrorEnvelope(err: unknown): { message: string; code: string } | null {
  if (err instanceof Error || !isRecord(err)) return null;
  // Some upstreams nest it one level (`{error: {...}}`), others send the inner object.
  const inner = isRecord(err.error) ? err.error : err;
  const message = typeof inner.message === "string" ? inner.message : "";
  const code = typeof inner.code === "string" ? inner.code : "";
  if (!message && !code) return null;
  return { message: message || code, code };
}

/**
 * Classify a generation failure into the closed ChatReplyFailureCode vocabulary
 * (contracts/turns/chat-reply-failure.ts), keeping the provider's own words as
 * `detail`. Reads `APICallError.statusCode` + `responseBody` (the OpenRouter
 * error envelope) — the fidelity a bare `error.message` log line drops — and
 * unwraps the AI SDK's RetryError to the last real attempt first. Moderation
 * and context-length are text-matched before the status fallbacks because
 * OpenRouter reports both under generic 4xx codes.
 */
export function classifyProviderError(err: unknown): {
  code: ChatReplyFailureCode;
  detail: string;
  status?: number;
} {
  const cause = RetryError.isInstance(err) ? err.lastError : err;
  const detail = describeProviderError(cause);
  if (APICallError.isInstance(cause)) {
    const status = cause.statusCode ?? 0;
    const text = `${detail} ${cause.responseBody ?? ""}`;
    if (MODERATION_TEXT.test(text)) return { code: "moderation_blocked", detail, status };
    if (status === 402) return { code: "no_credits", detail, status };
    if (status === 401 || status === 403) return { code: "auth_failed", detail, status };
    if (status === 408) return { code: "timeout", detail, status };
    if (status === 429) return { code: "rate_limited", detail, status };
    if (CONTEXT_TEXT.test(text)) return { code: "context_too_long", detail, status };
    if (status >= 400) return { code: "provider_error", detail, status };
    return { code: "unknown", detail, status };
  }
  if (isNetworkError(cause)) return { code: "network", detail };
  // An in-stream provider envelope: no HTTP status to fall back on, so the vendor's own
  // words are all there is. It is still definitively an UPSTREAM failure — reporting it
  // as `unknown` sends the player honest-but-useless "no cause recorded" copy for a
  // failure the provider explained.
  const envelope = streamErrorEnvelope(cause);
  if (envelope) {
    const text = `${envelope.message} ${envelope.code}`;
    if (MODERATION_TEXT.test(text)) return { code: "moderation_blocked", detail };
    if (CONTEXT_TEXT.test(text)) return { code: "context_too_long", detail };
    return { code: "provider_error", detail };
  }
  return { code: "unknown", detail };
}

/** OpenRouter/upstream moderation verdicts — reported as 403 (input flagged) or a 4xx with metadata. */
const MODERATION_TEXT = /moderat|flagged|content.?policy/i;
/** Context-window overflow phrasings across providers ("maximum context length", "token limit", …). */
const CONTEXT_TEXT = /context.{0,10}(length|window)|maximum context|token limit|too many tokens/i;

/** A transport-level failure (fetch/socket/DNS) — the request never got a provider verdict. */
function isNetworkError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const text = `${err.name} ${err.message} ${err.cause instanceof Error ? `${err.cause.name} ${err.cause.message}` : ""}`;
  return /fetch failed|network|socket|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|UND_ERR/i.test(text);
}

function providerErrorMessage(responseBody: string | undefined): string | null {
  if (!responseBody) return null;
  const parsed = safeJson(responseBody);
  // OpenRouter wraps provider failures as { error: { message, code, metadata } }.
  const error = isRecord(parsed) && isRecord(parsed.error) ? parsed.error : parsed;
  if (!isRecord(error)) return null;
  const message = typeof error.message === "string" ? error.message : null;
  const reasons = moderationReasons(error);
  if (message && reasons) return `${message}: ${reasons}`;
  return message ?? reasons;
}

/** Pull upstream moderation reasons out of OpenRouter's nested metadata. */
function moderationReasons(error: Record<string, unknown>): string | null {
  const metadata = isRecord(error.metadata) ? error.metadata : undefined;
  if (!metadata) return null;
  // OpenRouter nests the raw upstream response as a JSON string in metadata.raw.
  const raw = typeof metadata.raw === "string" ? safeJson(metadata.raw) : metadata.raw;
  const details = isRecord(raw) ? raw.details : undefined;
  const list = isRecord(details) ? details["Moderation Reasons"] : undefined;
  if (!Array.isArray(list)) return null;
  const reasons = list.filter((value): value is string => typeof value === "string");
  return reasons.length > 0 ? reasons.join(", ") : null;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
