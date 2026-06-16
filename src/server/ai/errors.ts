import { APICallError } from "ai";

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
 * so a failed image row records WHY. Falls back to the plain error message for
 * anything that isn't a provider APICallError.
 */
export function describeImageGenError(err: unknown): string {
  if (!APICallError.isInstance(err)) {
    return err instanceof Error ? err.message : String(err);
  }
  return providerErrorMessage(err.responseBody) ?? err.message;
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
