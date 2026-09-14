import type { ChatState } from "./types";
import {
  type CharacterProfile,
  type DiagnosticSink,
  diag,
  applyDriveUpdates,
  appendMilestones,
  type ChatPersonalNotes,
  type Milestone,
} from "@/contracts";
import { applyChatAttributeOverlays } from "./pulse-rules";
import { appendSelfieEntry } from "../chat-selfie";
import {
  type OutfitEvidenceExchange,
  type OutfitEvidenceOwner,
  matchOutfitPresetInText,
  outfitChangeEvidenceValidated,
} from "./outfit-evidence";
import { foldRelationshipArc, appendSecretMilestones } from "./character-fold";
import type { EnsembleWardrobeReport } from "./finalize-types";

// Re-exported so existing consumers of this module keep one import site;
// the implementation lives in the leaf module `ensemble-roster.ts` so
// `finalize-agents.ts` and `wardrobe-fold.ts` can depend on it without
// completing the finalize-agents -> ensemble -> character-fold ->
// finalize-agents cycle this module's OWN `character-fold` import would
// otherwise close.
export { presentEnsembleMembers, type EnsembleRosterMember } from "./ensemble-roster";

/**
 * Fold one ensemble member's exchange results into their state (followups rulings
 * 10-11). PURE. Two halves:
 *
 * - **Deterministic folds for everyone who PULSED** (ruling 11): a relationship-history
 *   sample when regard moved (or their arc baseline), and the derived exchange
 *   milestones — emotional weather already landed inside the member's pulse.
 * - **The personal pass for every present member** (ruling 10): the four per-character
 *   fields (open loops, outfit, attribute overlays, drive movement) folded exactly the
 *   way `finalizeChatState` folds the shared archivist's for the primary; a revealed
 *   secret drive mints its `secret_shared` milestone. `null` (absent/degraded) keeps
 *   the prior fields.
 *
 * The primary never comes through here — `finalizeChatState` owns its richer fold.
 */
export function settleEnsembleMember(args: {
  /** The member's state AFTER their referenced-only pulse (untouched when not pulsed). */
  state: ChatState;
  /** Regard before the pulse — the sample/milestone trigger. */
  preRegard: number;
  /** Whether the referenced-only pulse ran for this member this exchange. */
  pulsed: boolean;
  /** The personal pass result; null keeps the member's prior personal fields. */
  personal: ChatPersonalNotes | null;
  /** This exchange's two halves — what the proposal's `changeEvidence` is checked against, per half. */
  exchange: OutfitEvidenceExchange;
  /**
   * THIS member as evidence owner. An ensemble is exactly the scene where a quote
   * of somebody else's genuine change would otherwise license this member's
   * whole-look replacement, so the count here is >1 and bare pronouns fail closed.
   */
  evidenceOwner: OutfitEvidenceOwner;
  /** The member's authored presets — what a whole-look `description` can name to re-seed the worn list. */
  profile: Pick<CharacterProfile, "outfits">;
  characterName: string;
  assistantMessageId: string;
  now: Date;
  /** The shared story clock (already ticked for this exchange). */
  clockMinutes: number;
  /**
   * True when a player selfie request addressed THIS member (ruling 12): if their
   * pulse read the reply as actually sending one, the send burns THEIR cooldown ring.
   */
  selfieRequestTarget?: boolean;
  sink?: DiagnosticSink;
}): ChatState {
  let next = args.state;
  const at = args.now.toISOString();
  const exchangeMilestones: Milestone[] = [];

  if (args.pulsed) {
    // Same triggers as the primary's fold: their arc baseline on the first-ever
    // sample, then a sample whenever the pulse moved regard (members' familiarity
    // holds — the ratchet's fact ticks stay primary-scoped).
    const arc = foldRelationshipArc({
      history: next.relationshipHistory,
      at,
      clockMinutes: args.clockMinutes,
      messageId: args.assistantMessageId,
      characterName: args.characterName,
      preRegard: args.preRegard,
      postRegard: next.regard,
      preFamiliarity: next.familiarity,
      postFamiliarity: next.familiarity,
      trace: next.lastPulseTrace.degraded ? null : next.lastPulseTrace,
    });
    if (arc.relationshipHistory !== next.relationshipHistory) {
      next = { ...next, relationshipHistory: arc.relationshipHistory };
    }
    exchangeMilestones.push(...arc.exchangeMilestones);
  }

  if (args.personal) {
    // The description branch runs `foldOutfitProposal`'s rungs in order: an authored preset
    // named in the text re-seeds the structured worn list (rung 1), and only an ad-hoc look
    // falls back to free text. What stays ensemble-specific is the reach of that fallback —
    // this fold is PURE, with no item-loading seam, so garment-level removed/added remain the
    // primary's (IO-backed) path and the restatement diagnostic names no unworn garment.
    //
    // Gated exactly like `foldOutfitProposal`/`foldPlayerOutfitProposal` (owner ruling,
    // 2026-08-01): over a MODELLED worn list, a description carrying no exposure claim, no
    // garment delta and no verbatim clause from this exchange saying THIS member's clothes
    // moved is a restatement of the standing look — demoting the structured list to prose on
    // one is how a dressed member silently becomes unmodellable, and taking somebody else's
    // change clause as the licence is how one member's coat wipes another's whole outfit
    // (which is why the evidence is owner-scoped). A matched preset never reaches the gate
    // (an authored look is authoritative); deltas only SKIP it here, they remain the primary's
    // path.
    const proposal = args.personal.outfit;
    const matched = proposal.description ? matchOutfitPresetInText(args.profile, proposal.description) : undefined;
    const preset = matched && matched.items.length > 0 ? matched : undefined;
    const restatesWornList =
      !preset &&
      next.wornItemIds.length > 0 &&
      !proposal.exposed &&
      proposal.removed.length === 0 &&
      proposal.added.length === 0 &&
      !outfitChangeEvidenceValidated(proposal.changeEvidence, args.exchange, args.evidenceOwner);
    if (proposal.description && restatesWornList) {
      args.sink?.push(
        diag(
          "info",
          "chat_wardrobe.ensemble_outfit_restatement",
          "ensemble outfit description restates the structured worn list; keeping the modelled wardrobe",
        ),
      );
    }
    // The preset's items are COPIED, not aliased: this becomes the member's mutable worn
    // list, and the array belongs to the library profile.
    const outfitPatch: Partial<ChatState> = preset
      ? { wornItemIds: [...preset.items], outfitPresetId: preset.id, outfit: "", outfitExposed: false }
      : proposal.description && !restatesWornList
        ? { wornItemIds: [], outfitPresetId: "", outfit: proposal.description, outfitExposed: proposal.exposed }
        : {};
    const driveResult = applyDriveUpdates(next.drives, args.personal.driveUpdates);
    appendSecretMilestones(exchangeMilestones, driveResult.revealed, {
      at, characterName: args.characterName, messageId: args.assistantMessageId,
    });
    next = {
      ...next,
      // Full-list-each-time; a degraded pass never reaches here, so
      // an emitted [] is a real "everything resolved".
      openLoops: args.personal.openLoops,
      attributeOverlays: applyChatAttributeOverlays(next.attributeOverlays, args.personal.attributeChanges, args.sink),
      drives: driveResult.drives,
      ...outfitPatch,
    };
  }

  // The addressed member sent the requested photo (ruling 12): burn THEIR ring —
  // same guard as the primary's fold (a degraded pulse never reads a send).
  if (args.selfieRequestTarget && !next.lastPulseTrace.degraded && next.lastPulseTrace.sentPhoto) {
    next = {
      ...next,
      selfieHistory: appendSelfieEntry(next.selfieHistory, { kind: "request", atClockMinutes: args.clockMinutes }),
    };
  }

  return exchangeMilestones.length ? { ...next, milestones: appendMilestones(next.milestones, exchangeMilestones) } : next;
}

// --- #298: threading the shared continuity leg's grounded garment lane ---
// through the ensemble roster. Two small, PURE decisions (the same "pure with an
// optional sink" convention `settleEnsembleMember` above already uses) so they
// are unit-testable without a database: what worn list a member's settle starts
// from, and whether their personal pass's own free-text outfit fold must sit
// out this exchange because a typed operation already moved that wardrobe.
// (Which present members join the handle enumeration + materialization pass is
// `presentEnsembleMembers`, re-exported above from the leaf module.)

/**
 * The member's pre-settle state, with `wornItemIds` swapped for the shared
 * continuity leg's post-typed-ops projection when this exchange modelled the
 * member (an entry present in `ensembleWardrobe.wornItemIds`) — so a typed
 * garment operation over the member's enumerated handle reaches their settle
 * exactly like the primary's re-derived projection reaches the primary's
 * write. Absent (a 1-on-1, or a member this exchange never modelled) ⇒ the
 * state passes through untouched.
 */
export function applyEnsembleWardrobeProjection(
  state: ChatState,
  characterId: string,
  ensembleWardrobe: Pick<EnsembleWardrobeReport, "wornItemIds">,
): ChatState {
  const projected = ensembleWardrobe.wornItemIds[characterId];
  return projected === undefined ? state : { ...state, wornItemIds: [...projected] };
}

/**
 * The no-op outfit proposal — `settleEnsembleMember` folds it as "nothing
 * changed". A factory, not a shared constant: `removed`/`added` are mutable
 * arrays, and every neutralized member this exchange must get their own,
 * never one instance aliased across calls.
 */
function neutralOutfitProposal(): ChatPersonalNotes["outfit"] {
  return { description: "", changeEvidence: "", exposed: false, removed: [], added: [] };
}

/**
 * The personal pass's notes to settle a member with, once the shared
 * continuity leg's grounded lane is accounted for: when this exchange's lane
 * is "operations" AND the member had a handle enumerated (their wardrobe
 * already moved through the typed dispatcher over the shared handle table),
 * the personal pass's OWN free-text outfit proposal is neutralized — the same
 * one-path-per-exchange rule the primary and player already follow, so no
 * member is ever mutated twice in one exchange. Everything else about the
 * personal pass (open loops, attribute overlays, drive updates) still folds.
 *
 * Files the one info diagnostic the skip earns (`chat_garments.ensemble_outfit_typed_lane`)
 * when it actually happens — never for a member the lane never enumerated, who
 * keeps today's free-text bridge unchanged.
 */
export function ensembleMemberPersonalNotes(input: {
  personal: ChatPersonalNotes | null;
  characterId: string;
  characterName: string;
  ensembleWardrobe: Pick<EnsembleWardrobeReport, "lane" | "enumeratedCharacterIds">;
  sink?: DiagnosticSink;
}): ChatPersonalNotes | null {
  const { personal, characterId, characterName, ensembleWardrobe, sink } = input;
  if (
    personal === null ||
    ensembleWardrobe.lane !== "operations" ||
    !ensembleWardrobe.enumeratedCharacterIds.includes(characterId)
  ) {
    return personal;
  }
  sink?.push(
    diag(
      "info",
      "chat_garments.ensemble_outfit_typed_lane",
      characterName + "'s wardrobe moved through the grounded garment lane this exchange — the personal pass's own free-text outfit fold is skipped",
    ),
  );
  return { ...personal, outfit: neutralOutfitProposal() };
}
