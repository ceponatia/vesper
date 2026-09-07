import { z } from "zod";
import { attributeRegistry, traitRegistry } from "@/contracts";
import { characterDraftSchema, type CharacterDraft } from "@/lib/client/api";

export const characterProposalSchema = z.object({
  id: z.string(),
  label: z.string(),
  sourceDraftId: z.string().optional(),
  base: characterDraftSchema,
  proposed: characterDraftSchema,
  undo: z.boolean().default(false),
});
export type CharacterProposal = z.infer<typeof characterProposalSchema>;
export const characterReviewStateSchema = z.object({
  pending: z.array(characterProposalSchema).default([]),
  handledIds: z.array(z.string()).optional(),
  undo: characterProposalSchema.nullable().default(null),
});
export type CharacterReviewState = z.infer<typeof characterReviewStateSchema>;
export const emptyCharacterReview = (): CharacterReviewState => ({ pending: [], undo: null });
type Path = (string | { id: string })[];
export interface ProposalChange { key: string; path: Path; label: string; before: unknown; after: unknown }
export type ProposalChoices = Record<string, "current" | "proposed">;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const object = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const keyed = (v: unknown): v is { id: string }[] => Array.isArray(v) && v.every((row) => object(row) && typeof row.id === "string") && new Set(v.map((row) => row.id)).size === v.length;
const words = (s: string) => s.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[._]/g, " ");
const title = (path: Path): string => path.map((part) => {
  if (typeof part === "string") return words(part);
  return attributeRegistry.byId(part.id as never)?.label ?? traitRegistry.byId(part.id as never)?.label ?? words(part.id);
}).filter((p) => p !== "profile").join(" · ");

/** Diff the generation snapshot, never the draft at response time. Arrays with stable ids
 * are compared by row, so accepting one attribute cannot erase another edited attribute. */
export function proposalChanges(proposal: CharacterProposal): ProposalChange[] {
  const changes: ProposalChange[] = [];
  const visit = (before: unknown, after: unknown, path: Path) => {
    if (same(before, after) || path.join(".") === "profile.creationBrief") return;
    if (["attributes", "traits"].includes(String(path.at(-1))) && keyed(before) && keyed(after)) {
      for (const id of new Set([...before.map((r) => r.id), ...after.map((r) => r.id)])) {
        const old = before.find((r) => r.id === id);
        const next = after.find((r) => r.id === id);
        if (!same(old, next) && !(object(old) && object(next) && same(old.value, next.value) && same(old.note, next.note))) {
          const rowPath = [...path, { id }];
          changes.push({ key: JSON.stringify(rowPath), path: rowPath, label: title(rowPath), before: old, after: next });
        }
      }
    } else if (object(before) && object(after)) {
      for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
        visit(before[key], after[key], [...path, key]);
      }
    } else {
      changes.push({ key: JSON.stringify(path), path, label: title(path), before, after });
    }
  };
  visit(proposal.base, proposal.proposed, []);
  return changes;
}

export function valueAt(draft: CharacterDraft, path: Path): unknown {
  let value: unknown = draft;
  for (const part of path) {
    value = typeof part === "string"
      ? object(value) ? value[part] : undefined
      : Array.isArray(value) ? value.find((row: unknown) => object(row) && row.id === part.id) : undefined;
  }
  return value;
}

function writeAt(target: unknown, path: Path, value: unknown): void {
  const [part, ...rest] = path;
  if (part === undefined) return;
  if (typeof part === "string" && object(target)) {
    if (rest.length) {
      if (target[part] === undefined) target[part] = typeof rest[0] === "object" ? [] : {};
      writeAt(target[part], rest, value);
    }
    else if (value === undefined) delete target[part];
    else target[part] = structuredClone(value);
  } else if (typeof part === "object" && Array.isArray(target)) {
    const index = target.findIndex((row: unknown) => object(row) && row.id === part.id);
    if (rest.length) {
      if (index >= 0) writeAt(target[index], rest, value);
    } else if (value === undefined) {
      if (index >= 0) target.splice(index, 1);
    } else if (index >= 0) target[index] = structuredClone(value);
    else target.push(structuredClone(value));
  }
}

export function proposalConflicts(current: CharacterDraft, proposal: CharacterProposal): ProposalChange[] {
  return proposalChanges(proposal).filter((change) => {
    const now = valueAt(current, change.path);
    return !same(now, change.before) && !same(now, change.after);
  });
}

/** Explicit conflict choices use three-way merge; the same operation also owns undo. */
export function applyCharacterProposal(current: CharacterDraft, proposal: CharacterProposal, choices: ProposalChoices = {}): { draft: CharacterDraft; undo: CharacterProposal | null; unresolved: ProposalChange[] } {
  const unresolved = proposalConflicts(current, proposal).filter((c) => !choices[c.key]);
  if (unresolved.length) return { draft: current, undo: null, unresolved };
  const draft = structuredClone(current);
  for (const change of proposalChanges(proposal)) {
    if (choices[change.key] !== "current") writeAt(draft, change.path, change.after);
  }
  return {
    draft,
    unresolved: [],
    undo: same(current, draft) ? null : { id: `${proposal.id}-undo`, label: `Undo ${proposal.label}`, base: draft, proposed: current, undo: true },
  };
}

/** Values use author-facing text instead of raw JSON/provenance. */
export function describeProposalValue(value: unknown): string {
  if (value === undefined || value === null || value === "" || (Array.isArray(value) && !value.length)) return "Empty";
  if (Array.isArray(value)) return value.map(describeProposalValue).join("; ");
  if (object(value)) {
    if ("value" in value) {
      const note = typeof value.note === "string" ? value.note.trim() : "";
      return `${describeProposalValue(value.value)}${note ? ` · Note: ${note}` : ""}`;
    }
    return Object.entries(value).filter(([key]) => !["source", "sourceId", "id"].includes(key)).map(([key, item]) => `${words(key)}: ${describeProposalValue(item)}`).join(" · ");
  }
  return typeof value === "boolean" ? value ? "Yes" : "No" : String(value);
}

/** Saving accepted outfit suggestions materializes item ids. Extend the undo
 * receipt to include those ids, without treating a save as acceptance of a proposal. */
export function reconcileMaterializedUndo(review: CharacterReviewState, sent: CharacterDraft, saved: CharacterDraft["profile"]): CharacterReviewState {
  if (!review.undo || !sent.suggestedItems.length || !same(review.undo.base.suggestedItems, sent.suggestedItems)) return review;
  const existing = new Set(sent.profile.outfits[0]?.items ?? []);
  const added = saved.outfits[0]?.items.filter((id) => !existing.has(id)) ?? [];
  if (!added.length) return review;
  const base = review.undo.base;
  const first = base.profile.outfits[0];
  const outfits = first
    ? [{ ...first, items: [...new Set([...first.items, ...added])] }, ...base.profile.outfits.slice(1)]
    : [{ id: saved.outfits[0]?.id ?? "everyday", name: saved.outfits[0]?.name ?? "Everyday", items: added }];
  return { ...review, undo: { ...review.undo, base: { ...base, suggestedItems: [], profile: { ...base.profile, outfits } } } };
}

/** Repeated saves replace this creation draft's contribution, preserving proposals
 * created on the saved character. Decisions on either surface prevent resurrection. */
export function transferCreationReview(existing: CharacterReviewState | undefined, incoming: CharacterReviewState, sourceDraftId: string): CharacterReviewState {
  const handled = new Set([...(existing?.handledIds ?? []), ...(incoming.handledIds ?? [])]);
  const carried = incoming.pending.filter((proposal) => !handled.has(proposal.id)).map((proposal) => ({ ...proposal, sourceDraftId }));
  const destinationOnly = (existing?.pending ?? []).filter((proposal) => proposal.sourceDraftId !== sourceDraftId && !handled.has(proposal.id));
  const pending = new Map([...carried, ...destinationOnly].map((proposal) => [proposal.id, proposal]));
  const undo = existing?.undo ?? incoming.undo;
  return { pending: [...pending.values()], handledIds: [...handled], undo: undo && !handled.has(undo.id) ? undo : null };
}
