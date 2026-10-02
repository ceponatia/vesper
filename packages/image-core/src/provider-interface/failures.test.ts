import { describe, expect, it } from "vitest";
import { classifyImageFailureMessage, declaresNonAutomaticRetry, declaresSpentProviderWork, imageFailureHealthOutcome, isBillingFailureMessage } from "./failures";

describe("classifyImageFailureMessage", () => {
  it("classifies provider content-policy strings as content rejections", () => {
    expect(classifyImageFailureMessage("replicate 400: request blocked by content policy")).toBe("content_rejection");
    expect(classifyImageFailureMessage("replicate failed: NSFW content flagged")).toBe("content_rejection");
    // The shape `describeProviderError` digs out of an APICallError responseBody.
    expect(classifyImageFailureMessage('{"details":{"Moderation Reasons":["Sexual Content"]}}')).toBe(
      "content_rejection",
    );
  });

  it("classifies timeouts and 5xx/429 as transient", () => {
    expect(classifyImageFailureMessage("fetch failed: ETIMEDOUT")).toBe("transient");
    expect(classifyImageFailureMessage("replicate 503: service unavailable")).toBe("transient");
    expect(classifyImageFailureMessage("Too Many Requests")).toBe("transient");
  });

  it("treats missing keys and unknown failures as other", () => {
    expect(classifyImageFailureMessage("REPLICATE_API_TOKEN not configured")).toBe("other");
    expect(classifyImageFailureMessage("replicate returned no image")).toBe("other");
  });

  it("does not retry a billing failure as if it were transient", () => {
    // Observed on the Fly deploy 2026-08-05: `replicate 402: {"title":"Insufficient
    // credit"...}`. The `402` would match the transient status-code alternation and
    // earn a pointless retry, so billing is checked first.
    const insufficient = 'replicate 402: {"title":"Insufficient credit","detail":"..."}';
    expect(classifyImageFailureMessage(insufficient)).toBe("other");
    expect(isBillingFailureMessage(insufficient)).toBe(true);
    expect(isBillingFailureMessage("replicate 503: service unavailable")).toBe(false);
  });

  /**
   * PROTECTS (#673): a message that states its OWN retry disposition as
   * deliberate, never, or reconcile must never be read as transient, even
   * when it also contains a keyword the TRANSIENT pattern matches (a bare
   * status code, "timeout", "temporarily"). This is what closes the
   * double-spend path an exhausted Civitai workflow-status poll opened —
   * see civitai-errors.test.ts for the Civitai-specific messages this
   * actually fixes. Precedence: billing and content-rejection are checked
   * FIRST and still win over an explicit disposition, because a provider
   * answering about payment or about the prompt itself is more specific
   * than a generic retry disposition; only after those two does an explicit
   * `retry=` declaration outrank the keyword guess.
   */
  it("never reads a message as transient once it declares a non-automatic retry disposition", () => {
    expect(classifyImageFailureMessage("civitai workflow status failed (civitai_http_503; retry=reconcile). temporarily unavailable")).toBe("other");
    expect(classifyImageFailureMessage("some provider failure (code_1; retry=deliberate). request timed out after 503")).toBe("other");
    expect(classifyImageFailureMessage("some provider failure (code_2; retry=never). too many requests, 429")).toBe("other");

    // Billing and content-rejection still decide first, even over an explicit
    // disposition the same message happens to carry.
    expect(classifyImageFailureMessage("payment required (code; retry=deliberate)")).toBe("other");
    expect(classifyImageFailureMessage("blocked by content policy (code; retry=deliberate)")).toBe("content_rejection");

    // An `automatic` disposition is the one case this rule never excludes —
    // the keyword rules below still decide it, exactly as before.
    expect(classifyImageFailureMessage("read failed (code; retry=automatic). temporarily unavailable")).toBe("transient");
  });

  /**
   * PROTECTS: a provider that never states its own retry disposition keeps
   * classifying by keyword alone — the #673 rule above only ever REMOVES a
   * transient reading from a message explicit about not wanting one; it
   * cannot turn a provider's own wording transient or non-transient on its
   * own account. Mirrors the literal template in
   * `packages/image-replicate/src/prediction.ts` (`neverStartedMessage`).
   */
  it("still classifies an ordinary Replicate startup timeout as transient", () => {
    const message = "replicate prediction abc123 never started: queue busy — startup timed out after 3 attempts, and no render was attempted";
    expect(classifyImageFailureMessage(message)).toBe("transient");
  });
});

describe("declaresNonAutomaticRetry", () => {
  /**
   * PROTECTS (#673): this is the exact signal a caller outside the scene
   * chain's own classifier (`character-scene.ts`'s selfie retry) must honor
   * before repeating a paid request through a path `classifyImageFailureMessage`
   * does not guard. Built on the same regex as the classifier's own
   * NON_TRANSIENT_DISPOSITION rule, so the two can never drift apart.
   */
  it("is true for deliberate, never, and reconcile dispositions, false otherwise", () => {
    expect(declaresNonAutomaticRetry("civitai submit failed (civitai_submit_unconfirmed; retry=deliberate).")).toBe(true);
    expect(declaresNonAutomaticRetry("civitai output failed (civitai_output_invalid; retry=never).")).toBe(true);
    expect(declaresNonAutomaticRetry("civitai workflow status failed (civitai_http_503; retry=reconcile).")).toBe(true);

    expect(declaresNonAutomaticRetry("civitai lora metadata failed (civitai_http_503; retry=automatic).")).toBe(false);
    expect(declaresNonAutomaticRetry("replicate prediction abc never started: startup timed out")).toBe(false);
    expect(declaresNonAutomaticRetry("blocked by content policy")).toBe(false);
  });
});

/**
 * PROTECTS (#685): the scene chain's paid-stop rule reads exactly this
 * predicate to decide whether a rung's final failure already spent provider
 * work — mirrors the issue's accept/deny table, including the two cases that
 * must NOT stop the chain despite also declaring a non-automatic retry
 * disposition (a preflight `retry=deliberate`/`retry=never` refusal).
 */
describe("declaresSpentProviderWork", () => {
  it("is true for a civitai_output_undelivered failure (retry=reconcile)", () => {
    expect(
      declaresSpentProviderWork(
        "Civitai output download failed (civitai_output_undelivered; retry=reconcile). The workflow succeeded and was already paid for, but its output could not be downloaded after 3 attempts. It can be recovered from that output without rendering again.",
      ),
    ).toBe(true);
  });

  it("is true for the post-submit catch-all civitai-runtime.ts appends once a workflow id exists", () => {
    expect(
      declaresSpentProviderWork(
        "Civitai returned a different workflow while polling Civitai workflow abc-123 was already submitted (retry=reconcile). Refresh workflow status before deciding whether to replace it.",
      ),
    ).toBe(true);
  });

  it("is true for any other message that merely states retry=reconcile", () => {
    expect(declaresSpentProviderWork("civitai workflow status failed (civitai_http_503; retry=reconcile).")).toBe(true);
  });

  it("is true for civitai_submit_unconfirmed even though its own disposition is retry=deliberate", () => {
    expect(
      declaresSpentProviderWork(
        "Civitai submit failed (civitai_submit_unconfirmed; retry=deliberate). The submit's own answer was lost as civitai_http_503, and no workflow in the list carried this externalId after 2 lookup rounds. Civitai may still accept, or may already have accepted, this workflow under externalId=abc-123 — check the workflow list for it before starting one deliberate replacement.",
      ),
    ).toBe(true);
  });

  it("is false for a preflight retry=never refusal — falls through to the next rung, unchanged", () => {
    expect(declaresSpentProviderWork("Civitai preflight failed (civitai_http_400; retry=never). Do not repeat this request with the same input.")).toBe(false);
  });

  it("is false for a plain retry=deliberate disposition that is NOT civitai_submit_unconfirmed — the automatic repeat was spent, not money", () => {
    expect(
      declaresSpentProviderWork("Civitai preflight failed (civitai_http_503; retry=deliberate). Vesper already reposted this preflight once automatically; that retry is spent, so start one deliberate replacement only after reviewing the request."),
    ).toBe(false);
  });

  it("is false for content rejection and transient failures", () => {
    expect(declaresSpentProviderWork("blocked by content policy")).toBe(false);
    expect(declaresSpentProviderWork("fetch failed: ETIMEDOUT")).toBe(false);
  });
});

describe("imageFailureHealthOutcome", () => {
  it("reports a transient failure to the breaker as a failed lane", () => {
    expect(imageFailureHealthOutcome("transient")).toBe(false);
  });

  it("says nothing about health when the provider answered about the request", () => {
    // A moderation refusal is the upstream WORKING, on a prompt it declined; the
    // scene chain treats it the same way, retrying sanitized rather than counting
    // it toward "possible image service outage". Shedding every caller's renders
    // over one prompt would be the wrong trade.
    expect(imageFailureHealthOutcome("content_rejection")).toBeNull();
  });

  it("says nothing about health for billing and configuration failures", () => {
    // `other` is where an empty Replicate balance and a missing token land. No
    // cooldown refills either, so a tripped breaker would only hide them.
    expect(imageFailureHealthOutcome("other")).toBeNull();
  });
});
