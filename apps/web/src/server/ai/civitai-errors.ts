export type CivitaiStage = "lora_metadata" | "preflight" | "submit" | "submit_lookup" | "workflow_status" | "workflow_terminal" | "output_download" | "output_recovery";
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
  | "civitai_output_transport_failure"
  /**
   * A workflow that succeeded and was already paid for, whose output could
   * not be downloaded after every retried attempt (#682) — distinct from
   * `civitai_output_invalid`/`_too_large`/an unretryable HTTP status, each of
   * which proves the output can never be fetched and throws on its first
   * occurrence instead. This is the OPPOSITE claim: the output is still
   * there, just not fetched yet, so it is recoverable from the same blob
   * (`recoverCivitaiOutput`) without rendering again. `messageFor` names only
   * the attempt count ({@link CivitaiFailure.downloadAttempts}) in its free
   * text; the blob id ({@link CivitaiFailure.outputId}) travels as structured
   * data only, since it is provider-supplied and a keyword classifier reads
   * free text, not fields (review P3-5).
   */
  | "civitai_output_undelivered"
  /**
   * The paid submit's own answer was lost (transport failure, an HTTP 5xx,
   * or a 2xx body that was not JSON or not a usable workflow) and a bounded
   * read-only lookup by its externalId, across the workflow list, did not
   * resolve it either — never found a match in any round whose read
   * actually succeeded, or every round's read itself failed (#673).
   * `messageFor` renders which of those applies, and whether the search was
   * incomplete, from {@link CivitaiFailure.roundsSearched},
   * {@link CivitaiFailure.roundsAttempted}, and
   * {@link CivitaiFailure.pageCapHit}.
   */
  | "civitai_submit_unconfirmed"
  /**
   * The paid submit answered 2xx with a JSON body, but that body did not
   * parse into a usable workflow identity/status (`parseCivitaiWorkflow`'s
   * own check) — distinct from `civitai_malformed_response`, which is a 2xx
   * body that was not JSON at all. Named only as the ORIGINAL failure inside
   * a `civitai_submit_unconfirmed` message; never thrown to a caller on its
   * own (#673).
   */
  | "civitai_submit_response_invalid";

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
  /** `civitai_submit_unconfirmed` only: the code of the submit failure the lookup was run to resolve. */
  originalCode?: CivitaiCode;
  /** `civitai_submit_unconfirmed` only: the submit's own externalId, so an operator can match it against the workflow list later (#673). */
  externalId?: string;
  /**
   * `civitai_submit_unconfirmed` only: how many lookup rounds' OWN READS
   * actually succeeded — never the configured round count when a round's
   * read itself failed (second correction round, #673). 0 means every round
   * was unreadable.
   */
  roundsSearched?: number;
  /** `civitai_submit_unconfirmed` only: how many rounds were configured to run, for comparison against `roundsSearched`. */
  roundsAttempted?: number;
  /** `civitai_submit_unconfirmed` only: true when some round that did read hit its page cap without a match, so the search may not have covered the whole list. */
  pageCapHit?: boolean;
  /**
   * `civitai_output_undelivered` only: the Civitai blob id whose download
   * could not complete, so an operator (or the read-only recovery primitive,
   * `recoverCivitaiOutput`) can recover the already-paid-for output directly
   * instead of rendering again. Carried as structured data ONLY — never
   * interpolated into `messageFor`'s free text, because this id is
   * provider-supplied and `classifyImageFailureMessage` reads that text by
   * keyword; an unlucky id could otherwise misclassify the failure as
   * billing or content rejection (review P3-5).
   */
  outputId?: string;
  /** `civitai_output_undelivered` only: how many download attempts were made before giving up. */
  downloadAttempts?: number;
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
  if (failure.code === "civitai_submit_unconfirmed") {
    const original = failure.originalCode ?? "unknown";
    const externalId = failure.externalId ?? "unknown";
    const searched = failure.roundsSearched ?? 0;
    const attempted = failure.roundsAttempted ?? searched;
    // Second correction round (#673): `searched` counts only rounds whose OWN
    // read succeeded, never the configured round count regardless of whether
    // every round could actually be read. When fewer rounds could be read
    // than were attempted, the wording says so rather than implying a full
    // search; when a round that WAS read hit its page cap without a match,
    // that is named too, since the list may hold more than this search saw.
    const outcome = searched === 0
      ? "the lookup itself could not be read"
      : `no workflow in the list carried this externalId after ${String(searched)} lookup round${searched === 1 ? "" : "s"}`
        + (searched < attempted ? " that could be read" : "")
        + (failure.pageCapHit ? " (the list was only searched up to its page cap)" : "");
    return `Civitai submit failed (civitai_submit_unconfirmed; retry=deliberate). The submit's own answer was lost as ${original}, and ${outcome}. Civitai may still accept, or may already have accepted, this workflow under externalId=${externalId} — check the workflow list for it before starting one deliberate replacement.`;
  }
  if (failure.code === "civitai_output_undelivered") {
    // The blob id is PROVIDER-SUPPLIED and therefore untrusted text: an id
    // that happened to contain a word like "flagged" or a bare "402" would
    // make `classifyImageFailureMessage` misread this as content rejection
    // or billing, and a sanitized retry would then pay for a second render
    // over an output that is still sitting there (review P3-5). The id
    // travels only as the structured `outputId` field (and the lane
    // result's `undeliveredOutputId`); it is never interpolated here.
    const attempts = failure.downloadAttempts ?? 0;
    const plural = attempts === 1 ? "" : "s";
    return `Civitai output download failed (civitai_output_undelivered; retry=reconcile). The workflow succeeded and was already paid for, but its output could not be downloaded after ${String(attempts)} attempt${plural}. It can be recovered from that output without rendering again.`;
  }
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
  readonly originalCode: CivitaiCode | undefined;
  readonly externalId: string | undefined;
  readonly roundsSearched: number | undefined;
  readonly roundsAttempted: number | undefined;
  readonly pageCapHit: boolean | undefined;
  readonly outputId: string | undefined;
  readonly downloadAttempts: number | undefined;

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
    this.originalCode = failure.originalCode;
    this.externalId = failure.externalId;
    this.roundsSearched = failure.roundsSearched;
    this.roundsAttempted = failure.roundsAttempted;
    this.pageCapHit = failure.pageCapHit;
    this.outputId = failure.outputId;
    this.downloadAttempts = failure.downloadAttempts;
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

/**
 * Whether `stage` is one where a workflow id is already established — the
 * render has already been billed, so no automatic disposition belongs here
 * even for an otherwise-retryable HTTP status or transport failure: a scene
 * rerun of this rung would be a second paid submit (#673, the "Related
 * double-spend path" issue comment on #673). `workflow_status` is the only
 * such stage `civitaiHttpFailure`/`civitaiTransportFailure` ever see today —
 * it exists solely to poll a workflow id `runCivitaiLane` already has.
 */
function isPostSubmitStage(stage: CivitaiStage): boolean {
  return stage === "workflow_status";
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
  const retryable = civitaiRetryableStatus(status);
  const retry: CivitaiRetryDisposition = retryable
    ? readOnly
      ? isPostSubmitStage(stage) ? "reconcile" : "automatic"
      : "deliberate"
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
  const automatic = readOnly && !isPostSubmitStage(stage);
  return new CivitaiError({
    code: "civitai_transport_failure",
    retry: automatic ? "automatic" : readOnly ? "reconcile" : "deliberate",
    stage,
    automaticRetriesExhausted,
    automaticRetryUsed,
  });
}

/**
 * The paid submit's own answer was lost, and the read-only externalId lookup
 * across the workflow list did not resolve it either (#673). `retry` is
 * always `deliberate`: Civitai may still accept or have already accepted the
 * workflow, so one deliberate replacement after review is the right next
 * step, never an automatic repeat of a paid POST.
 */
export function civitaiSubmitUnconfirmedFailure(
  originalCode: CivitaiCode,
  externalId: string,
  roundsSearched: number,
  roundsAttempted: number,
  pageCapHit = false,
): CivitaiError {
  return new CivitaiError({
    code: "civitai_submit_unconfirmed",
    retry: "deliberate",
    stage: "submit",
    originalCode,
    externalId,
    roundsSearched,
    roundsAttempted,
    pageCapHit,
  });
}

export function civitaiOutputFailure(
  code: Extract<CivitaiCode, `civitai_output_${string}`>,
  retry: CivitaiRetryDisposition,
  httpStatus?: number,
): CivitaiError {
  return new CivitaiError({ code, retry, stage: "output_download", ...(httpStatus === undefined ? {} : { httpStatus }) });
}

/**
 * A paid, succeeded workflow whose output could not be downloaded after
 * every retried attempt (#682) — never thrown for a download failure that
 * already proves the output is gone for good (`civitai_output_invalid`,
 * `_too_large`, a 404, or a 410), each of which keeps throwing its own code
 * on first occurrence instead; see the retry gate beside the download loop in
 * civitai-runtime.ts. `retry` is always `reconcile`: the render already
 * succeeded and was billed, so the right next step is recovering the SAME
 * output (`recoverCivitaiOutput`), never a fresh paid render.
 */
export function civitaiOutputUndeliveredFailure(outputId: string, downloadAttempts: number): CivitaiError {
  return new CivitaiError({
    code: "civitai_output_undelivered",
    retry: "reconcile",
    stage: "output_download",
    outputId,
    downloadAttempts,
  });
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

/**
 * Vesper's OWN poll deadline ran out on a workflow it had already submitted —
 * distinct from a timeout or expiry Civitai itself reports
 * ({@link civitaiAsyncFailure}, `retry=deliberate`, stage
 * `workflow_terminal`). Vesper only stopped watching: abandoning the poll
 * neither cancels nor refunds the workflow, which may still finish and bill
 * (one measured run succeeded 90 s after a 300 s local deadline). So the
 * disposition is `reconcile`, at stage `workflow_status`: refresh the
 * workflow before deciding whether to replace it, and never start a second
 * paid render on the assumption that the first is gone — a scene chain stops
 * here rather than paying for its next rung.
 */
export function civitaiPollDeadlineFailure(): CivitaiError {
  return new CivitaiError({ code: "civitai_async_timeout", retry: "reconcile", stage: "workflow_status" });
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
