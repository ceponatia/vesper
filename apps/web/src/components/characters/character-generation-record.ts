import { z } from "zod";
import {
  characterAuthoringRunSchema,
  type CharacterAuthoringGenerationInput,
  type CharacterAuthoringResult,
  type CharacterAuthoringRun,
  type CharacterAuthoringTarget,
} from "@/lib/client/api/character-authoring-runs";
import { parseOrNull } from "@/lib/parse";
import { proposalChanges, type CharacterProposal, type CharacterReviewState } from "./character-proposals";

export const characterGenerationSchema = characterAuthoringRunSchema;
export type CharacterGeneration = CharacterAuthoringRun;
export type GenerationInput = CharacterAuthoringGenerationInput;
export type GenerationResult = CharacterAuthoringResult;
export type GenerationTarget = CharacterAuthoringTarget;

/** One bounded browser cache per account and surface; the server remains authoritative. */
export const generationCacheKey = (ownerId: string, target: GenerationTarget) =>
  `vesper:character-generation-cache:${ownerId}:${target.kind}:${target.id}`;

export const characterGenerationCacheSchema = z.object({
  savedAt: z.number(),
  records: z.array(characterGenerationSchema).max(25),
});

export function readGenerationCache(raw: string | null): CharacterGeneration[] {
  if (!raw) return [];
  try { return parseOrNull(characterGenerationCacheSchema, JSON.parse(raw))?.records ?? []; }
  catch { return []; }
}

export function matchesGeneration(record: CharacterGeneration, ownerId: string, target: GenerationTarget): boolean {
  return record.ownerId === ownerId
    && record.target.kind === target.kind
    && record.target.id === target.id
    && (record.operation !== "portrait" || record.target.kind === "character")
    && (!record.scope || record.operation === "fill" || record.operation === "redraft");
}

export function hasReceivedGeneration(review: CharacterReviewState, id: string): boolean {
  return review.pending.some((item) => item.sourceRunId === id || item.id === id)
    || review.handledIds?.includes(id) === true
    || review.undo?.sourceRunId === id;
}

/** A receipt is specific to one server proposal projection, including decisions that advance its revision. */
export const generationProjectionReceipt = (record: CharacterGeneration) =>
  `${record.target.kind}:${record.target.id}:${record.id}:${record.proposal.revision}`;

export function needsGenerationProjection(
  record: CharacterGeneration,
  receipts: ReadonlySet<string>,
): boolean {
  return record.status === "completed" && record.result !== null
    && !receipts.has(generationProjectionReceipt(record));
}

const needsAbandonment = (record: CharacterGeneration) => record.status === "pending"
  || record.status === "failed"
  || record.proposal.status === "unresolved";

export interface SettledGenerationRequest {
  readonly requestId: string;
  readonly run: CharacterGeneration | null;
}

/**
 * Resolve reset against the requests that existed when reset began. A retry may
 * converge on a different active run id, so its returned durable row replaces
 * the optimistic request id. Rows discovered later are left alone.
 */
export function generationRecordsForAbandonment(
  captured: readonly CharacterGeneration[],
  current: readonly CharacterGeneration[],
  settled: readonly SettledGenerationRequest[],
): CharacterGeneration[] {
  const capturedIds = new Set(captured.filter(needsAbandonment).map((record) => record.id));
  const selected = new Map(captured.filter(needsAbandonment).map((record) => [record.id, record]));
  for (const record of current) if (capturedIds.has(record.id)) selected.set(record.id, record);
  for (const request of settled) {
    if (!capturedIds.has(request.requestId) || !request.run) continue;
    selected.delete(request.requestId);
    selected.set(request.run.id, request.run);
  }
  return [...selected.values()];
}

function proposalFor(record: CharacterGeneration): CharacterProposal | null {
  if (record.status !== "completed" || !record.result) return null;
  return {
    id: record.id,
    sourceRunId: record.id,
    proposalRevision: record.proposal.revision,
    label: record.label,
    base: record.base,
    proposed: record.result.proposed,
    undo: false,
    ...(record.result.portrait ? { portraitEvidence: record.result.portrait } : {}),
  };
}

function currentUndo(
  existing: CharacterProposal | null,
  candidate: CharacterProposal,
): CharacterProposal {
  if (!existing || existing.sourceRunId === candidate.sourceRunId) return candidate;
  if (!existing.sourceRunId) return existing;
  const existingAt = existing.decidedAt ? Date.parse(existing.decidedAt) : Number.NaN;
  const candidateAt = candidate.decidedAt ? Date.parse(candidate.decidedAt) : Number.NaN;
  if (Number.isFinite(candidateAt) && (!Number.isFinite(existingAt) || candidateAt > existingAt)) {
    return candidate;
  }
  // Legacy receipts have no decision timestamp. The server lists newest-created
  // runs first, so retaining the first replayed undo is the safest fallback.
  return existing;
}

/** Project server proposal state into the browser cache without resurrecting a decision. */
export function receiveGenerationReview(review: CharacterReviewState, record: CharacterGeneration): CharacterReviewState {
  const proposal = proposalFor(record);
  if (!proposal) return review;
  const withoutRun = review.pending.filter((item) => item.sourceRunId !== record.id && item.id !== record.id);
  if (record.proposal.status === "unresolved") {
    const existing = review.pending.find((item) => item.sourceRunId === record.id || item.id === record.id);
    if (existing?.proposalRevision === proposal.proposalRevision) return review;
    if (proposalChanges(proposal).length) return { ...review, pending: [...withoutRun, proposal] };
    if (withoutRun.length === review.pending.length && review.handledIds?.includes(record.id)) return review;
    return { ...review, pending: withoutRun, handledIds: [...new Set([...(review.handledIds ?? []), record.id])] };
  }
  if (record.proposal.status === "accepted" && record.proposal.undo) {
    const undo = {
      ...record.proposal.undo,
      decidedAt: record.proposal.undo.decidedAt ?? record.proposal.decidedAt ?? null,
    };
    if (withoutRun.length === review.pending.length && review.handledIds?.includes(record.id)
      && review.undo?.sourceRunId === record.id && review.undo.proposalRevision === undo.proposalRevision) return review;
    return {
      ...review,
      pending: withoutRun,
      handledIds: [...new Set([...(review.handledIds ?? []), record.id])],
      undo: currentUndo(review.undo, undo),
    };
  }
  if (withoutRun.length === review.pending.length && review.handledIds?.includes(record.id)
    && review.undo?.sourceRunId !== record.id) return review;
  return {
    ...review,
    pending: withoutRun,
    handledIds: [...new Set([...(review.handledIds ?? []), record.id])],
    undo: review.undo?.sourceRunId === record.id ? null : review.undo,
  };
}
