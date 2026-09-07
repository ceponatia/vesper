import type { ChatState } from "./types";
import {
  type CharacterProfile,
  type DiagnosticSink,
  garmentIdentitiesIn,
  diag,
  applyWornGarmentChanges,
  type PersonaProfile,
  type ChatPlayerState,
} from "@/contracts";
import {
  healOutfitMarker,
  loadChatWardrobe,
  wardrobeDescriptors,
  playerWornIds,
} from "../chat-wardrobe";
import {
  type OutfitEvidenceExchange,
  type OutfitEvidenceOwner,
  matchOutfitPresetInText,
  outfitChangeEvidenceValidated,
} from "./outfit-evidence";

/**
 * Heal a legacy chat state's free-text `outfit` marker (comma-joined item ids) into the
 * readable garment phrase — a no-op for author-edited text and empty outfits (returns the
 * same ChatState ref). Structured worn state (`wornItemIds`) never uses a marker; this stays
 * for legacy free-text rows. Concrete `ChatState` in/out (the string-level heal lives in
 * `chat-wardrobe.ts`); a failed lookup degrades to "" (composer inference).
 */
export async function resolveSeededOutfit(
  state: ChatState,
  ownerId: string,
  profile: CharacterProfile,
  sink?: DiagnosticSink,
): Promise<ChatState> {
  const healed = await healOutfitMarker(state.outfit, ownerId, profile, sink);
  return healed === state.outfit ? state : { ...state, outfit: healed };
}

/** The archivist's outfit proposal shape — structural, so the fold never imports the schema type. */
export interface OutfitProposal {
  description: string;
  /** The verbatim clause from this exchange stating the outfit changed ("" ⇒ no claim). */
  changeEvidence: string;
  exposed: boolean;
  removed: readonly string[];
  added: readonly string[];
}

/** The player's outfit proposal — the same, minus `exposed` (always computed). */
export interface PlayerOutfitProposal {
  description: string;
  changeEvidence: string;
  removed: readonly string[];
  added: readonly string[];
}

/**
 * The TELEMETRY half of the kept-restatement path both outfit folds share: which
 * garment identities the kept description names that no worn item's name
 * accounts for (`contracts/items/garment-nouns.ts`). A kept description naming
 * an apron over a worn tee is the shape of a change the evidence gate may have
 * missed, so it rides the diagnostic message rather than being invisible.
 *
 * IO only when it can change the answer: no named garments ⇒ no load, and
 * nothing structured worn ⇒ nothing to account for them, so every named
 * identity is reported without touching the wardrobe.
 */
async function foreignGarmentIdentities(
  description: string,
  ownerId: string,
  wornIds: readonly string[],
  sink?: DiagnosticSink,
): Promise<string[]> {
  const named = [...garmentIdentitiesIn(description)];
  if (named.length === 0 || wornIds.length === 0) return named;
  const worn = await loadChatWardrobe(ownerId, wornIds, sink);
  const wornIdentities = new Set(worn.flatMap((item) => [...garmentIdentitiesIn(item.name)]));
  return named.filter((identity) => !wornIdentities.has(identity));
}

/** The kept-restatement diagnostic's message: the base ruling plus any unworn garment it named. */
function restatementMessage(base: string, foreign: readonly string[]): string {
  if (foreign.length === 0) return base;
  return `${base}; description names unworn garment(s): ${foreign.join(", ")} — no validated change evidence`;
}

/**
 * Fold an archivist outfit proposal into a structured-wardrobe state patch.
 * Three cases, all rollback-safe (the patched columns ride `storedChatStateSchema`):
 *
 * 1. `description` naming an authored preset → seed the worn list from it (rung 1, structured).
 * 2. `description` matching no preset → free-text full replacement (clear the worn list, ad-hoc
 *    look) — but only past the change-evidence gate, or on an exposure claim; otherwise the
 *    modelled wardrobe is KEPT and the restatement is recorded as a diagnostic.
 * 3. `removed`/`added` garment deltas → `applyWornGarmentChanges` against the loaded worn items +
 *    the character's wardrobe pool (rung 2). Unmatched additions ride the free-text overlay.
 *
 * `{}` (no change) for an empty proposal. IO in case 3 when a delta is present, and in case 2
 * only to name the unworn garments a KEPT description mentioned (the telemetry detail).
 */
export async function foldOutfitProposal(args: {
  profile: CharacterProfile;
  ownerId: string;
  state: ChatState;
  proposal: OutfitProposal | undefined;
  /** This exchange's two halves — what the proposal's `changeEvidence` is checked against, per half. */
  exchange: OutfitEvidenceExchange;
  /** Whose wardrobe this fold moves — the evidence must be attributable to them, not to another body in the scene. */
  evidenceOwner: OutfitEvidenceOwner;
  sink?: DiagnosticSink;
}): Promise<Partial<ChatState>> {
  const { proposal } = args;
  if (!proposal) return {};
  if (proposal.description) {
    const preset = matchOutfitPresetInText(args.profile, proposal.description);
    if (preset && preset.items.length > 0) {
      // Copied, not aliased: this becomes the chat's mutable worn list, and the preset's
      // array belongs to the library profile (found via the player twin's test).
      return { wornItemIds: [...preset.items], outfitPresetId: preset.id, outfit: "", outfitExposed: false };
    }
    // Before the free-text replacement may wipe a STRUCTURED wardrobe, the
    // proposal must SHOW that THIS character's outfit changed: a verbatim clause
    // from this exchange saying so, attributable to them and not to another body
    // in the scene (owner ruling, 2026-08-01 — `outfitChangeEvidenceValidated`).
    // The store is the worn truth once this actor is modelled, and a
    // paraphrase of the standing look is not
    // a wardrobe action; demoting the structured list to prose on one was how a
    // dressed body silently became unmodellable — and therefore untouchable by
    // the contact leg — one settle into a fresh conversation.
    //
    // The gate replaces the old garment-noun predicate, which could not tell a
    // same-noun change ("a black silk shirt" over a worn cotton shirt) from a
    // paraphrase, nor an alias ("t-shirt" for a worn "tee") from a new garment.
    // Everything else keeps its authoritative path: garment deltas and an
    // exposure claim skip the gate entirely, and an authored preset matched
    // above never reaches it — so a real change always still applies. It only
    // guards a wardrobe that IS structured: with nothing modelled (a legacy
    // free-text chat) there is nothing to protect, and the description keeps
    // updating the overlay exactly as before.
    if (
      args.state.wornItemIds.length > 0 &&
      !proposal.exposed &&
      proposal.removed.length === 0 &&
      proposal.added.length === 0 &&
      !outfitChangeEvidenceValidated(proposal.changeEvidence, args.exchange, args.evidenceOwner)
    ) {
      const foreign = await foreignGarmentIdentities(
        proposal.description,
        args.ownerId,
        args.state.wornItemIds,
        args.sink,
      );
      args.sink?.push(
        diag(
          "info",
          "chat_wardrobe.outfit_restatement",
          restatementMessage(
            "outfit description restates the structured worn list; keeping the modelled wardrobe",
            foreign,
          ),
        ),
      );
      return {};
    }
    // No matching preset — an ad-hoc whole look falls back to free text (ruled).
    return { wornItemIds: [], outfitPresetId: "", outfit: proposal.description, outfitExposed: proposal.exposed };
  }
  if (proposal.removed.length === 0 && proposal.added.length === 0) return {};
  const worn = await loadChatWardrobe(args.ownerId, args.state.wornItemIds, args.sink);
  // Add-candidate pool = the character's known wardrobe (union of preset items) not already worn.
  const poolIds = [...new Set(args.profile.outfits.flatMap((p) => p.items))].filter(
    (id) => !args.state.wornItemIds.includes(id),
  );
  const pool = poolIds.length ? await loadChatWardrobe(args.ownerId, poolIds, args.sink) : [];
  const result = applyWornGarmentChanges({
    wornIds: args.state.wornItemIds,
    worn: wardrobeDescriptors(worn),
    pool: wardrobeDescriptors(pool),
    change: { removed: proposal.removed, added: proposal.added },
    overlay: args.state.outfit,
    sink: args.sink,
  });
  return { wornItemIds: result.wornIds, outfit: result.overlay };
}

/**
 * The same fold for the **PLAYER's** clothing — "she tugs you out of your
 * shirt" is a state change, not just prose.
 *
 * Reuses `applyWornGarmentChanges` verbatim: the reducer is already generic over
 * `{wornIds, worn, pool}` and knows nothing about characters, so the player needs no
 * fork of the matching rules, the caps, or the unmatched-garment diagnostics.
 *
 * Three differences from the character twin above:
 * - The pool is the **persona's** wardrobe, and "what's on now" comes from
 *   `playerWornIds` — so a first-ever change resolves against the default preset the
 *   player is implicitly wearing rather than an empty list.
 * - Every write sets `seeded: true`: once the fiction has moved the wardrobe, an empty
 *   list means *stripped*, not *not-dressed-yet*.
 * - No `exposed` — the player's exposure is always computed from coverage.
 *
 * Returns `{}` (no change) for an empty proposal or when there is no persona to dress.
 */
export async function foldPlayerOutfitProposal(args: {
  persona: PersonaProfile | undefined;
  ownerId: string;
  playerState: ChatPlayerState;
  proposal: PlayerOutfitProposal | undefined;
  /** This exchange's two halves — what the proposal's `changeEvidence` is checked against, per half. */
  exchange: OutfitEvidenceExchange;
  /** The PLAYER as evidence owner — first person in their own line, second person in the reply. */
  evidenceOwner: OutfitEvidenceOwner;
  sink?: DiagnosticSink;
}): Promise<Partial<ChatPlayerState>> {
  const { proposal, persona } = args;
  if (!proposal || !persona) return {};
  if (proposal.description) {
    const preset = matchOutfitPresetInText(persona, proposal.description);
    if (preset && preset.items.length > 0) {
      return { wornItemIds: [...preset.items], outfitPresetId: preset.id, overlay: "", seeded: true };
    }
    // The character twin's change-evidence gate, against what the player has on
    // RIGHT NOW (the default preset until seeded — so a narrator paraphrase of the
    // look the persona arrived in doesn't demote a never-touched wardrobe to prose,
    // stripping the modelled body's coverage). Same boundary: with no garment
    // deltas, a whole-look description replaces only when this exchange's text
    // actually states the change AS THE PLAYER'S — first person in their own line,
    // second person in the reply — and only a wardrobe that IS structured is
    // guarded (a persona with no worn garments has nothing to protect). No
    // exposure condition because the player proposal has no `exposed` — it is
    // always computed.
    const guardedWornIds = playerWornIds(args.playerState, persona);
    if (
      guardedWornIds.length > 0 &&
      proposal.removed.length === 0 &&
      proposal.added.length === 0 &&
      !outfitChangeEvidenceValidated(proposal.changeEvidence, args.exchange, args.evidenceOwner)
    ) {
      const foreign = await foreignGarmentIdentities(
        proposal.description,
        args.ownerId,
        guardedWornIds,
        args.sink,
      );
      args.sink?.push(
        diag(
          "info",
          "chat_wardrobe.player_outfit_restatement",
          restatementMessage(
            "player outfit description restates the structured worn list; keeping the modelled wardrobe",
            foreign,
          ),
        ),
      );
      return {};
    }
    // No matching preset — an ad-hoc whole look rides the overlay text (the ruling the
    // character path follows), and clears the structured list it replaces.
    return { wornItemIds: [], outfitPresetId: "", overlay: proposal.description, seeded: true };
  }
  if (proposal.removed.length === 0 && proposal.added.length === 0) return {};

  // What the player has on RIGHT NOW — the default preset until something has changed it.
  const wornIds = playerWornIds(args.playerState, persona);
  const worn = await loadChatWardrobe(args.ownerId, wornIds, args.sink);
  const poolIds = [...new Set(persona.outfits.flatMap((p) => p.items))].filter((id) => !wornIds.includes(id));
  const pool = poolIds.length ? await loadChatWardrobe(args.ownerId, poolIds, args.sink) : [];
  const result = applyWornGarmentChanges({
    wornIds,
    worn: wardrobeDescriptors(worn),
    pool: wardrobeDescriptors(pool),
    change: { removed: proposal.removed, added: proposal.added },
    overlay: args.playerState.overlay,
    sink: args.sink,
  });
  return { wornItemIds: result.wornIds, overlay: result.overlay, seeded: true };
}