import { describe, expect, it } from "vitest";
import type { CharacterMediaJob } from "@/lib/client/api";
import { characterMediaStatusView } from "./character-media-status-view";

const job = (overrides: Partial<CharacterMediaJob> = {}): CharacterMediaJob => ({
  id: "job",
  operation: "reference_views",
  label: "Reference views",
  targets: ["front_full:clothed", "back_full:clothed"],
  lifecycle: "running",
  progress: { completed: 0, total: 2, failed: 0 },
  error: null,
  results: [],
  retry: { operation: "reference_views", targets: ["front_full:clothed", "back_full:clothed"] },
  createdAt: "2026-09-08T17:00:00.000Z",
  startedAt: "2026-09-08T17:00:01.000Z",
  finishedAt: null,
  ...overrides,
});

describe("character media status copy", () => {
  it("keeps active work visible across tab changes", () => {
    expect(characterMediaStatusView(job())).toEqual({
      title: "Reference views in progress",
      detail: "You can leave this tab and return. 0 of 2 settled.",
      tone: "default",
      active: true,
      retryLabel: null,
    });
  });

  it("names the exact character surface that owns a retry", () => {
    expect(characterMediaStatusView(job({
      lifecycle: "failed",
      error: { code: "media_job.failed", message: "Reference views failed. Retry it from the character tools." },
    })).retryLabel).toBe("Retry from Portrait Studio → Reference views");
  });
});
