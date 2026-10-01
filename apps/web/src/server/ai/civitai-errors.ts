export type CivitaiStage = "lora_metadata" | "preflight" | "submit" | "workflow_status" | "workflow_terminal" | "output_download";
export type CivitaiRetryDisposition = "automatic" | "deliberate" | "never" | "reconcile";

export type CivitaiCode = `civitai_http_${number}`
  | "civitai_async_blocked"
  | "civitai_async_no_provider_available"
  | "civitai_async_timeout"
  | "civitai_async_canceled"
  | "civitai_async_unknown_terminal"
  | "civitai_async_insufficient_buzz"
  | "civitai_malformed_response"
  | "civitai_output_unavailable"
  | "civitai_transport_failure"
  | `civitai_output_http_${number}`
  | "civitai_output_invalid"
  | "civitai_output_too_large"
  | "civitai_output_empty"
  | "civitai_output_transport_failure";

/**
 * A stable reason a provider validation refusal carries, retained in place of
 * the provider's own sentence.
 *
 * `resource_not_enabled`: Civitai refused a selected model version — a LoRA or
 * a checkpoint pin — because it is not enabled for generation (the
 * `canGenerate` flag on `GET /api/v1/model-versions/mini/{id}`). The provider
 * answers HTTP 400 with `errors.messages[]` naming the resource in prose, and
 * that prose is not retained; this token is what tells the operator the request
 * was well-formed and the resource itself is what the provider will not run.
 * Measured 2026-09-30 on every sampled Qwen Image 2.1 LoRA.
 */
export type CivitaiValidationReason = "resource_not_enabled";

export interface CivitaiFailure {
  code: CivitaiCode;
  retry: CivitaiRetryDisposition;
  stage: CivitaiStage;
  httpStatus?: number;
  validationPaths?: readonly string[];
  automaticRetriesExhausted?: boolean;
  /**
   * Whether this failure follows a preflight Vesper already reposted once
   * automatically (#672) — distinct from {@link automaticRetriesExhausted},
   * whose "read retries" wording belongs to the bounded GET retry only. When
   * the repeat fails the same transient way — another transport failure, or
   * another HTTP 429/5xx — the disposition stays `deliberate`: the one
   * automatic repeat is already spent, and nothing further happens on its
   * own. A repeat that fails a DIFFERENT way (a plain 4xx, or a 409) reports
   * that failure's own disposition (`never` or `reconcile`) instead, and this
   * flag has no effect on the message in that case — {@link messageFor} only
   * reads it in the `deliberate` branch.
   */
  automaticRetryUsed?: boolean;
  reason?: CivitaiValidationReason;
}

const VALIDATION_REASON_TEXT: Record<CivitaiValidationReason, string> = {
  resource_not_enabled:
    "Civitai has not enabled a selected resource for generation; choose a generation-enabled LoRA or model version.",
};

const DOCUMENTED_ASYNC_REASONS = new Set([
  "no_provider_available",
  "blocked",
  "timeout",
  "expired",
  "canceled",
  "cancelled",
]);

function messageFor(failure: CivitaiFailure): string {
  const reason = failure.reason ? ` reason=${failure.reason}: ${VALIDATION_REASON_TEXT[failure.reason]}` : "";
  const paths = failure.validationPaths?.length ? ` paths=${failure.validationPaths.join(",")}.` : "";
  const retry = failure.retry === "automatic"
    ? failure.automaticRetriesExhausted ? " Automatic read retries are exhausted; the provider is temporarily unavailable." : " The provider is temporarily unavailable; Vesper retries this read automatically."
    : failure.retry === "deliberate"
      ? failure.automaticRetryUsed
        ? " Vesper already reposted this preflight once automatically; that retry is spent, so start one deliberate replacement only after reviewing the request."
        : " Start one deliberate replacement only after reviewing the request."
      : failure.retry === "reconcile"
        ? " Refresh workflow status before deciding whether to replace it."
        : " Do not repeat this request with the same input.";
  return `Civitai ${failure.stage.replaceAll("_", " ")} failed (${failure.code}; retry=${failure.retry}).${reason}${paths}${retry}`;
}

/** Provider-facing failure with a closed, redacted code and retry disposition. */
export class CivitaiError extends Error implements CivitaiFailure {
  readonly code: CivitaiCode;
  readonly retry: CivitaiRetryDisposition;
  readonly stage: CivitaiStage;
  readonly httpStatus: number | undefined;
  readonly validationPaths: readonly string[] | undefined;
  readonly automaticRetriesExhausted: boolean | undefined;
  readonly automaticRetryUsed: boolean | undefined;
  readonly reason: CivitaiValidationReason | undefined;

  constructor(failure: CivitaiFailure) {
    super(messageFor(failure));
    this.name = "CivitaiError";
    this.code = failure.code;
    this.retry = failure.retry;
    this.stage = failure.stage;
    this.httpStatus = failure.httpStatus;
    this.validationPaths = failure.validationPaths;
    this.automaticRetriesExhausted = failure.automaticRetriesExhausted;
    this.automaticRetryUsed = failure.automaticRetryUsed;
    this.reason = failure.reason;
  }
}

/**
 * The HTTP status band Vesper's bounded GET retry and the preflight's single
 * automatic retry (#672) both cover: 429, or any 5xx. Exported so the retry
 * GATE in `requestJson` and the disposition {@link civitaiHttpFailure}
 * reports cannot drift apart from each other.
 */
export function civitaiRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}

export function civitaiHttpFailure(
  status: number,
  stage: CivitaiStage,
  readOnly = true,
  validationPaths: readonly string[] = [],
  automaticRetriesExhausted = false,
  reason?: CivitaiValidationReason,
  automaticRetryUsed = false,
): CivitaiError {
  const retry: CivitaiRetryDisposition = civitaiRetryableStatus(status)
    ? readOnly ? "automatic" : "deliberate"
    : status === 409
      ? "reconcile"
      : "never";
  const code = `civitai_http_${String(status)}` as `civitai_http_${number}`;
  return new CivitaiError({
    code, retry, stage, httpStatus: status, validationPaths, automaticRetriesExhausted, automaticRetryUsed,
    ...(reason === undefined ? {} : { reason }),
  });
}

export function civitaiTransportFailure(
  stage: Exclude<CivitaiStage, "output_download">,
  readOnly: boolean,
  automaticRetriesExhausted = false,
  automaticRetryUsed = false,
): CivitaiError {
  return new CivitaiError({
    code: "civitai_transport_failure",
    retry: readOnly ? "automatic" : "deliberate",
    stage,
    automaticRetriesExhausted,
    automaticRetryUsed,
  });
}

export function civitaiOutputFailure(
  code: Extract<CivitaiCode, `civitai_output_${string}`>,
  retry: CivitaiRetryDisposition,
): CivitaiError {
  return new CivitaiError({ code, retry, stage: "output_download" });
}

/** Accept only documented async reason tokens; provider prose is never surfaced. */
export function civitaiInsufficientBuzzFailure(): CivitaiError {
  const failure = new CivitaiError({ code: "civitai_async_insufficient_buzz", retry: "never", stage: "workflow_terminal" });
  failure.message += " Insufficient yellow Buzz prevents this workflow.";
  return failure;
}

export function civitaiAsyncFailure(
  status: string,
  reasons: readonly string[],
  blocked = false,
): CivitaiError {
  if (blocked || reasons.includes("blocked")) {
    return new CivitaiError({ code: "civitai_async_blocked", retry: "never", stage: "workflow_terminal" });
  }
  if (reasons.includes("no_provider_available")) {
    return new CivitaiError({ code: "civitai_async_no_provider_available", retry: "deliberate", stage: "workflow_terminal" });
  }
  if (reasons.includes("timeout") || reasons.includes("expired") || status === "expired") {
    return new CivitaiError({ code: "civitai_async_timeout", retry: "deliberate", stage: "workflow_terminal" });
  }
  if (reasons.includes("canceled") || reasons.includes("cancelled") || status === "canceled") {
    return new CivitaiError({ code: "civitai_async_canceled", retry: "deliberate", stage: "workflow_terminal" });
  }
  return new CivitaiError({ code: "civitai_async_unknown_terminal", retry: "deliberate", stage: "workflow_terminal" });
}

/** Keeps only the documented async reason vocabulary used by the retry contract. */
export function civitaiReasonCodes(value: unknown): string[] {
  if (typeof value === "string") {
    const code = value.trim();
    if (code === "") return [];
    return DOCUMENTED_ASYNC_REASONS.has(code) ? [code] : ["provider_error"];
  }
  if (Array.isArray(value)) return value.flatMap(civitaiReasonCodes).slice(0, 5);
  if (typeof value !== "object" || value === null) return [];
  const record = value as Record<string, unknown>;
  const code = record.code ?? record.reason ?? record.type;
  if (code !== undefined) return civitaiReasonCodes(code);
  return Object.keys(record).length > 0 ? ["provider_validation_error"] : [];
}


const VALIDATION_PATH = /^[a-z][a-z0-9_]{0,63}(?:(?:\.[a-z][a-z0-9_]{0,63})|(?:\[(?:0|[1-9]\d*)\]))*$/;

const RESOURCE_NOT_ENABLED = /is not enabled for generation/i;
const MAX_SCANNED_VALIDATION_MESSAGES = 20;

/**
 * The stable reason an RFC7807 validation body carries, read from its
 * `errors.messages[]` prose and returned as a token — never the prose itself,
 * which names the provider's resource and version in free text.
 */
export function civitaiValidationReason(value: unknown): CivitaiValidationReason | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const errors = (value as Record<string, unknown>).errors;
  if (typeof errors !== "object" || errors === null || Array.isArray(errors)) return undefined;
  const messages = (errors as Record<string, unknown>).messages;
  if (!Array.isArray(messages)) return undefined;
  return messages
    .slice(0, MAX_SCANNED_VALIDATION_MESSAGES)
    .some((message) => typeof message === "string" && RESOURCE_NOT_ENABLED.test(message))
    ? "resource_not_enabled"
    : undefined;
}

/** Retain field locations from RFC7807 errors maps, never their untrusted values. */
export function civitaiValidationPaths(value: unknown): string[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return [];
  const body = value as Record<string, unknown>;
  const errors = body.errors;
  if (typeof errors !== "object" || errors === null || Array.isArray(errors)) return [];
  return Object.keys(errors).filter((path) => VALIDATION_PATH.test(path)).slice(0, 5);
}

/** Bounded exponential backoff with +/- 50% jitter. */
export function civitaiGetRetryDelay(attempt: number, random: () => number = Math.random): number {
  const base = attempt === 0 ? 250 : 500;
  const jitter = Math.min(1, Math.max(0, random()));
  return Math.round(base * (0.5 + jitter));
}
