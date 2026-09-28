import { describe, expect, it } from "vitest";
import { emptyCharacterDraft } from "@/lib/client/api";
import { emptyCharacterReview } from "./character-proposals";
import { generationCacheKey, generationProjectionReceipt, generationRecordsForAbandonment, isFirstForgeAutoAccept, matchesGeneration, needsGenerationProjection, readGenerationCache, receiveGenerationReview, type CharacterGeneration } from "./character-generation-record";

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

function createFixture(overrides: Partial<CharacterGeneration> = {}): CharacterGeneration {
  const base = emptyCharacterDraft();
  return fixture({
    operation: "create",
    scope: null,
    label: "forged character",
    creationStart: { draft: base, prompt: "A harbor master", initialPreview: true },
    source: { authoringRevision: 1, imageId: null },
    ...overrides,
  });
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
    const undo = { id: "request-undo", label: "Undo profile", base: run.result!.proposed, proposed: run.base, undo: true as const, sourceRunId: run.id, proposalRevision: 2, decidedAt: null };
    const accepted = fixture({ proposal: { revision: 2, status: "accepted", choices: {}, appliedDraft: run.result!.proposed, undo } });
    const review = receiveGenerationReview(emptyCharacterReview(), accepted);
    expect(review.pending).toEqual([]);
    expect(review.undo).toEqual(undo);
    expect(receiveGenerationReview(review, accepted)).toBe(review);
  });

  it("keeps the latest accepted undo when server runs replay in either order", () => {
    const older = fixture({ id: "older", createdAt: new Date(1).toISOString() });
    const newer = fixture({ id: "newer", createdAt: new Date(2).toISOString() });
    const oldUndo = {
      id: "older-undo", label: "Undo older", base: older.result!.proposed, proposed: older.base,
      undo: true as const, sourceRunId: older.id, proposalRevision: 2, decidedAt: new Date(10).toISOString(),
    };
    const newUndo = {
      id: "newer-undo", label: "Undo newer", base: newer.result!.proposed, proposed: newer.base,
      undo: true as const, sourceRunId: newer.id, proposalRevision: 2, decidedAt: new Date(20).toISOString(),
    };
    const acceptedOlder = fixture({
      ...older,
      proposal: {
        revision: 2, status: "accepted", decidedAt: oldUndo.decidedAt,
        choices: {}, appliedDraft: older.result!.proposed, undo: oldUndo,
      },
    });
    const acceptedNewer = fixture({
      ...newer,
      proposal: {
        revision: 2, status: "accepted", decidedAt: newUndo.decidedAt,
        choices: {}, appliedDraft: newer.result!.proposed, undo: newUndo,
      },
    });

    const newestFirst = receiveGenerationReview(
      receiveGenerationReview(emptyCharacterReview(), acceptedNewer),
      acceptedOlder,
    );
    const oldestFirst = receiveGenerationReview(
      receiveGenerationReview(emptyCharacterReview(), acceptedOlder),
      acceptedNewer,
    );
    expect(newestFirst.undo).toMatchObject({ sourceRunId: newer.id, decidedAt: newUndo.decidedAt });
    expect(oldestFirst.undo).toMatchObject({ sourceRunId: newer.id, decidedAt: newUndo.decidedAt });
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

  it("scopes character rows exactly to their owner and target", () => {
    const run = fixture();
    expect(matchesGeneration(run, "other", run.target)).toBe(false);
    expect(matchesGeneration(run, run.ownerId, { kind: "character", id: "other" })).toBe(false);
    expect(matchesGeneration(run, run.ownerId, run.target)).toBe(true);
    expect(generationCacheKey(run.ownerId, run.target)).toContain(":character:iris");
  });

  it("degrades malformed cache entries to an empty cache", () => {
    expect(readGenerationCache("not json")).toEqual([]);
    expect(readGenerationCache(JSON.stringify({ savedAt: Date.now(), records: [{ broken: true }] }))).toEqual([]);
    expect(readGenerationCache(JSON.stringify({ savedAt: Date.now(), records: [fixture()] }))).toEqual([fixture()]);
  });

  it("auto-accepts only the first Forge on a still-blank character", () => {
    expect(isFirstForgeAutoAccept(createFixture(), true)).toBe(true);
  });

  it("never auto-accepts a later Forge, a non-Forge run, or a receipt already seen (#517)", () => {
    // Not a create run at all.
    expect(isFirstForgeAutoAccept(fixture(), true)).toBe(false);
    // The character was edited (or this is a later Forge): the server computed initialPreview false.
    expect(isFirstForgeAutoAccept(createFixture({ creationStart: { draft: emptyCharacterDraft(), prompt: "A harbor master", initialPreview: false } }), true)).toBe(false);
    // Already decided.
    expect(isFirstForgeAutoAccept(createFixture({ proposal: { revision: 1, status: "accepted", choices: {}, appliedDraft: null, undo: null } }), true)).toBe(false);
    // Already projected once before (a retry of the completion effect, not a first receipt).
    expect(isFirstForgeAutoAccept(createFixture(), false)).toBe(false);
    // No authoring revision to compare-and-set against.
    expect(isFirstForgeAutoAccept(createFixture({ source: null }), true)).toBe(false);
  });
});
