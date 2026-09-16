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

export interface CivitaiFailure {
  code: CivitaiCode;
  retry: CivitaiRetryDisposition;
  stage: CivitaiStage;
  httpStatus?: number;
  validationPaths?: readonly string[];
  automaticRetriesExhausted?: boolean;
}

const DOCUMENTED_ASYNC_REASONS = new Set([
  "no_provider_available",
  "blocked",
  "timeout",
  "expired",
  "canceled",
  "cancelled",
]);

function messageFor(failure: CivitaiFailure): string {
  const paths = failure.validationPaths?.length ? ` paths=${failure.validationPaths.join(",")}.` : "";
  const retry = failure.retry === "automatic"
    ? failure.automaticRetriesExhausted ? " Automatic read retries are exhausted." : " Vesper retries this read automatically."
    : failure.retry === "deliberate"
      ? " Start one deliberate replacement only after reviewing the request."
      : failure.retry === "reconcile"
        ? " Refresh workflow status before deciding whether to replace it."
        : " Do not repeat this request with the same input.";
  return `Civitai ${failure.stage.replaceAll("_", " ")} failed (${failure.code}; retry=${failure.retry}).${paths}${retry}`;
}

/** Provider-facing failure with a closed, redacted code and retry disposition. */
export class CivitaiError extends Error implements CivitaiFailure {
  readonly code: CivitaiCode;
  readonly retry: CivitaiRetryDisposition;
  readonly stage: CivitaiStage;
  readonly httpStatus: number | undefined;
  readonly validationPaths: readonly string[] | undefined;
  readonly automaticRetriesExhausted: boolean | undefined;

  constructor(failure: CivitaiFailure) {
    super(messageFor(failure));
    this.name = "CivitaiError";
    this.code = failure.code;
    this.retry = failure.retry;
    this.stage = failure.stage;
    this.httpStatus = failure.httpStatus;
    this.validationPaths = failure.validationPaths;
    this.automaticRetriesExhausted = failure.automaticRetriesExhausted;
  }
}

export function civitaiHttpFailure(
  status: number,
  stage: CivitaiStage,
  readOnly = true,
  validationPaths: readonly string[] = [],
  automaticRetriesExhausted = false,
): CivitaiError {
  const retry: CivitaiRetryDisposition = (status === 429 || status >= 500 && status <= 599)
    ? readOnly ? "automatic" : "deliberate"
    : status === 409
      ? "reconcile"
      : "never";
  const code = `civitai_http_${String(status)}` as `civitai_http_${number}`;
  return new CivitaiError({ code, retry, stage, httpStatus: status, validationPaths, automaticRetriesExhausted });
}

export function civitaiTransportFailure(
  stage: Exclude<CivitaiStage, "output_download">,
  readOnly: boolean,
  automaticRetriesExhausted = false,
): CivitaiError {
  return new CivitaiError({
    code: "civitai_transport_failure",
    retry: readOnly ? "automatic" : "deliberate",
    stage,
    automaticRetriesExhausted,
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
  return new CivitaiError({ code: "civitai_async_insufficient_buzz", retry: "never", stage: "workflow_terminal" });
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
  if (reasons.includes("timeout") || status === "expired") {
    return new CivitaiError({ code: "civitai_async_timeout", retry: "deliberate", stage: "workflow_terminal" });
  }
  if (reasons.includes("canceled") || reasons.includes("cancelled") || status === "canceled") {
    return new CivitaiError({ code: "civitai_async_canceled", retry: "deliberate", stage: "workflow_terminal" });
  }
  return new CivitaiError({ code: "civitai_async_unknown_terminal", retry: "deliberate", stage: "workflow_terminal" });
}

/** Keeps only the documented async reason vocabulary used by the retry contract. */
export function civitaiReasonCodes(value: unknown): string[] {
  if (typeof value === "string") return DOCUMENTED_ASYNC_REASONS.has(value) ? [value] : ["provider_error"];
  if (Array.isArray(value)) return value.flatMap(civitaiReasonCodes).slice(0, 5);
  if (typeof value !== "object" || value === null) return [];
  const record = value as Record<string, unknown>;
  const code = record.code ?? record.reason ?? record.type;
  if (code !== undefined) return civitaiReasonCodes(code);
  return Object.keys(record).length > 0 ? ["provider_validation_error"] : [];
}


const VALIDATION_PATH = /^[a-z][a-z0-9_]{0,63}(?:(?:\.[a-z][a-z0-9_]{0,63})|(?:\[(?:0|[1-9]\d*)\]))*$/;

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
