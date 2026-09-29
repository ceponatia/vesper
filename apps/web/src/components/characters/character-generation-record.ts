import { z } from "zod";
import {
  characterAuthoringRunSchema,
  type CharacterAuthoringGenerationInput,
  type CharacterAuthoringResult,
  type CharacterAuthoringRun,
  type CharacterAuthoringTarget,
} from "@/lib/client/api/character-authoring-runs";
import { parseOrNull } from "@/lib/parse";
import { proposalChanges, type CharacterProposal, type CharacterReviewState, type ProposalChange } from "./character-proposals";

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
    && (!record.scope || record.operation === "fill" || record.operation === "redraft");
}

/**
 * The very first Forge on a character that has never been edited applies
 * directly, without a review step. `initialPreview` is computed server-side
 * (true only for a never-edited blank character), so any edit made meanwhile —
 * including one made while this run was in flight — turns it into an ordinary
 * proposal instead. `changes` are the record's own base/proposed diff: an
 * empty first Forge has nothing to apply and takes the "no changes
 * suggested" path instead. AI output never silently replaces authored values
 * otherwise. The caller still has to reconfirm the authoring revision after
 * flushing any unsaved local edit — this predicate only covers what the
 * record itself can say.
 */
export function isFirstForgeAutoAccept(
  record: CharacterGeneration,
  firstReceipt: boolean,
  changes: readonly ProposalChange[],
): record is CharacterGeneration & { source: NonNullable<CharacterGeneration["source"]> } {
  return record.operation === "create"
    && record.creationStart?.initialPreview === true
    && record.proposal.status === "unresolved"
    && firstReceipt
    && record.source !== null
    && changes.length > 0;
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
