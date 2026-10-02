import { describe, expect, it } from "vitest";
import { classifyImageFailureMessage, declaresNonAutomaticRetry, imageFailureHealthOutcome, isBillingFailureMessage, providerWorkSpent } from "./failures";

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
 * PROTECTS (#685, PR #692 review): the scene chain's paid-stop rule reads
 * exactly this predicate to decide whether a rung's final failure spent
 * provider work that may still deliver. It must stop on structured evidence
 * only — a workflow id beside `retry=reconcile`, or a lost submit answer
 * (`submit_unconfirmed`) — and must fall through on everything else. The bad
 * implementation this kills reads the message alone: the Civitai transport
 * declares an HTTP 409 `retry=reconcile` at every stage, so a 409 from the
 * LoRA read, the zero-cost preflight or a rejected submit (none of which ever
 * created a workflow) used to stop an otherwise renderable scene.
 */
describe("providerWorkSpent", () => {
  const UNDELIVERED =
    "Civitai output download failed (civitai_output_undelivered; retry=reconcile). The workflow succeeded and was already paid for, but its output could not be downloaded after 4 attempts. It can be recovered from that output without rendering again.";
  const LOCAL_DEADLINE =
    "Civitai workflow status failed (civitai_async_timeout; retry=reconcile). Refresh workflow status before deciding whether to replace it.";
  const CATCH_ALL =
    "Civitai returned a different workflow while polling Civitai workflow abc-123 was already submitted (retry=reconcile). Refresh workflow status before deciding whether to replace it.";
  const UNCONFIRMED =
    "Civitai submit failed (civitai_submit_unconfirmed; retry=deliberate). The submit's own answer was lost as civitai_http_503, and no workflow in the list carried this externalId after 2 lookup rounds.";
  const PREFLIGHT_409 = "Civitai preflight failed (civitai_http_409; retry=reconcile). Refresh workflow status before deciding whether to replace it.";
  const SUBMIT_409 = "Civitai submit failed (civitai_http_409; retry=reconcile). Refresh workflow status before deciding whether to replace it.";
  const LORA_409 = "Civitai lora metadata failed (civitai_http_409; retry=reconcile). Refresh workflow status before deciding whether to replace it.";

  it.each([
    ["an undelivered output, naming its workflow", UNDELIVERED, "wf-1"],
    ["Vesper's own poll deadline on a submitted workflow", LOCAL_DEADLINE, "wf-1"],
    ["the post-submit catch-all, naming its workflow", CATCH_ALL, "abc-123"],
    ["a lost submit answer, whose workflow id is unknown by definition", UNCONFIRMED, undefined],
    ["a lost submit answer that says so explicitly", UNCONFIRMED, null],
  ] as const)("stops on %s", (_label, message, predictionId) => {
    expect(providerWorkSpent({ message, ...(predictionId === undefined ? {} : { predictionId }) })).toBe(true);
  });

  it.each([
    ["a preflight 409 reconcile, with no workflow", PREFLIGHT_409, undefined],
    ["a submit 409 Civitai rejected outright, with no workflow", SUBMIT_409, null],
    ["a LoRA metadata 409, with no workflow", LORA_409, undefined],
    ["a reconcile naming an empty workflow id", LOCAL_DEADLINE, ""],
    ["a preflight retry=never refusal", "Civitai preflight failed (civitai_http_400; retry=never). Do not repeat this request with the same input.", undefined],
    [
      "a preflight retry=deliberate refusal, its automatic repeat spent and nothing paid",
      "Civitai preflight failed (civitai_http_503; retry=deliberate). Vesper already reposted this preflight once automatically; that retry is spent, so start one deliberate replacement only after reviewing the request.",
      undefined,
    ],
    ["a provider-reported expiry on a submitted workflow (deliberate)", "Civitai workflow terminal failed (civitai_async_timeout; retry=deliberate).", "wf-1"],
    ["another provider's failed prediction, naming its id but no reconcile", "replicate prediction failed: CUDA out of memory", "pred-1"],
    ["a content rejection", "blocked by content policy", undefined],
    ["an ordinary transient failure", "fetch failed: ETIMEDOUT", undefined],
  ] as const)("falls through on %s", (_label, message, predictionId) => {
    expect(providerWorkSpent({ message, ...(predictionId === undefined ? {} : { predictionId }) })).toBe(false);
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
