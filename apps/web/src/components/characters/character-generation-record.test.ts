import { describe, expect, it } from "vitest";
import { emptyCharacterDraft } from "@/lib/client/api";
import { emptyCharacterReview } from "./character-proposals";
import { generationCacheKey, generationProjectionReceipt, generationRecordsForAbandonment, matchesGeneration, needsGenerationProjection, readGenerationCache, receiveGenerationReview, type CharacterGeneration } from "./character-generation-record";

function fixture(overrides: Partial<CharacterGeneration> = {}): CharacterGeneration {
  const base = emptyCharacterDraft();
  return {
    id: "request",
    ownerId: "owner",
    target: { kind: "character", id: "iris" },
    operation: "fill",
    scope: "profile",
    label: "missing Profile details",
    base,
    creationStart: null,
    source: { authoringRevision: 4, imageId: null },
    status: "completed",
    result: { proposed: { ...base, name: "Iris" }, diagnostics: [] },
    error: null,
    persisted: true,
    retryOf: null,
    rootRunId: "request",
    proposal: { revision: 1, status: "unresolved", choices: {}, appliedDraft: null, undo: null },
    createdAt: new Date(0).toISOString(),
    startedAt: new Date(0).toISOString(),
    finishedAt: new Date(1).toISOString(),
    ...overrides,
  };
}

describe("server character generation records", () => {
  it("projects an unresolved server proposal once and removes it after a persisted rejection", () => {
    const run = fixture();
    const received = receiveGenerationReview(emptyCharacterReview(), run);
    expect(received.pending).toHaveLength(1);
    expect(receiveGenerationReview(received, run)).toBe(received);
    const rejected = fixture({ proposal: { ...run.proposal, revision: 2, status: "rejected" } });
    const reconciled = receiveGenerationReview(received, rejected);
    expect(reconciled.pending).toEqual([]);
    expect(reconciled.handledIds).toContain(run.id);
  });

  it("restores a durable undo receipt without resurrecting the accepted proposal", () => {
    const run = fixture();
    const undo = { id: "request-undo", label: "Undo profile", base: run.result!.proposed, proposed: run.base, undo: true as const, sourceRunId: run.id, proposalRevision: 2 };
    const accepted = fixture({ proposal: { revision: 2, status: "accepted", choices: {}, appliedDraft: run.result!.proposed, undo } });
    const review = receiveGenerationReview(emptyCharacterReview(), accepted);
    expect(review.pending).toEqual([]);
    expect(review.undo).toEqual(undo);
    expect(receiveGenerationReview(review, accepted)).toBe(review);
  });

  it("keeps an already-handled empty proposal referentially stable", () => {
    const run = fixture({ result: { proposed: emptyCharacterDraft(), diagnostics: [] } });
    const received = receiveGenerationReview(emptyCharacterReview(), run);
    expect(received.handledIds).toContain(run.id);
    expect(receiveGenerationReview(received, run)).toBe(received);
  });

  it("replaces a captured optimistic request with its durable settlement without touching newer rows", () => {
    const optimistic = fixture({ id: "optimistic", status: "pending", persisted: false, result: null });
    const durable = fixture({ id: "durable", status: "pending", result: null });
    const newer = fixture({ id: "newer", status: "pending", result: null });
    expect(generationRecordsForAbandonment(
      [optimistic],
      [durable, newer],
      [{ requestId: optimistic.id, run: durable }],
    )).toEqual([durable]);
  });

  it("keeps a completed proposal active until its exact revision is projected", () => {
    const completed = fixture();
    const receipt = generationProjectionReceipt(completed);
    expect(needsGenerationProjection(completed, new Set())).toBe(true);
    expect(needsGenerationProjection(completed, new Set([receipt]))).toBe(false);
    expect(needsGenerationProjection(
      fixture({ proposal: { ...completed.proposal, revision: 2 } }),
      new Set([receipt]),
    )).toBe(true);
    expect(needsGenerationProjection(fixture({ status: "pending", result: null }), new Set())).toBe(false);
    expect(needsGenerationProjection(fixture({ result: null }), new Set())).toBe(false);
  });

  it("scopes character rows exactly while allowing a new browser to discover creation runs", () => {
    const run = fixture();
    expect(matchesGeneration(run, "other", run.target)).toBe(false);
    expect(matchesGeneration(run, run.ownerId, { kind: "character", id: "other" })).toBe(false);
    const creation = fixture({ target: { kind: "creation", id: "draft-a" }, operation: "create", source: null });
    expect(matchesGeneration(creation, creation.ownerId, { kind: "creation", id: "new-browser-draft" })).toBe(false);
    expect(matchesGeneration(creation, creation.ownerId, { kind: "creation", id: "draft-a" })).toBe(true);
    expect(generationCacheKey(creation.ownerId, creation.target)).toContain("draft-a");
    expect(generationCacheKey(creation.ownerId, creation.target)).toContain(":creation:draft-a");
  });

  it("degrades malformed cache entries to an empty cache", () => {
    expect(readGenerationCache("not json")).toEqual([]);
    expect(readGenerationCache(JSON.stringify({ savedAt: Date.now(), records: [{ broken: true }] }))).toEqual([]);
    expect(readGenerationCache(JSON.stringify({ savedAt: Date.now(), records: [fixture()] }))).toEqual([fixture()]);
  });
});
