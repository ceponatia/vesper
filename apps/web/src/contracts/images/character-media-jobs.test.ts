import { describe, expect, it } from "vitest";
import { projectCharacterMediaJob, type CharacterMediaJobProjectionInput } from "./character-media-jobs";

const now = new Date("2026-09-08T18:00:00.000Z");
const base: CharacterMediaJobProjectionInput = {
  id: "job-1",
  type: "avatar",
  status: "running",
  payload: { characterId: "character-1", prompt: "must stay private", token: "secret" },
  createdAt: "2026-09-08T17:59:00.000Z",
  startedAt: "2026-09-08T17:59:01.000Z",
  finishedAt: null,
};

describe("character media job projection", () => {
  it("returns a safe active portrait projection without raw payload fields", () => {
    const projected = projectCharacterMediaJob(base, { now, staleAfterMs: 15 * 60_000 });
    expect(projected).toMatchObject({
      operation: "portrait",
      lifecycle: "running",
      progress: { completed: 0, total: 1, failed: 0 },
      retry: { operation: "portrait", targets: [] },
    });
    expect(JSON.stringify(projected)).not.toContain("must stay private");
    expect(JSON.stringify(projected)).not.toContain("secret");
  });

  it("reports bounded reference progress and the exact slots to retry", () => {
    const projected = projectCharacterMediaJob({
      ...base,
      type: "reference_views",
      status: "done",
      payload: { targets: ["front_full:clothed", "back_full:clothed"], planned: 2, built: 1, failed: 1 },
      finishedAt: now,
    }, { now, staleAfterMs: 15 * 60_000 });
    expect(projected.lifecycle).toBe("partial");
    expect(projected.progress).toEqual({ completed: 2, total: 2, failed: 1 });
    expect(projected.retry.targets).toEqual(["front_full:clothed", "back_full:clothed"]);
    expect(projected.error?.message).toContain("1 failed target");
  });

  it("turns an orphaned active row into an interrupted retry without exposing its raw error", () => {
    const projected = projectCharacterMediaJob({
      ...base,
      status: "running",
      createdAt: "2026-09-08T17:00:00.000Z",
      payload: { code: "images.avatar.provider_unavailable", internal: "https://token@example.test" },
    }, { now, staleAfterMs: 15 * 60_000 });
    expect(projected.lifecycle).toBe("interrupted");
    expect(projected.error).toEqual({
      code: "images.avatar.provider_unavailable",
      message: "Main portrait was interrupted. Retry it from the character tools.",
    });
    expect(JSON.stringify(projected)).not.toContain("example.test");
  });

  it("uses heartbeat age for current jobs and falls back to creation time for legacy inputs", () => {
    const live = projectCharacterMediaJob({
      ...base,
      createdAt: "2026-09-08T17:00:00.000Z",
      heartbeatAt: "2026-09-08T17:59:30.000Z",
    }, { now, staleAfterMs: 15 * 60_000 });
    expect(live.lifecycle).toBe("running");

    const expired = projectCharacterMediaJob({
      ...base,
      createdAt: "2026-09-08T17:59:00.000Z",
      heartbeatAt: "2026-09-08T17:00:00.000Z",
    }, { now, staleAfterMs: 15 * 60_000 });
    expect(expired.lifecycle).toBe("interrupted");

    const legacy = projectCharacterMediaJob({
      ...base,
      createdAt: "2026-09-08T17:59:00.000Z",
    }, { now, staleAfterMs: 15 * 60_000 });
    expect(legacy.lifecycle).toBe("running");
  });

  it("passes only typed result identifiers", () => {
    const projected = projectCharacterMediaJob({
      ...base,
      status: "done",
      payload: { imageId: "image-1", providerPredictionId: "provider-secret" },
      finishedAt: now,
    }, {
      now,
      staleAfterMs: 15 * 60_000,
      results: [
        { kind: "image", id: "image-1", imageId: "image-1" },
        { kind: "identity_pack", id: "pack-1", imageId: "crop-1" },
      ],
    });
    expect(projected.results).toEqual([
      { kind: "image", id: "image-1", imageId: "image-1" },
      { kind: "identity_pack", id: "pack-1", imageId: "crop-1" },
    ]);
    expect(JSON.stringify(projected)).not.toContain("provider-secret");
  });

  it("fails a settled portrait whose claimed image was not validated", () => {
    const projected = projectCharacterMediaJob({
      ...base,
      status: "done",
      payload: { imageId: "failed-image" },
      finishedAt: now,
    }, { now, staleAfterMs: 15 * 60_000, results: [] });

    expect(projected).toMatchObject({
      lifecycle: "failed",
      results: [],
      retry: { operation: "portrait", targets: [] },
    });
  });

  it("reports contained identity and reference refusals as failures even when their runners settled", () => {
    const identity = projectCharacterMediaJob({
      ...base,
      type: "identity_pack",
      status: "done",
      payload: { outcome: "blocked", code: "source_unreadable" },
      finishedAt: now,
    }, { now, staleAfterMs: 15 * 60_000 });
    expect(identity.lifecycle).toBe("failed");
    expect(identity.error?.code).toBe("source_unreadable");

    const references = projectCharacterMediaJob({
      ...base,
      type: "reference_views",
      status: "done",
      payload: { targets: ["front_full:clothed"], planned: 8, status: "source_unreadable" },
      finishedAt: now,
    }, { now, staleAfterMs: 15 * 60_000 });
    expect(references.lifecycle).toBe("failed");
    expect(references.progress.total).toBe(1);
    expect(references.error?.code).toBe("images.reference_views.source_unreadable");
  });
});
