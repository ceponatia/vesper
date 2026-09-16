import { describe, expect, it } from "vitest";
import { classifyImageFailureMessage } from "@vesper/image-core";
import { civitaiAsyncFailure, civitaiGetRetryDelay, civitaiHttpFailure, civitaiInsufficientBuzzFailure, civitaiOutputFailure, civitaiTransportFailure, civitaiReasonCodes, civitaiValidationPaths } from "./civitai-errors";

describe("Civitai error contract", () => {
  it("classifies HTTP failures without provider response text", () => {
    const failures = [
      [400, "never"], [401, "never"], [402, "never"], [403, "never"], [404, "never"],
      [409, "reconcile"], [429, "automatic"], [503, "automatic"],
    ] as const;

    for (const [status, retry] of failures) {
      expect(civitaiHttpFailure(status, "workflow_status")).toMatchObject({
        code: `civitai_http_${String(status)}`, retry, stage: "workflow_status", httpStatus: status,
      });
    }
    expect(civitaiHttpFailure(503, "submit", false)).toMatchObject({
      code: "civitai_http_503", retry: "deliberate", stage: "submit",
    });
  });

  it("classifies transport and output boundaries without response text", () => {
    expect(civitaiTransportFailure("workflow_status", true, true)).toMatchObject({
      code: "civitai_transport_failure", retry: "automatic", automaticRetriesExhausted: true,
    });
    expect(classifyImageFailureMessage(civitaiHttpFailure(503, "workflow_status", true, [], true).message)).toBe("transient");
    expect(civitaiTransportFailure("submit", false)).toMatchObject({
      code: "civitai_transport_failure", retry: "deliberate",
    });
    expect(civitaiOutputFailure("civitai_output_http_503", "deliberate")).toMatchObject({
      code: "civitai_output_http_503", retry: "deliberate", stage: "output_download",
    });
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
    expect(insufficient.message).toContain("insufficient yellow Buzz");
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
    const failure = civitaiHttpFailure(429, "workflow_status", true, civitaiValidationPaths({
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
});
