import { z } from "zod";
import { diagnosticSchema } from "@/contracts";
import { characterSheetScopes } from "@/lib/character-scopes";
import { characterDraftSchema } from "@/lib/client/api";
import { parseOrNull } from "@/lib/parse";
import { writeDraft, type DraftStorage } from "./character-draft-storage";
import { proposalChanges, type CharacterReviewState } from "./character-proposals";

export const generationTargetSchema = z.object({ kind: z.enum(["creation", "character"]), id: z.string() });
export type GenerationTarget = z.infer<typeof generationTargetSchema>;
export const generationResultSchema = z.object({ proposed: characterDraftSchema, diagnostics: z.array(diagnosticSchema) });
export type GenerationResult = z.infer<typeof generationResultSchema>;
export const characterGenerationSchema = z.object({
  id: z.string(), ownerId: z.string(), target: generationTargetSchema,
  operation: z.enum(["create", "fill", "redraft", "portrait"]),
  scope: z.enum(characterSheetScopes).nullable(), label: z.string(), base: characterDraftSchema,
  creationStart: z.object({ draft: characterDraftSchema, prompt: z.string(), initialPreview: z.boolean() }).nullable(),
  status: z.enum(["pending", "completed", "failed"]),
  result: generationResultSchema.nullable(), error: z.string().nullable(),
});
export type CharacterGeneration = z.infer<typeof characterGenerationSchema>;
export type GenerationInput = Pick<CharacterGeneration, "operation" | "scope" | "label" | "base" | "creationStart">;
export const generationPrefix = (ownerId: string, target: GenerationTarget) => `vesper:character-generation:${ownerId}:${target.kind}:${target.id}:`;
export const generationKey = (record: CharacterGeneration) => generationPrefix(record.ownerId, record.target) + record.id;
export function matchesGeneration(record: CharacterGeneration, ownerId: string, target: GenerationTarget): boolean {
  return record.ownerId === ownerId && record.target.kind === target.kind && record.target.id === target.id
    && (record.operation !== "create" || target.kind === "creation")
    && (record.operation !== "portrait" || target.kind === "character")
    && (!record.scope || record.operation === "fill" || record.operation === "redraft");
}
export function readGeneration(raw: string | null): CharacterGeneration | null {
  if (!raw) return null;
  try { return parseOrNull(characterGenerationSchema, JSON.parse(raw)); } catch { return null; }
}
/** A response can only finish its original immutable request, including after unmount. */
export function finishGeneration(storage: DraftStorage, started: CharacterGeneration, outcome: { result: GenerationResult } | { error: string }): boolean {
  const key = generationKey(started);
  const raw = storage.getItem(key);
  const current = readGeneration(raw);
  if (!current || current.status !== "pending" || !matchesGeneration(current, started.ownerId, started.target)) return false;
  if (current.operation !== started.operation || current.scope !== started.scope || JSON.stringify(current.base) !== JSON.stringify(started.base)) return false;
  const next: CharacterGeneration = "result" in outcome
    ? { ...current, status: "completed", result: outcome.result, error: null }
    : { ...current, status: "failed", result: null, error: outcome.error };
  return writeDraft(storage, key, raw, JSON.stringify(next)) === "saved";
}
export function hasReceivedGeneration(review: CharacterReviewState, id: string): boolean {
  return review.pending.some((item) => item.id === id) || review.handledIds?.includes(id) === true || review.undo?.id === id;
}
export function receiveGenerationReview(review: CharacterReviewState, record: CharacterGeneration): CharacterReviewState {
  if (record.status !== "completed" || !record.result || hasReceivedGeneration(review, record.id)) return review;
  const proposal = { id: record.id, label: record.label, base: record.base, proposed: record.result.proposed, undo: false };
  return proposalChanges(proposal).length
    ? { ...review, pending: [...review.pending, proposal] }
    : { ...review, handledIds: [...(review.handledIds ?? []), record.id] };
}

/** Clear a completed response only after its destination receipt is durable. */
export function consumeGeneration(storage: DraftStorage, record: CharacterGeneration, destinationPersisted: boolean): boolean {
  if (!destinationPersisted || record.status !== "completed") return false;
  return writeDraft(storage, generationKey(record), JSON.stringify(record), null) === "saved";
}

/** Retain responses through a browser-storage outage without letting a cached
 * request hide a different version written by another tab after storage recovers. */
export function createGenerationStorage(backing: DraftStorage) {
  const cached = new Map<string, string>();
  const pending = new Map<string, { expected: string | null; value: string }>();
  const unavailable = new Set<string>();
  const storage: DraftStorage = {
    getItem: (key) => {
      try {
        const raw = backing.getItem(key);
        if (raw === null) cached.delete(key); else cached.set(key, raw);
        const queued = pending.get(key);
        if (queued && raw === queued.expected) return queued.value;
        pending.delete(key); unavailable.delete(key);
        return raw;
      } catch { unavailable.add(key); return pending.get(key)?.value ?? cached.get(key) ?? null; }
    },
    setItem: (key, value) => {
      const expected = pending.get(key)?.expected ?? cached.get(key) ?? null;
      try { backing.setItem(key, value); cached.set(key, value); pending.delete(key); unavailable.delete(key); }
      catch { pending.set(key, { expected, value }); unavailable.add(key); }
    },
    removeItem: (key) => {
      try { backing.removeItem(key); cached.delete(key); pending.delete(key); unavailable.delete(key); }
      catch (error) { unavailable.add(key); throw error; }
    },
  };
  return { ...storage, cachedKeys: () => [...new Set([...cached.keys(), ...pending.keys()])],
    unavailable: (prefix: string) => [...unavailable].some((key) => key.startsWith(prefix)) };
}
