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
  `vesper:character-generation-cache:${ownerId}:${target.kind}:${target.kind === "character" ? target.id : "latest"}`;

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
    && (target.kind === "creation" || record.target.id === target.id)
    && (record.operation !== "portrait" || record.target.kind === "character")
    && (!record.scope || record.operation === "fill" || record.operation === "redraft");
}

export function hasReceivedGeneration(review: CharacterReviewState, id: string): boolean {
  return review.pending.some((item) => item.sourceRunId === id || item.id === id)
    || review.handledIds?.includes(id) === true
    || review.undo?.sourceRunId === id;
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

/** Project server proposal state into the browser cache without resurrecting a decision. */
export function receiveGenerationReview(review: CharacterReviewState, record: CharacterGeneration): CharacterReviewState {
  const proposal = proposalFor(record);
  if (!proposal) return review;
  const withoutRun = review.pending.filter((item) => item.sourceRunId !== record.id && item.id !== record.id);
  if (record.proposal.status === "unresolved") {
    const existing = review.pending.find((item) => item.sourceRunId === record.id || item.id === record.id);
    if (existing?.proposalRevision === proposal.proposalRevision) return review;
    return proposalChanges(proposal).length
      ? { ...review, pending: [...withoutRun, proposal] }
      : { ...review, handledIds: [...new Set([...(review.handledIds ?? []), record.id])] };
  }
  if (record.proposal.status === "accepted" && record.proposal.undo) {
    if (withoutRun.length === review.pending.length && review.handledIds?.includes(record.id)
      && review.undo?.sourceRunId === record.id && review.undo.proposalRevision === record.proposal.undo.proposalRevision) return review;
    return {
      ...review,
      pending: withoutRun,
      handledIds: [...new Set([...(review.handledIds ?? []), record.id])],
      undo: record.proposal.undo,
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
