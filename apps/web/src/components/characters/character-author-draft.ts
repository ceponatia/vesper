import { z } from "zod";
import { characterDraftSchema, type CharacterDetail, type CharacterDraft } from "@/lib/client/api";
import { resolveChatModelId } from "@/lib/narrative-models";
import { applyCharacterProposal, proposalConflicts, type CharacterProposal, type ProposalChoices } from "./character-proposals";

export const characterAuthorSnapshotSchema = z.object({ draft: characterDraftSchema, chatModel: z.string() });
export type CharacterAuthorSnapshot = z.infer<typeof characterAuthorSnapshotSchema>;
export const characterAuthorRecoverySchema = z.object({
  base: characterAuthorSnapshotSchema,
  authored: characterAuthorSnapshotSchema,
  serverUpdatedAt: z.string().nullable(),
}).nullable();
export type CharacterAuthorRecovery = NonNullable<z.infer<typeof characterAuthorRecoverySchema>>;
export const emptyAuthorRecovery = () => null;
export const sameAuthorSnapshot = (a: CharacterAuthorSnapshot, b: CharacterAuthorSnapshot) => JSON.stringify(a) === JSON.stringify(b);
export function authorSnapshotFromDetail(detail: CharacterDetail): CharacterAuthorSnapshot {
  return { draft: characterDraftSchema.parse({ name: detail.name, tags: detail.tags, profile: detail.profile }), chatModel: resolveChatModelId(detail.chatModel) };
}
export function authorRecoveryDisposition(server: CharacterAuthorSnapshot, updatedAt: string | null, recovery: CharacterAuthorRecovery): "acknowledged" | "resume" | "review" {
  if (sameAuthorSnapshot(server, recovery.authored)) return "acknowledged";
  return updatedAt === recovery.serverUpdatedAt && sameAuthorSnapshot(server, recovery.base) ? "resume" : "review";
}
export function authorRecoveryProposal(recovery: CharacterAuthorRecovery): CharacterProposal {
  return { id: "author-recovery", label: "Review recovered edits", base: recovery.base.draft, proposed: recovery.authored.draft, undo: false };
}
export function authorModelConflict(current: CharacterAuthorSnapshot, recovery: CharacterAuthorRecovery): boolean {
  return recovery.authored.chatModel !== recovery.base.chatModel && current.chatModel !== recovery.base.chatModel && current.chatModel !== recovery.authored.chatModel;
}
export function rebaseAuthorRecovery(current: CharacterAuthorSnapshot, recovery: CharacterAuthorRecovery, choices: ProposalChoices = {}, modelChoice?: "current" | "proposed"): CharacterAuthorSnapshot | null {
  if (authorModelConflict(current, recovery) && !modelChoice) return null;
  const applied = applyCharacterProposal(current.draft, authorRecoveryProposal(recovery), choices);
  if (applied.unresolved.length) return null;
  const chatModel = modelChoice === "current" || recovery.authored.chatModel === recovery.base.chatModel ? current.chatModel : recovery.authored.chatModel;
  return { draft: { ...applied.draft, profile: { ...applied.draft.profile, creationBrief: current.draft.profile.creationBrief || recovery.authored.draft.profile.creationBrief } }, chatModel };
}

/** A server acknowledgment owns only its returned differences. Newer author edits
 * survive; materialized ids join the same surviving outfit rather than replacing it. */
export function reconcileCharacterSave(latest: CharacterDraft, sent: CharacterDraft, saved: CharacterDraft): CharacterDraft {
  const acknowledgment: CharacterProposal = { id: "save-ack", label: "Saved values", base: sent, proposed: saved, undo: false };
  const choices = Object.fromEntries(proposalConflicts(latest, acknowledgment).map((change) => [change.key, "current" as const]));
  const merged = applyCharacterProposal(latest, acknowledgment, choices).draft;
  const reconciled = { ...merged, profile: { ...merged.profile, creationBrief: latest.profile.creationBrief || sent.profile.creationBrief || saved.profile.creationBrief } };
  if (!sent.suggestedItems.length) return reconciled;
  // Exact multiset subtraction retains new suggestions and edited versions of sent rows.
  const counts = new Map<string, number>();
  for (const item of sent.suggestedItems) { const key = JSON.stringify(item); counts.set(key, (counts.get(key) ?? 0) + 1); }
  const suggestedItems = latest.suggestedItems.filter((item) => {
    const key = JSON.stringify(item);
    const count = counts.get(key) ?? 0;
    if (!count) return true;
    counts.set(key, count - 1);
    return false;
  });
  const sentOutfit = sent.profile.outfits[0];
  const savedOutfit = saved.profile.outfits[0];
  const added = savedOutfit?.items.filter((id) => !sentOutfit?.items.includes(id)) ?? [];
  let outfits = latest.profile.outfits;
  if (savedOutfit && added.length) {
    const targetId = sentOutfit?.id ?? savedOutfit.id;
    const target = outfits.find((outfit) => outfit.id === targetId);
    if (target) outfits = outfits.map((outfit) => outfit.id === targetId ? { ...outfit, items: [...new Set([...outfit.items, ...added])] } : outfit);
    else if (!sentOutfit) outfits = [...outfits, { ...savedOutfit, items: added }];
    // A preset explicitly removed during the save is not resurrected.
  }
  return { ...reconciled, suggestedItems, profile: { ...reconciled.profile, outfits } };
}
