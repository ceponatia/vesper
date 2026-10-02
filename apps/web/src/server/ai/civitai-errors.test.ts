import { describe, expect, it } from "vitest";
import { classifyImageFailureMessage, declaresNonAutomaticRetry, isBillingFailureMessage } from "@vesper/image-core";
import { civitaiAsyncFailure, civitaiGetRetryDelay, civitaiHttpFailure, civitaiInsufficientBuzzFailure, civitaiOutputFailure, civitaiOutputUndeliveredFailure, civitaiSubmitUnconfirmedFailure, civitaiTransportFailure, civitaiReasonCodes, civitaiValidationPaths, civitaiValidationReason } from "./civitai-errors";

describe("Civitai error contract", () => {
  it("classifies HTTP failures without provider response text", () => {
    // `lora_metadata` here, not `workflow_status`: this table is pinning the
    // STATUS-code mapping in general, and `workflow_status` is the one stage
    // (#673) whose retryable statuses now override to `reconcile` instead of
    // `automatic` — covered on its own below, not conflated with this table.
    const failures = [
      [400, "never"], [401, "never"], [402, "never"], [403, "never"], [404, "never"],
      [409, "reconcile"], [429, "automatic"], [503, "automatic"],
    ] as const;

    for (const [status, retry] of failures) {
      expect(civitaiHttpFailure(status, "lora_metadata")).toMatchObject({
        code: `civitai_http_${String(status)}`, retry, stage: "lora_metadata", httpStatus: status,
      });
    }
    expect(civitaiHttpFailure(503, "submit", false)).toMatchObject({
      code: "civitai_http_503", retry: "deliberate", stage: "submit",
    });
  });

  it("classifies transport and output boundaries without response text", () => {
    // lora_metadata is a PRE-spend GET: no paid workflow exists yet, so an
    // exhausted automatic retry here is legitimately transient. (#673:
    // workflow_status is the post-submit GET, and gets its own test below —
    // it must never report `automatic`.)
    expect(civitaiTransportFailure("lora_metadata", true, true)).toMatchObject({
      code: "civitai_transport_failure", retry: "automatic", automaticRetriesExhausted: true,
    });
    expect(classifyImageFailureMessage(civitaiHttpFailure(503, "lora_metadata", true, [], true).message)).toBe("transient");
    expect(civitaiTransportFailure("submit", false)).toMatchObject({
      code: "civitai_transport_failure", retry: "deliberate",
    });
    expect(civitaiOutputFailure("civitai_output_http_503", "deliberate")).toMatchObject({
      code: "civitai_output_http_503", retry: "deliberate", stage: "output_download",
    });
  });

  /**
   * PROTECTS (#673, the "Related double-spend path" issue comment): a
   * workflow-status read only ever runs after a paid submit already exists,
   * so an exhausted read here must never report `retry=automatic` — that
   * disposition, worded "temporarily unavailable", is exactly what let
   * `classifyImageFailureMessage` call this failure `transient` and let
   * `executeSceneChain` rerun the rung, submitting a SECOND paid workflow
   * while the first — already billed — might still finish untracked.
   * `reconcile` reuses the existing "Refresh workflow status before
   * deciding whether to replace it." wording instead.
   */
  it("reports a post-submit workflow-status failure as reconcile, never automatic, so it never reads as transient", () => {
    expect(civitaiTransportFailure("workflow_status", true, true)).toMatchObject({
      code: "civitai_transport_failure", retry: "reconcile",
    });
    const http = civitaiHttpFailure(503, "workflow_status", true, [], true);
    expect(http).toMatchObject({ code: "civitai_http_503", retry: "reconcile" });
    expect(http.message).toContain("retry=reconcile");
    expect(http.message).toContain("Refresh workflow status before deciding whether to replace it.");
    expect(http.message).not.toContain("temporarily");
    expect(classifyImageFailureMessage(http.message)).toBe("other");
    expect(classifyImageFailureMessage(civitaiTransportFailure("workflow_status", true, true).message)).toBe("other");

    // A 429, not just a 5xx, must get the same reconcile override.
    expect(civitaiHttpFailure(429, "workflow_status", true, [], true).retry).toBe("reconcile");
  });

  /**
   * PROTECTS (#672): once the preflight's own single automatic retry is
   * spent, the disposition stays `deliberate` — never `automatic`, which
   * would promise a retry that will not happen — and the message tells the
   * operator a retry already ran rather than reusing the GET-retry wording,
   * which names "read retries" and would misdescribe a POST.
   */
  it("marks a preflight failure that already used its one automatic retry as deliberate, not automatic", () => {
    const transport = civitaiTransportFailure("preflight", false, true, true);
    expect(transport).toMatchObject({
      code: "civitai_transport_failure", retry: "deliberate", stage: "preflight", automaticRetryUsed: true,
    });
    expect(transport.message).toContain("already reposted this preflight once automatically");
    expect(transport.message).not.toContain("read retries");

    const http = civitaiHttpFailure(503, "preflight", false, [], true, undefined, true);
    expect(http).toMatchObject({ code: "civitai_http_503", retry: "deliberate", automaticRetryUsed: true });
    expect(http.message).toContain("already reposted this preflight once automatically");

    // A first-attempt preflight failure (no retry used yet) keeps the
    // unmodified deliberate wording.
    expect(civitaiHttpFailure(400, "preflight", false).message).not.toContain("already reposted");
  });

  /**
   * PROTECTS (#672, PR #675 review): a spent preflight retry must not read as
   * transient to the scene chain. `executeSceneChain` (scene.ts) reruns the
   * same rung once when `runSceneProvider` classifies a failure as
   * `transient`. That rerun would start a fresh preflight pair — four POSTs
   * and up to ~8 minutes on one rung — for a failure whose disposition
   * already says the next replacement is deliberate. The message reaches the
   * classifier verbatim (runCivitaiLane returns `error.message`), so the
   * contract is pinned on the message itself: a wording change that added
   * "temporarily", "timeout" or a bare status code would fail here.
   */
  it("keeps a spent-retry preflight failure non-transient, so the scene chain falls back instead of rerunning the rung", () => {
    expect(classifyImageFailureMessage(civitaiTransportFailure("preflight", false, true, true).message)).toBe("other");
    for (const status of [429, 500, 502, 503, 504]) {
      expect(classifyImageFailureMessage(civitaiHttpFailure(status, "preflight", false, [], true, undefined, true).message)).toBe("other");
    }
  });

  it("uses documented job reasons and an explicit terminal fallback", () => {
    expect(civitaiAsyncFailure("failed", ["no_provider_available"])).toMatchObject({
      code: "civitai_async_no_provider_available", retry: "deliberate",
    });
    expect(civitaiAsyncFailure("failed", ["blocked"])).toMatchObject({
      code: "civitai_async_blocked", retry: "never",
    });
    const insufficient = civitaiInsufficientBuzzFailure();
    expect(insufficient).toMatchObject({ code: "civitai_async_insufficient_buzz", retry: "never" });
    expect(insufficient.message).toContain("Insufficient yellow Buzz");
    expect(civitaiAsyncFailure("failed", ["expired"])).toMatchObject({
      code: "civitai_async_timeout", retry: "deliberate",
    });
    expect(civitaiAsyncFailure("expired", [])).toMatchObject({
      code: "civitai_async_timeout", retry: "deliberate",
    });
    expect(civitaiAsyncFailure("canceled", [])).toMatchObject({
      code: "civitai_async_canceled", retry: "deliberate",
    });
    const unknown = civitaiAsyncFailure("failed", []);
    expect(unknown).toMatchObject({ code: "civitai_async_unknown_terminal", retry: "deliberate" });
    expect(unknown.message).toContain("retry=deliberate");
  });

  it("retains only safe RFC7807 validation paths and uses bounded jitter", () => {
    // lora_metadata, not workflow_status: this is a pre-submit GET, so the
    // ordinary `automatic` wording applies — see the dedicated
    // workflow_status/reconcile tests above and below for #673's override.
    const failure = civitaiHttpFailure(429, "lora_metadata", true, civitaiValidationPaths({
      title: "secret title", detail: "prompt=private", errors: {
        "steps[0].input.resolution": ["token=secret"], "not a path": ["private"],
      },
    }), true);

    expect(failure.validationPaths).toEqual(["steps[0].input.resolution"]);
    expect(failure.message).toContain("paths=steps[0].input.resolution");
    expect(failure.message).not.toContain("secret");
    expect(failure.message).toContain("Automatic read retries are exhausted");
    expect(civitaiGetRetryDelay(0, () => 0)).toBe(125);
    expect(civitaiGetRetryDelay(1, () => 1)).toBe(750);
  });

  it("redacts arbitrary provider text, prompts, and signed URLs", () => {
    const secret = "prompt=private signed=https://image.civitai.com/a?token=secret";
    const reasons = civitaiReasonCodes([{ reason: secret }, { reason: "no_provider_available" }]);

    expect(reasons).toEqual(["provider_error", "no_provider_available"]);
    expect(civitaiReasonCodes([" ", "\n"])).toEqual([]);
    expect(JSON.stringify(reasons)).not.toContain("secret");
    expect(JSON.stringify(reasons)).not.toContain("prompt=");
  });

  /**
   * PROTECTS: a resource Civitai has not enabled for generation (every Qwen
   * Image 2.1 LoRA on 2026-09-30) surfaces as a stable reason token on the
   * `civitai_http_400`, so an operator learns WHY the request was refused while
   * the provider's sentence — which names the resource — is still never kept.
   */
  it("retains resource_not_enabled from a 400 validation body without its prose", () => {
    const body = {
      title: "One or more validation errors occurred.",
      errors: {
        messages: [
          "Private Test LoRA - v1.0 is not enabled for generation. Please contact support@civitai.com if you believe this to be an error.",
        ],
      },
    };

    expect(civitaiValidationReason(body)).toBe("resource_not_enabled");
    const failure = civitaiHttpFailure(400, "preflight", false, civitaiValidationPaths(body), false, civitaiValidationReason(body));
    expect(failure).toMatchObject({
      code: "civitai_http_400", retry: "never", stage: "preflight", reason: "resource_not_enabled",
    });
    expect(failure.message).toContain("reason=resource_not_enabled");
    expect(failure.message).toContain("paths=messages");
    expect(failure.message).not.toContain("Private Test LoRA");
    expect(failure.message).not.toContain("support@civitai.com");
    // Not a moderation verdict and not worth an automatic retry.
    expect(classifyImageFailureMessage(failure.message)).toBe("other");

    // Only the documented sentence earns the token, and only from a list.
    expect(civitaiValidationReason({ errors: { messages: ["prompt must not exceed 10000 characters"] } })).toBeUndefined();
    expect(civitaiValidationReason({ errors: { messages: "X is not enabled for generation" } })).toBeUndefined();
    expect(civitaiValidationReason({ detail: "X is not enabled for generation" })).toBeUndefined();
    expect(civitaiValidationReason(null)).toBeUndefined();
    expect(civitaiHttpFailure(400, "preflight", false).reason).toBeUndefined();
  });

  /**
   * PROTECTS (#673): `civitai_submit_unconfirmed` names the ORIGINAL submit
   * failure's code and the submit's own externalId (never pasted into prose
   * ad hoc — both are fields on the failure, rendered centrally by
   * `messageFor`), and distinguishes a lookup that read cleanly and found no
   * match from a lookup whose reads themselves failed. It is always
   * `retry=deliberate`: Civitai may still accept or have already accepted
   * the workflow, so this is never retried automatically.
   */
  it("names the original code and externalId on civitai_submit_unconfirmed, and distinguishes not-found from unreadable", () => {
    const notFound = civitaiSubmitUnconfirmedFailure("civitai_http_504", "99a07779-ef94-43b6-bbc4-bc4ab9005f75", 2, 2);
    expect(notFound).toMatchObject({ code: "civitai_submit_unconfirmed", retry: "deliberate", stage: "submit" });
    expect(notFound.message).toContain("civitai_submit_unconfirmed; retry=deliberate");
    expect(notFound.message).toContain("civitai_http_504");
    expect(notFound.message).toContain("99a07779-ef94-43b6-bbc4-bc4ab9005f75");
    expect(notFound.message).toContain("2 lookup rounds");
    expect(notFound.message).not.toContain("could not be read");
    expect(notFound.message).not.toContain("that could be read");
    expect(notFound.message).not.toContain("page cap");
    expect(notFound.message).toContain("check the workflow list for it before starting one deliberate replacement");

    const unreadable = civitaiSubmitUnconfirmedFailure("civitai_transport_failure", "99a07779-ef94-43b6-bbc4-bc4ab9005f75", 0, 2);
    expect(unreadable.message).toContain("civitai_transport_failure");
    expect(unreadable.message).toContain("the lookup itself could not be read");
    expect(unreadable.message).not.toContain("no workflow in the list carried this externalId");

    expect(civitaiSubmitUnconfirmedFailure("civitai_malformed_response", "x", 1, 1).message).toContain("1 lookup round.");
  });

  /**
   * PROTECTS (second correction round, #673): `roundsSearched` counts only
   * rounds whose own read succeeded, never the configured round count
   * regardless of whether a round could actually be read, and a round that
   * hit its page cap without a match is named so the operator does not read
   * "not found" as "exhaustively searched."
   */
  it("qualifies civitai_submit_unconfirmed when the search was incomplete", () => {
    // One of two configured rounds could be read: "that could be read"
    // distinguishes this from the fully-searched case above.
    const partial = civitaiSubmitUnconfirmedFailure("civitai_transport_failure", "ext-id", 1, 2);
    expect(partial.message).toContain("1 lookup round that could be read");
    expect(partial.message).not.toContain("could not be read");

    // Both rounds read, but one hit its page cap without a match.
    const capped = civitaiSubmitUnconfirmedFailure("civitai_http_504", "ext-id", 2, 2, true);
    expect(capped.message).toContain("2 lookup rounds");
    expect(capped.message).not.toContain("that could be read");
    expect(capped.message).toContain("the list was only searched up to its page cap");
  });

  /**
   * PROTECTS (#673): every failure `runCivitaiLane` can return once a
   * workflow id exists — whether from the submit's own answer or by
   * adoption through the lookup — classifies as NON-transient, so
   * `executeSceneChain` (`MAX_TRANSIENT_RETRIES = 1`) never reruns the rung
   * and sends a second paid submit while the first, already billed, may
   * still finish. Pinned on the EXACT message string each factory actually
   * produces, per the PR #675 trap: a status-code regex like `\b503\b` does
   * not match inside a code token like `civitai_http_503`, so eyeballing a
   * code name is not evidence of its classification.
   */
  it("classifies every post-submit failure as non-transient (civitai_submit_unconfirmed included)", () => {
    const postSubmitFailures = [
      civitaiSubmitUnconfirmedFailure("civitai_transport_failure", "ext-id", 2, 2).message,
      civitaiSubmitUnconfirmedFailure("civitai_http_504", "ext-id", 0, 2).message,
      civitaiHttpFailure(503, "workflow_status", true, [], true).message,
      civitaiTransportFailure("workflow_status", true, true).message,
      civitaiAsyncFailure("expired", ["timeout"]).message, // civitai_async_timeout
      civitaiAsyncFailure("failed", ["no_provider_available"]).message,
      civitaiAsyncFailure("failed", []).message, // civitai_async_unknown_terminal
      civitaiOutputFailure("civitai_output_http_503", "deliberate").message,
      civitaiOutputFailure("civitai_output_transport_failure", "deliberate").message,
      civitaiInsufficientBuzzFailure().message,
      // The three plain `Error` messages `runCivitaiLane` throws after a
      // workflow id exists (apps/web/src/server/ai/civitai-runtime.ts),
      // copied verbatim rather than imported, so this test does not need the
      // runtime module and its mocked credentials to pin the exact strings.
      "Civitai returned a different workflow while polling",
      "Civitai generation submit returned an invalid workflow identity or status",
      "Civitai workflow did not retain mature-content permission and yellow-only payment",
    ];
    for (const message of postSubmitFailures) {
      expect(classifyImageFailureMessage(message), message).not.toBe("transient");
    }
  });

  /**
   * PROTECTS: the lora-metadata GET — the only pre-spend read with an
   * `automatic` disposition — is UNCHANGED by #673 and keeps classifying as
   * transient: retrying before any Buzz is spent is cheap and was always
   * the point of the bounded automatic retry. (The preflight's own POST
   * failures were already `deliberate`, never `automatic`, before #673 —
   * see "keeps a spent-retry preflight failure non-transient" above — so
   * they were never a transient case to begin with.)
   */
  it("keeps the pre-spend lora-metadata transient failure transient", () => {
    expect(classifyImageFailureMessage(civitaiHttpFailure(503, "lora_metadata", true, [], true).message)).toBe("transient");
    expect(classifyImageFailureMessage(civitaiTransportFailure("lora_metadata", true, true).message)).toBe("transient");
  });

  /**
   * PROTECTS (#682): a workflow that succeeded and was already paid for, but
   * whose output could not be downloaded, must read as recoverable — never
   * as a reason to render again. The message names the blob id and the
   * attempt count, says the workflow succeeded and was paid for, and says
   * the output can be recovered without rendering again; it must never read
   * as billing or content rejection, both of which
   * `classifyImageFailureMessage`/`isBillingFailureMessage` check BEFORE the
   * retry-disposition marker this failure relies on
   * (`packages/image-core/src/provider-interface/failures.ts`).
   */
  it("names the blob id and attempt count on civitai_output_undelivered, classifying it other/reconcile/non-billing", () => {
    const failure = civitaiOutputUndeliveredFailure("abc123.jpg", 4);

    expect(failure).toMatchObject({
      code: "civitai_output_undelivered", retry: "reconcile", stage: "output_download",
      outputId: "abc123.jpg", downloadAttempts: 4,
    });
    expect(failure.message).toContain("(civitai_output_undelivered; retry=reconcile)");
    expect(failure.message).toMatch(/succeeded/i);
    expect(failure.message).toMatch(/paid for/i);
    expect(failure.message).toContain("4 attempts");
    expect(failure.message).toContain("abc123.jpg");
    expect(failure.message).toMatch(/recovered/i);
    expect(failure.message).toMatch(/without rendering again/i);

    // Never a billing or content-rejection reading, even though both are
    // checked before the retry-disposition marker in the shared classifier.
    expect(failure.message.toLowerCase()).not.toMatch(/billing|payment required|402/);
    expect(failure.message.toLowerCase()).not.toMatch(
      /moderation|nsfw|flagged|violation|prohibited|disallowed|content policy|safe[_ ]?mode/,
    );

    expect(classifyImageFailureMessage(failure.message)).toBe("other");
    expect(declaresNonAutomaticRetry(failure.message)).toBe(true);
    expect(isBillingFailureMessage(failure.message)).toBe(false);
  });

  it("singularizes the attempt count at exactly one attempt", () => {
    const failure = civitaiOutputUndeliveredFailure("abc123.jpg", 1);
    expect(failure.message).toContain("1 attempt.");
    expect(failure.message).not.toContain("1 attempts");
  });
});
