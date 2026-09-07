import type { ChatState, ChatScenario } from "./chat-state/types";
import {
  type CharacterProfile,
  type DiagnosticSink,
  type OutfitPreset,
  outfitPresetByName,
  classifyOutfitChangeQuote,
  type SocialReactionCard,
  type ChatPulse,
  chatPulseSchema,
  degradedChatPulse,
  diag,
  garmentIdentitiesIn,
  applyWornGarmentChanges,
  type PersonaProfile,
  type ChatPlayerState,
  type RetrievedMemoryDetail,
  type GarmentCueState,
  type AffordanceCueState,
  type EffectiveCoverageRead,
  type BodyMarkProposal,
  resolveTraits,
  traitRegistry,
  hasVoiceAnchors,
  type ChatPlan,
  planOthersLabel,
  describePlanWhen,
  currentScenePlace,
  buildGarmentHandleTable,
  garmentActorForCharacter,
  GARMENT_PLAYER_ACTOR,
  advancePlans,
  splitStateCues,
  mergeSceneMemory,
  mergeSupportingCast,
  mergeChatPlans,
  garmentMutationLane,
  applyGarmentProposals,
  type GarmentOperationTraceEntry,
  applyEnvironmentProposal,
  applySurfaceWetnessProposals,
  parseSurfaceWetnessProposals,
  applySurfaceDepositProposals,
  parseSurfaceDepositProposals,
  applyBodyMarkProposals,
  type ChatSurfaceTraceEntry,
  tickFamiliarity,
  appendRelationshipSample,
  regardBandForValue,
  deriveExchangeMilestones,
  applyDriveUpdates,
  planInvolvesPlayer,
  appendMilestones,
  type ChatMemoryTrace,
  type ChatPersonalNotes,
  type Milestone,
} from "@/contracts";
import { healOutfitMarker, loadChatWardrobe, wardrobeDescriptors, playerWornIds } from "./chat-wardrobe";
import { type AgentLegTrace, runChatExtraction, writeChatMemory } from "./chat-memory";
import type { AgentRunDescription, AgentRunDetailSection } from "@/contracts/turns/agent-failure";
import {
  isDemoMode,
  agentModelId,
  loadChatAgentReasoningProfile,
  type AgentTelemetry,
  generateChecked,
  withGenerateTimeout,
} from "../ai";
import { buildChatPulsePrompt, CHAT_PULSE_SYSTEM } from "./prompts/chat-state";
import { agentReasoningPlan } from "@/lib/agent-reasoning";
import { CHAT_PULSE_MAX_OUTPUT_TOKENS, CHAT_PULSE_TIMEOUT_MS } from "./constants";
import {
  applyOpenerPulse,
  applyChatPulse,
  applyChatAttributeOverlays,
  applyChatTraitOverlays,
} from "./chat-state/pulse-rules";
import { type ChatSurfaceTransferInput, persistSurfaceTransferSettlement } from "./chat-state/surface-transfer";
import { lifeStageForAge, lifeStageThirdPersonLine } from "@/contracts/world/life-stage";
import { appendVoiceExemplar } from "./chat-voice";
import { newId } from "@/lib/ids";
import { syncGarmentsForExchange, garmentProjectionOr, chatGarmentLookChanged } from "./chat-garments";
import { applySurfaceTransferProposals } from "@/contracts/turns/chat-contact-transfer";
import { appendSelfieEntry } from "./chat-selfie";
import { saveChatState, saveChatScenario } from "./chat-state/store";
import { savePreExchangeSnapshot, savePreExchangeScenario } from "./chat-state/snapshots";
import { enqueueChatSceneSketch } from "./chat-scene-sketch";
import { enqueueChatLookImage } from "./chat-reference-enqueue";

export type { ChatPresence, ChatScenario, ChatState, ChatStateSnapshot } from "./chat-state/types";
export { chatStateSnapshot } from "./chat-state/readout";
export { seedChatScenario, seedChatState } from "./chat-state/seed";
export { applyTimeSkip, applyTimeSkipToScenario, driftChatState, rhythmOutfitPatch } from "./chat-state/time";
export {
  applyChatAction,
  applyChatAttributeOverlays,
  applyChatPulse,
  applyChatTraitOverlays,
  applyOpenerPulse,
} from "./chat-state/pulse-rules";

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

/**
 * Match an archivist outfit description against the authored preset names.
 * Conservative on purpose: a preset matches only
 * when the text IS its name ("work") or names it with an outfit word ("changes
 * into her work clothes", "her date night outfit") — a bare name inside prose
 * ("work boots" naming no outfit word... does match "work clothes"-style
 * phrasing only) can't hijack an unrelated garment description. Longest name
 * wins; empty presets never match.
 */
export function matchOutfitPresetInText(
  profile: Pick<CharacterProfile, "outfits">,
  text: string,
): OutfitPreset | undefined {
  const haystack = text.trim().toLowerCase();
  if (!haystack) return undefined;
  const exact = outfitPresetByName(profile, text);
  if (exact && exact.items.length > 0) return exact;
  const candidates = profile.outfits
    .filter((p) => p.name.trim().length >= 3 && p.items.length > 0)
    .sort((a, b) => b.name.trim().length - a.name.trim().length);
  for (const preset of candidates) {
    const name = preset.name.trim().toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`(?:^|[^a-z0-9])${name}\\s+(?:clothes|outfit|look|attire|uniform|wear|set)(?:$|[^a-z0-9])`);
    if (pattern.test(haystack)) return preset;
  }
  return undefined;
}

/**
 * Light normalization for the change-evidence check: case, whitespace runs and
 * curly quotes/apostrophes are all things a model re-types differently while
 * still quoting the exchange verbatim. Everything else — wording, punctuation,
 * order — must match, which is the whole point of a VERBATIM quote.
 */
function normalizeEvidenceText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[‘’‛′]/g, "'")
    .replace(/[“”‟″]/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

/** The two halves of the exchange a whole-look `changeEvidence` may quote — kept separate because first/second person attribute differently per half. */
export interface OutfitEvidenceExchange {
  player: string;
  assistant: string;
}

/** The wardrobe owner the evidence must be about, plus the scene shape that decides pronoun ambiguity. */
export interface OutfitEvidenceOwner {
  /** Display name + authored aliases referring to the owner (for the player: the persona/account name). */
  names: readonly string[];
  /** True when the owner is the player persona (first/second-person forms can attribute). */
  isPlayer: boolean;
  /** Names of every OTHER scene participant — other present characters, plus the player's name when the owner is a character. */
  otherNames: readonly string[];
  /** Characters present in the scene, the owner included when the owner is a character. >1 ⇒ bare pronouns are ambiguous and fail closed. */
  presentCharacterCount: number;
}

/** Word-boundary name match on already-normalized text — the shape `mentionsCharacter` uses, kept local so this pure gate owns no cross-module dependency. */
function textNamesAnyOf(text: string, names: readonly string[]): boolean {
  return names
    .map((name) => name.trim())
    .filter((name) => name.length > 1)
    .some((needle) =>
      new RegExp(`(?:^|[^\\p{L}\\p{N}])${needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:[^\\p{L}\\p{N}]|$)`, "iu").test(
        text,
      ),
    );
}

/** Person forms in a normalized (lowercased) sentence — the only grammar this gate reads. */
const EVIDENCE_FIRST_PERSON = /\b(?:i|me|my|mine|myself)\b/;
const EVIDENCE_SECOND_PERSON = /\b(?:you|your|yours|yourself)\b/;
const EVIDENCE_THIRD_PERSON = /\b(?:she|he|they|her|hers|him|his|their|theirs|herself|himself|themselves)\b/;

/**
 * Is this change clause about the WARDROBE OWNER's clothes (condition 3)?
 *
 * Runs against the ONE sentence `classifyOutfitChangeQuote` said asserts the
 * change, not the whole quote — a multi-sentence quote can narrate two bodies,
 * and only the asserting sentence says whose clothes moved.
 *
 * Bounded attribution, deliberately NOT coreference resolution: a name settles
 * it outright, person forms settle it only where the half they appear in makes
 * them unambiguous, and an ensemble scene fails closed on bare pronouns.
 */
function evidenceAttributesToOwner(args: {
  sentence: string;
  owner: OutfitEvidenceOwner;
  inPlayer: boolean;
  inAssistant: boolean;
}): boolean {
  const { sentence, owner, inPlayer, inAssistant } = args;
  // A named owner wins wherever the name sits in the clause, including the
  // possessive object ("Mara pulls off Sabrina's jacket" IS Sabrina's change) — the
  // owner need not be the actor.
  if (textNamesAnyOf(sentence, owner.names)) return true;
  // …and a clause that names only somebody ELSE is that participant's evidence, not this one's.
  if (textNamesAnyOf(sentence, owner.otherNames)) return false;

  const first = EVIDENCE_FIRST_PERSON.test(sentence);
  const second = EVIDENCE_SECOND_PERSON.test(sentence);
  const third = EVIDENCE_THIRD_PERSON.test(sentence);
  const solo = owner.presentCharacterCount <= 1;

  if (owner.isPlayer) {
    // "I take off my jacket" is the player only in the player's own line; "she
    // tugs you out of your shirt" is the player only in the reply. The wrong
    // half flips the referent (first person in the reply is the character
    // speaking), so it does not attribute.
    if (first && inPlayer) return true;
    if (second && inAssistant) return true;
    return solo && !first && !second && !third;
  }
  // Character owner. Bare pronouns are only unambiguous while one character is on
  // stage; with a second body present, only the name licenses the replacement.
  if (!solo) return false;
  if (third) return true;
  if (first && inAssistant) return true;
  if (second && inPlayer) return true;
  // A markerless clause ("kicks off the boots") in a two-body scene: the character
  // is the only wardrobe the reply can be moving.
  return !first && !second;
}

/**
 * Did the archivist's whole-look outfit proposal come with REAL evidence that
 * the outfit changed during this exchange, TO THIS OWNER (owner ruling,
 * 2026-08-01)?
 *
 * THREE conditions, and each of the last two was bought the hard way. The quote must
 *
 * 1. **be in the exchange** — non-empty and present under `normalizeEvidenceText`
 *    in one half or (spanning them) in the joined text; and
 * 2. **assert a change** — say that the clothes moved, per
 *    `classifyOutfitChangeQuote` (`contracts/items/outfit-change-evidence.ts`),
 *    which owns the whole reading: the wardrobe-verb table, the non-event vetoes
 *    (negation, modality, questions, commands, incompletes, hypotheticals…) and
 *    the garment-object window that tells "takes off her jacket" from "takes off
 *    for work". Its rejection reason is diagnostic detail this gate does not
 *    surface — the fold's message text is the same whichever way a quote failed;
 *    its ACCEPTANCE hands back the one sentence that asserted, which is the text
 *    condition 3 reads; and
 * 3. **attribute to the wardrobe owner** — `evidenceAttributesToOwner`, run on
 *    that asserting sentence.
 *
 * Presence alone was the first cut of this gate, and the live check on the
 * deployed build (2026-08-01) proved it trivially satisfiable: a fresh chat's
 * player line read "I walk over to her. Her sleeves are shoved past her elbows,
 * one cuff dusted with flour." — a pure styling paraphrase — and the extractor
 * proposed that very sentence as BOTH the description and its own
 * `changeEvidence`. The quote was genuinely in the text, so the gate passed and
 * the fold wiped the modelled wardrobe. Extracted descriptions are almost always
 * lifted from the prose, so a self-quote always "validates"; only asking what the
 * quoted clause SAYS separates "she slips out of the work clothes" from "her
 * sleeves are shoved past her elbows".
 *
 * Condition 3 came from the adversarial audit of that fix (2026-08-01): all three
 * call sites validated against ONE shared exchange text, so a quote of participant
 * A's genuine change ("Mara pulls on her coat.") licensed participant B's whole-look
 * replacement — the extractor's member-scoped prompting was the only thing standing
 * between an ensemble and a cross-wiped wardrobe, and prompting is not a gate.
 *
 * The scoping is BOUNDED — a name test plus person forms read against the half they
 * appear in — never coreference resolution, which no regex can do and which would
 * fail unpredictably rather than closed. Canonically: "She takes off her jacket"
 * attributes to the sole character on stage; "I take off my jacket" attributes to the
 * player in the PLAYER's half; "Mara pulls off Sabrina's jacket" is valid evidence for
 * SABRINA (the owner is named, actor or not). Two deliberate acceptances make the
 * boundedness honest — the named ACTOR passes for their own wardrobe as readily as
 * the named object does, and a compound like "she tugs you out of your shirt"
 * passes for a solo CHARACTER owner on its third-person marker. Both are the price of
 * not parsing; ensemble scenes, where the confusion actually costs a wardrobe, still
 * fail closed without the owner's name.
 *
 * This is the one gate that lets a free-text `description` replace a modelled
 * wardrobe (alongside the character fold's exposure claim and an authored-preset
 * match), and it replaces the old garment-noun predicate outright. A noun list
 * could never decide it: "a black silk shirt" over a worn "soft cotton shirt"
 * shares its head noun and IS a change; "her white cotton t-shirt" over a worn
 * "white cotton tee" is a different word for the SAME garment; "a paint-streaked
 * tank top" names a compound no unigram registry holds.
 */
export function outfitChangeEvidenceValidated(
  evidence: string,
  exchange: OutfitEvidenceExchange,
  owner: OutfitEvidenceOwner,
): boolean {
  const quote = normalizeEvidenceText(evidence);
  if (!quote) return false;
  // Which half the quote came from is what makes "I"/"you" attributable, so
  // grounding resolves the half first. A quote spanning both halves is still
  // grounded, but carries no half attribution — person forms in it cannot decide.
  const inPlayer = normalizeEvidenceText(exchange.player).includes(quote);
  const inAssistant = normalizeEvidenceText(exchange.assistant).includes(quote);
  if (!inPlayer && !inAssistant && !normalizeEvidenceText(`${exchange.player}\n${exchange.assistant}`).includes(quote)) {
    return false;
  }
  const verdict = classifyOutfitChangeQuote(quote);
  if (!verdict.asserted) return false;
  // Attribution reads the ASSERTING sentence the classifier hands back, never the
  // whole quote: "Mara pulls on her coat. Sabrina laughs." must not attribute to
  // Sabrina on a name that sits outside the clause claiming a change.
  return evidenceAttributesToOwner({ sentence: verdict.sentence, owner, inPlayer, inAssistant });
}

  export interface ChatPulseInput {
  /** The SETTING-wide house rules (followups ruling 9) — one set for every member. */
  activeSocialCards: readonly SocialReactionCard[];
  state: ChatState;
  profile: CharacterProfile;
  characterName: string;
  playerName: string;
  exchange: { player: string; assistant: string };
  /**
   * "opener" folds only the classifier's READS — sentPhoto + mindNote — into
   * state (`applyOpenerPulse`); a reopen opener has no player act, so the curve
   * must not move regard/meters/feeling off the character's own words. Absent ⇒
   * the full fold.
   */
  scope?: "full" | "opener";
  /**
   * Commitments that just came due this exchange: so the
   * feeling proposal is informed — a just-missed plan is a hurt that lingers, a just-kept
   * one is warm. Model-mediated only; the curve/regard never move off this (no deterministic
   * penalty). Absent when nothing came due (the common case).
   */
  commitmentsDue?: { missed: readonly string[]; kept: readonly string[] };
  /** Failure telemetry only (agent-failure.ts) — never reaches the prompt. */
  trace?: AgentLegTrace;
  sink?: DiagnosticSink;
}

/** Summary + detail of "what the pulse read" for the inspector's activity log / lightbox. PURE. */
function describeChatPulse(p: ChatPulse): AgentRunDescription {
  const details: AgentRunDetailSection[] = [];
  if (p.playerAct?.concept) details.push({ label: "Player act", items: [p.playerAct.concept] });
  if (p.feeling) details.push({ label: "Feeling", items: [`${p.feeling.label}${p.feeling.cause.trim() ? ` — ${p.feeling.cause.trim()}` : ""}`] });
  if (p.mindNote.trim()) details.push({ label: "Mind note", items: [p.mindNote.trim()] });
  if (p.sentPhoto) details.push({ label: "Photo", items: ["sent a selfie"] });
  const summary =
    [
      p.playerAct?.concept ? `act: ${p.playerAct.concept}` : "",
      p.feeling ? `feeling: ${p.feeling.label}` : "",
      p.mindNote.trim() ? "mind-note" : "",
      p.sentPhoto ? "sent photo" : "",
    ]
      .filter(Boolean)
      .join(" · ") || "no change";
  return { summary, details };
}

/**
 * Run the reaction pulse: one cheap structured agent call (the `runIntake` recipe —
 * reasoning off, latency-sorted routing, no repair, hard timeout) followed by the
 * deterministic curve. On timeout / parse failure / demo mode it degrades to
 * drift-only state with a `chat_state.pulse.degraded` diagnostic (the worst case is
 * exactly drift-only state — still "alive"). Uses the cheap AGENT model, never the
 * narrator model.
 */
export async function runChatPulse(input: ChatPulseInput): Promise<{ state: ChatState; degraded: boolean }> {
  const { state, profile, characterName, sink } = input;
  if (isDemoMode()) return { state: degradeState(state, sink, "demo mode"), degraded: true };

  const controller = new AbortController();
  const prompt = buildChatPulsePrompt({
    characterName,
    playerName: input.playerName,
    mindNote: state.mindNote,
    // The standing feeling, so the model can judge resolution ("neutral" clears)
    // instead of proposing blind.
    feeling: state.feeling.current,
    commitmentsDue: input.commitmentsDue,
    exchange: input.exchange,
  });
  const modelId = agentModelId();
  const reasoningProfile = await loadChatAgentReasoningProfile(input.trace?.chatId);
  const reasoning = agentReasoningPlan({
    profileId: reasoningProfile,
    leg: "pulse",
    maxOutputTokens: CHAT_PULSE_MAX_OUTPUT_TOKENS,
    timeoutMs: CHAT_PULSE_TIMEOUT_MS,
  });
  const telemetry: Partial<AgentTelemetry> = {
    legId: "chat_state.pulse",
    chatId: input.trace?.chatId,
    messageId: input.trace?.messageId,
    modelId,
    promptChars: CHAT_PULSE_SYSTEM.length + prompt.length,
    maxOutputTokens: reasoning.maxOutputTokens,
    reasoningProfile: reasoning.profileId,
    reasoningEnabled: reasoning.enabled,
  };
  const work = generateChecked<ChatPulse>({
    schema: chatPulseSchema,
    system: CHAT_PULSE_SYSTEM,
    prompt,
    modelId,
    temperature: 0,
    maxOutputTokens: reasoning.maxOutputTokens,
    code: "chat_state.pulse",
    sink,
    fallback: degradedChatPulse,
    signal: controller.signal,
    disableReasoning: !reasoning.enabled,
    providerOptions: reasoning.providerOptions,
    lowLatencyRouting: true,
    repair: false,
    degradeSeverity: "warn",
    telemetry,
  });

  const { value, degraded } = await withGenerateTimeout(
    work,
    controller,
    reasoning.timeoutMs,
    "chat_state.pulse.timeout",
    sink,
    telemetry,
    describeChatPulse,
  );
  if (!value || degraded) return { state: degradeState(state, sink, "pulse degraded"), degraded: true };
  if (input.scope === "opener") return { state: applyOpenerPulse(state, value).state, degraded: false };
  return { state: applyChatPulse(state, value, profile, characterName, input.activeSocialCards).state, degraded: false };
}

/** Drift-only fallback: keep the drifted state, stamp a degraded trace + the mandated diagnostic. */
function degradeState(state: ChatState, sink: DiagnosticSink | undefined, reason: string): ChatState {
  sink?.push(diag("warn", "chat_state.pulse.degraded", `pulse degraded (${reason}); persisting drift-only state`));
  return {
    ...state,
    lastPulseTrace: {
      concept: null,
      valence: null,
      regardDelta: 0,
      moodDelta: 0,
      arousalDelta: 0,
      changed: [],
      feeling: state.feeling.current?.label ?? null,
      regardScale: 1,
      sentPhoto: false,
      degraded: true,
      diagnostic: "chat_state.pulse.degraded",
    },
  };
}

 /** The archivist's outfit proposal shape — structural, so the fold never imports the schema type. */
interface OutfitProposal {
  description: string;
  /** The verbatim clause from this exchange stating the outfit changed ("" ⇒ no claim). */
  changeEvidence: string;
  exposed: boolean;
  removed: readonly string[];
  added: readonly string[];
}

/** The player's outfit proposal — the same, minus `exposed` (always computed). */
interface PlayerOutfitProposal {
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
async function foldOutfitProposal(args: {
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
async function foldPlayerOutfitProposal(args: {
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

/**
 * Close the turn: run the post-turn fan-out — the reaction pulse ‖ the
 * archivist-lite — in PARALLEL on the drifted state + the
 * just-finished exchange, write the extracted long-term memory (episode + facts), then
 * fold in the relationship samples/milestones + next turn's memory queries and persist (guarded). Called
 * from the chat route's stream finalizer after `persistAssistantReply`, so the whole
 * fan-out only delays `controller.close()` — invisible to perceived latency, and any leg
 * degrades to a diagnostic without touching the already-flushed reply.
 */
export async function finalizeChatState(input: {
  chatId: string;
  characterId: string;
  /** Chat owner — loads worn/pool items when the archivist proposes garment-level changes. */
  ownerId: string;
  /** The participant's memory group. */
  memoryGroupId: string;
  /** Provenance anchor: the assistant message row this exchange produced/updated. */
  assistantMessageId: string;
  /**
   * The STORED state as it stood before this exchange (null on a first exchange) —
   * persisted as the row's rollback snapshot so "another take" can undo the
   * exchange's drift + fan-out effects.
   */
  preExchangeState: ChatState | null;
  /**
   * Skip the reaction pulse (a "go on" continue beat has no player act to react
   * to); the archivist still runs — continued narrative is worth remembering.
   */
  skipPulse?: boolean;
  /**
   * Run the pulse OPENER-scoped: an initiative
   * opener with the selfie license armed needs the pulse's `sentPhoto` read (and
   * takes the mindNote refresh), but none of the curve's moves. Only meaningful
   * when `skipPulse` is false.
   */
  pulseScope?: "full" | "opener";
  promptMessageId: string;
  profile: CharacterProfile;
  characterName: string;
  playerName: string;
  /**
   * The player's persona sheet — the wardrobe pool the
   * archivist's `playerOutfit` deltas resolve against. Absent when the chat resolved to
   * the bare account name (no persona), in which case the player has no clothes to move
   * and the fold is a no-op.
   */
  playerPersona?: PersonaProfile;
  driftedState: ChatState;
  now: Date;
  exchange: { player: string; assistant: string };
  /**
   * The rolling summary as it stood for this exchange: the memory scribe reads
   * its durable ledger so a pronoun-heavy beat files
   * a fact naming the person instead of a dangling referent. Scribe-only — the other legs
   * judge the exchange itself. Absent on an early chat ⇒ no block.
   */
  priorSummary?: string;
  /** What RAG retrieved for THIS turn (from the route's pre-turn recall), for the debug trace. */
  retrieved?: { facts: string[]; episodes: string[]; detail?: RetrievedMemoryDetail[] };
  /**
   * This turn's selfie arming: the player asked, and/or the
   * unprompted-offer gates held. The pulse's `sentPhoto` read only queues a render
   * when one of these armed it — a hallucinated "sending you a pic" on an unarmed
   * turn stays fiction.
   */
  selfie?: { requested: boolean; offerEligible: boolean };
  /**
   * The roster with live presence — arms the archivist's presence-transition
   * field. Absent/single ⇒ 1-on-1, unchanged.
   */
  roster?: readonly { name: string; presence: "present" | "away" }[];
  /**
   * Present ensemble members' memory scopes beyond the primary's — each
   * character's memory is their own, so the ONE extraction files to every
   * present witness's own group. Deduped against the primary's group here.
   */
  extraMemoryWrites?: readonly { groupId: string; characterId: string }[];
  /**
   * The chat-wide scenario, ALREADY ticked/movement-switched for this exchange:
   * finalize merges the archivist's scene proposal onto it, clears the one-shot
   * skip note, and persists it beside the state.
   */
  scenario: ChatScenario;
  /** The scenario as stored before this exchange — the rollback anchor's other half. */
  preExchangeScenario: ChatScenario | null;
  /**
   * The garment cue memory this exchange's prompt surfaced: repeat keys + the
   * bands they were reported in + last-changed stamps.
   * Persisted onto the store so it rides ONE rollback anchor with the garments it
   * describes — a retake restores mention history and wardrobe together or not at
   * all. Absent (the `CHAT_GARMENT_CUES` default) ⇒ the store's memory is untouched.
   */
  garmentCueState?: GarmentCueState;
  /**
   * The AFFORDANCE cue memory this exchange's prompt surfaced: repeat keys, the
   * band each was last
   * reported in, and the story time each band moved. Persisted onto the SCENARIO
   * beside `environment`, so it rides `pre_exchange_scenario` with the state the
   * read was taken from — a retake restores both or neither, which is what makes
   * the rebuilt read byte-identical. Absent (the `CHAT_AFFORDANCE_CUES` default)
   * ⇒ the stored memory rides through untouched, never cleared.
   */
  affordanceCueState?: AffordanceCueState;
  /**
   * The CAPTURED effective-coverage read this exchange derived, keyed by garment
   * actor handle (the owner ruling: "effective coverage is captured, not
   * reconstructed").
   *
   * Merged onto the garment store rather than stored beside it, so one JSONB
   * value — one rollback anchor — carries the garments AND the derived answer
   * about what they still conceal. Absent ⇒ the prior capture rides through.
   */
  affordanceCoverage?: Readonly<Record<string, EffectiveCoverageRead>>;
  /**
   * The contact-effect proposals this exchange's DURABLY committed contact
   * derived (`CHAT_CONTACT_EFFECTS`, default off).
   * The body-surface owner transaction validates and commits them into the
   * primary's surface state HERE — after the wetness fold, inside the same
   * guarded state write — so a committed mark rides one rollback anchor with
   * the surface it lives on, and a retake restores or removes it with the cut.
   * Absent (the default) ⇒ the surface fold's result persists untouched.
   */
  contactMarkProposals?: readonly BodyMarkProposal[];
  /**
   * This exchange's conserved surface transfer: the PROPOSALS, not a
   * settlement. The owner transaction runs inside finalize,
   * on the surface the surrounding folds just produced.
   *
   * That is deliberate and it is the whole reason this is a proposal input. A
   * caller cannot settle a transfer itself, because the surface it would settle
   * against does not exist outside this function: the wetness, deposit and
   * pressure-mark folds all run here, and a `source` computed before them would
   * either discard those folds when persisted or have to be merged back
   * afterwards — a merge with no correct answer, since both sides edit the same
   * deposit records. Computing the transfer here means the value that gets
   * debited is byte-for-byte the value that gets written.
   *
   * A COMMITTED transfer moves the settle's writes inside ONE database
   * transaction (`persistSurfaceTransferSettlement`), because the conservation
   * law spans two rows and cannot be proven across independent statements.
   * Absent — or present but committing nothing, which is every refusal and every
   * duplicate retry — ⇒ every write below runs exactly as it always has. That
   * is the whole of production today: transfer is fixture-only under the
   * conservation law's escape clause, so no live caller sets this and the hot
   * settle path is untouched (owner ruling 2026-08-26).
   */
  surfaceTransfer?: ChatSurfaceTransferInput;
  sink?: DiagnosticSink;
}): Promise<{
  /** True when this exchange landed a stage crossing or strong reaction (slice 9 "auto at big moments"). */
  bigMoment: boolean;
  /** True when the reply sent a selfie (pulse-read + gate-armed) — the route queues the render. */
  selfieSend: boolean;
  /** The archivist's confirmed presence transitions (ensemble only; [] otherwise). `where` = an away departure's destination phrase. */
  presenceChanges: readonly { name: string; presence: "present" | "away"; where?: string }[];
  /**
   * Did this exchange's folds actually rewrite the PRIMARY character's / the
   * PLAYER's worn list? Reported because only the writer knows: the store carries
   * the final clothes and nothing about when they changed, and the reply-scene
   * contact leg refuses to date a touch against a wardrobe that moved during the
   * same reply.
   *
   * The comparison is the PROJECTION's, not the proposal's — the same rule the
   * ensemble members' `memberWornChanges` uses — so the free-text outfit fold,
   * the typed garment operations, and the lazy materialization that first models
   * an actor all report alike. Materialization reporting a change is a
   * conservative false positive by design: it costs one reply's contact start on
   * the exchange that first models a wardrobe, and the alternative is a material
   * claim nobody can date.
   */
  wardrobeChanged: { character: boolean; player: boolean };
}> {
  // Character-fidelity slices 7-10: arm the archivist's voice reads (voiceExemplar /
  // characterSlip) with a compact voice reference, and its trait-shift proposals with the
  // character's DEVELOPABLE traits at their current (authored + evolved) band. Intimate
  // traits are fenced for a minor, mirroring the prompt-builder fence.
  const lifeStage = lifeStageForAge(input.profile.age);
  const minor = lifeStage?.minor ?? false;
  const evolvedTraits = resolveTraits(input.profile.traits, input.driftedState.traitOverlays);
  const developableTraits = evolvedTraits.flatMap((t) => {
    const def = traitRegistry.byId(t.id);
    if (!def || def.mutability !== "developable" || (minor && def.intimate)) return [];
    return [{ id: def.id, label: def.label, band: traitRegistry.bandFor(def.id, t.value)?.label ?? "" }];
  });
  const anchors = input.profile.voiceAnchors;
  const voiceReference =
    hasVoiceAnchors(anchors) || (lifeStage?.registerRules.length ?? 0) > 0
      ? {
          petPhrases: anchors.petPhrases,
          cadence: anchors.cadence,
          neverSays: anchors.neverSays,
          registerRule: lifeStageThirdPersonLine(lifeStage, input.characterName),
        }
      : undefined;

  // Plans coming due: the DETERMINISTIC transitions are knowable from
  // the already-ticked clock before the fan-out, so the pulse — which runs in PARALLEL with
  // the archivist — can see a just-missed commitment and propose the hurt (consequences stay
  // model-mediated, ruling C: no deterministic regard penalty). The real fold below re-runs
  // the advance AFTER the archivist's kept/canceled land (which may spare an overdue plan).
  const planLabelCtx = { nowMinutes: input.scenario.clockMinutes, calendarStart: input.scenario.calendarStart };
  const planPhrase = (p: ChatPlan): string => {
    const others = planOthersLabel(p, input.playerName);
    const when = describePlanWhen(p.when, planLabelCtx);
    return `"${p.what}"${others ? ` ${others}` : ""}${when ? ` (${when})` : ""}`;
  };
  // The grounded wardrobe lane: the exact
  // garment/part handles this exchange may address. Built from the store as it
  // stands BEFORE the fan-out, because that is what the extractor's prompt shows.
  // Empty (an unmodelled chat, a first exchange) ⇒ the field never arms and the
  // legacy free-text grammar stands — which is exactly the bridge.
  //
  // "Here" is the place the exchange STARTED in, not wherever the archivist's
  // scene proposal moved them: the enumeration and the `left_here` locus then mean
  // one and the same room, so a garment dropped this exchange is re-findable by
  // exactly the handles the model was just shown.
  const scenePlaceName = currentScenePlace(input.scenario.sceneMemory)?.name;
  const garmentHandles = buildGarmentHandleTable({
    store: input.scenario.garments,
    actors: [
      { actorId: garmentActorForCharacter(input.characterId), label: input.characterName },
      { actorId: GARMENT_PLAYER_ACTOR, label: input.playerName || "you", slug: "you" },
    ],
    ...(scenePlaceName === undefined ? {} : { placeName: scenePlaceName }),
  });

  const preAdvance = advancePlans(input.scenario.plans, input.scenario.clockMinutes, input.playerName);
  const commitmentsDue =
    input.skipPulse || preAdvance.justMissed.length === 0
      ? undefined
      : { missed: preAdvance.justMissed.map(planPhrase), kept: [] as string[] };

  // The post-turn fan-out: the reaction pulse ‖ the three extraction legs (the memory
  // scribe, the continuity tracker, the character tracker), all in flight
  // together after the reply has already flushed.
  const [pulse, archivist] = await Promise.all([
    input.skipPulse
      ? Promise.resolve({ state: input.driftedState, degraded: false })
      : runChatPulse({
          state: input.driftedState,
          profile: input.profile,
          characterName: input.characterName,
          playerName: input.playerName,
          exchange: input.exchange,
          activeSocialCards: input.scenario.activeSocialCards,
          scope: input.pulseScope,
          commitmentsDue,
          trace: { chatId: input.chatId, messageId: input.assistantMessageId },
          sink: input.sink,
        }),
    runChatExtraction({
      characterName: input.characterName,
      playerName: input.playerName,
      exchange: input.exchange,
      openLoops: input.driftedState.openLoops,
      drives: input.driftedState.drives,
      roster: input.roster,
      supportingCast: input.scenario.supportingCast.map((m) => ({ name: m.name, relation: m.relation })),
      // Open commitments the archivist can mark kept/canceled.
      openPlans: input.scenario.plans
        .filter((p) => p.status === "upcoming")
        .map((p) => ({ what: p.what, who: p.participants.join(", "), when: describePlanWhen(p.when, planLabelCtx) })),
      developableTraits,
      voiceReference,
      // The in-scope garment handles — present ⇒ the
      // continuity leg proposes typed operations instead of free-text garments.
      garmentHandles,
      // The recap's ledger grounds the scribe's facts in NAMES (a pronoun-heavy
      // beat used to file a dangling referent).
      priorSummary: input.priorSummary,
      // Failure telemetry only — never reaches a prompt (agent-failure.ts).
      trace: { chatId: input.chatId, messageId: input.assistantMessageId },
      sink: input.sink,
    }),
  ]);

  // Write the extracted long-term memory (episode + facts) under the chat scope. Off the
  // reply path; degrades internally (a failed leg / embedding just adds a diagnostic) —
  // and additionally fenced here, because a hard infra throw in the memory write must
  // not cost the pulse's state changes: `saveChatState` below always runs.
  try {
    await writeChatMemory({
      groupId: input.memoryGroupId,
      characterId: input.characterId,
      assistantMessageId: input.assistantMessageId,
      archivist: archivist.value,
      sink: input.sink,
    });
  } catch (error) {
    input.sink?.push(
      diag(
        "warn",
        "chat_state.memory.write_failed",
        `long-term memory write failed; state still persisted: ${error instanceof Error ? error.message : String(error)}`,
      ),
    );
  }
  // Every present ensemble witness files the same extraction under their OWN
  // group (ruling 5) — separately fenced so one member's failed write never
  // costs another's, nor the state save below.
  const seenGroups = new Set([input.memoryGroupId]);
  for (const extra of input.extraMemoryWrites ?? []) {
    if (seenGroups.has(extra.groupId)) continue;
    seenGroups.add(extra.groupId);
    try {
      await writeChatMemory({
        groupId: extra.groupId,
        characterId: extra.characterId,
        assistantMessageId: input.assistantMessageId,
        archivist: archivist.value,
        sink: input.sink,
      });
    } catch (error) {
      input.sink?.push(
        diag(
          "warn",
          "chat_state.memory.write_failed",
          `ensemble member memory write failed: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
    }
  }

  // Record the meter bands the narrator saw THIS turn (from the drifted, pre-pulse meters)
  // as next turn's `prevBands`, so an unchanged state never re-fires a "just shifted" beat.
  // Carry the archivist's memory queries for the
  // next turn's RAG recall (drop them on a degraded archivist so stale queries don't linger),
  // and fold any proposed attribute change into the evolving narrative overlays.
  const surfacedCues = splitStateCues(input.driftedState.meters, input.driftedState.surfacedCues).nextBands;
  const attributeOverlays = archivist.value
    ? applyChatAttributeOverlays(input.driftedState.attributeOverlays, archivist.value.attributeChanges, input.sink)
    : input.driftedState.attributeOverlays;
  // Voice-exemplar ring: the archivist's picked in-voice line joins the ≤5 ring
  // (a "" pick / degraded archivist is a no-op via appendVoiceExemplar). Rolls back with the snapshot.
  const voiceExemplars = archivist.value
    ? appendVoiceExemplar(input.driftedState.voiceExemplars, archivist.value.voiceExemplar, input.scenario.clockMinutes)
    : input.driftedState.voiceExemplars;
  // Open loops are full-list-each-time — but a degraded leg emits an empty
  // list that must NOT wipe the standing loops; keep the prior list on degrade. Keyed on
  // the CHARACTER leg specifically: a failed scribe or continuity leg has
  // nothing to say about loops, and must not cost them.
  const openLoops =
    archivist.legs.character || !archivist.value ? input.driftedState.openLoops : archivist.value.openLoops;

  // Scene memory: reconcile the archivist's `scene` proposal onto the pre-turn memory (the
  // deterministic movement switch already applied to `scenario.sceneMemory` before the
  // prompt built). A degraded / empty proposal is a no-op, so the memory only ever accretes
  // what the fiction established — never re-establishing an unchanged setting.
  const sceneMemory = archivist.value
    ? mergeSceneMemory(input.scenario.sceneMemory, archivist.value.scene)
    : input.scenario.sceneMemory;

  // Supporting cast: same accrete-only shape as the
  // scene merge — a degraded/empty proposal is a no-op, and roster members + the
  // player can never be minted as cast entries (full characters stay full characters).
  const supportingCast = archivist.value
    ? mergeSupportingCast(input.scenario.supportingCast, archivist.value.cast, [
        input.playerName,
        input.characterName,
        ...(input.roster?.map((m) => m.name) ?? []),
      ])
    : input.scenario.supportingCast;

  // Plans: merge the archivist's struck/changed/canceled commitments
  // (new ids via `newId`), then advance deterministically as the ticked clock passes each
  // due-time — an overdue player plan the archivist did NOT resolve becomes `missed`, an
  // overdue NPC↔NPC plan is assumed kept (ruling E). A degraded archivist proposes nothing
  // but the plans still advance. Rolls back with the snapshot (ruling B).
  const planMerge = archivist.value
    ? mergeChatPlans(input.scenario.plans, archivist.value.plans, {
        nowMinutes: input.scenario.clockMinutes,
        mintId: newId,
        calendarStart: input.scenario.calendarStart,
      })
    : { plans: input.scenario.plans, archivistKept: [] as ChatPlan[] };
  const planAdvance = advancePlans(planMerge.plans, input.scenario.clockMinutes, input.playerName);
  const plans = planAdvance.plans;

  // Outfit change: the archivist proposes wardrobe changes two
  // ways, folded by `foldOutfitProposal`. A whole-outfit `description` naming an authored preset
  // ("her work clothes" → the "Work" preset) seeds the STRUCTURED worn list; an
  // unmatched description is a free-text full replacement. Garment-level `removed`/`added`
  // fold individual pieces against the loaded worn items + wardrobe pool. Empty
  // proposal / degraded archivist keeps the prior wardrobe; "another take" rolls it back via
  // the pre-exchange snapshot (wornItemIds/outfitPresetId ride `storedChatStateSchema`).
  //
  // Which of the two wardrobe-mutation paths runs is decided ONCE, for the whole
  // exchange: typed proposals win, and when they
  // are present the free-text folds are skipped entirely — so no actor is ever
  // mutated twice in one exchange.
  const lane = garmentMutationLane({
    garmentOperations: archivist.value?.garmentOperations ?? [],
    ...(archivist.value ? { outfit: archivist.value.outfit, playerOutfit: archivist.value.playerOutfit } : {}),
  });
  if (lane === "legacy") {
    input.sink?.push(
      diag(
        "info",
        "chat_garments.legacy_outfit_bridge",
        "no garment operations this exchange — folding the archivist's free-text outfit grammar through the legacy bridge",
      ),
    );
  }
  const outfitProposal = lane === "legacy" ? archivist.value?.outfit : undefined;
  const outfitChanged = Boolean(
    outfitProposal && (outfitProposal.description || outfitProposal.removed.length || outfitProposal.added.length),
  );
  // Either half of the exchange can state a whole-look change ("I peel off my
  // shirt" / "she tugs you out of your shirt" are the same event to the
  // archivist), so both are offered as evidence — but which half a quote came from
  // decides who "I"/"you" refers to, so they stay separate rather than joined.
  //
  // The scene shape decides the other half of the scoping: with a second body on
  // stage a bare pronoun cannot pick an owner, and the gate fails closed. The
  // roster carries the primary as its first entry (and is absent for 1-on-1), so
  // present OTHERS are what it contributes and the primary counts itself.
  const presentOthers = (input.roster ?? []).filter(
    (m) => m.presence === "present" && m.name.trim().toLowerCase() !== input.characterName.trim().toLowerCase(),
  );
  const presentOtherNames = presentOthers.map((m) => m.name);
  const presentCharacterCount = 1 + presentOthers.length;
  const outfitPatch = await foldOutfitProposal({
    profile: input.profile,
    ownerId: input.ownerId,
    state: input.driftedState,
    proposal: outfitProposal,
    exchange: input.exchange,
    evidenceOwner: {
      names: [input.characterName, ...input.profile.aliases],
      isPlayer: false,
      otherNames: [...presentOtherNames, input.playerName],
      presentCharacterCount,
    },
    sink: input.sink,
  });

  // The PLAYER's clothing — the same fold against the
  // persona's wardrobe. Chat-wide, so it lands on the scenario (and therefore on the
  // "another take" rollback snapshot) rather than the per-character state row. No
  // persona ⇒ no body to dress ⇒ a no-op.
  const playerOutfitPatch = await foldPlayerOutfitProposal({
    persona: input.playerPersona,
    ownerId: input.ownerId,
    playerState: input.scenario.playerState,
    proposal: lane === "legacy" ? archivist.value?.playerOutfit : undefined,
    exchange: input.exchange,
    evidenceOwner: {
      names: [input.playerName],
      isPlayer: true,
      otherNames: [input.characterName, ...input.profile.aliases, ...presentOtherNames],
      presentCharacterCount,
    },
    sink: input.sink,
  });

  // --- The garment store -----------------------------------------------------
  // The chat-wide store is the wardrobe TRUTH; the worn-id lists become its
  // projection. Both folds above still produce id lists — they are compiled here
  // into instance transfers (kept / re-donned with their condition / minted /
  // doffed to the wardrobe), never a free-text replacement of the wardrobe.
  //
  // Migration is lazy and happens on THIS write, never on a read: an
  // unseeded store first materializes from the PRE-fold worn sets, so a garment
  // this exchange took off exists at a locus rather than never having existed.
  const playerStateAfterFold: ChatPlayerState = { ...input.scenario.playerState, ...playerOutfitPatch };
  const garmentSync = await syncGarmentsForExchange({
    scenario: input.scenario,
    ownerId: input.ownerId,
    characterId: input.characterId,
    persona: input.playerPersona,
    preWornItemIds: input.driftedState.wornItemIds,
    postWornItemIds: outfitPatch.wornItemIds ?? input.driftedState.wornItemIds,
    playerStateAfterFold,
    sink: input.sink,
  });

  // --- Grounded garment operations (slice 5) ---------------------------------
  // The reconcile above lands first (so a garment this exchange's worn lists
  // added exists to be addressed), then the extractor's typed proposals apply in
  // FICTION ORDER on top, then the id projections are re-derived once. One store,
  // persisted once by the scenario save below — and discarded whole by a retake,
  // because it rides `pre_exchange_scenario` like every other scenario field.
  const proposals = lane === "operations" ? (archivist.value?.garmentOperations ?? []) : [];
  const garmentFold = applyGarmentProposals(proposals, {
    store: garmentSync.store,
    table: garmentHandles,
    atMinutes: input.scenario.clockMinutes,
    mintId: newId,
    ...(scenePlaceName === undefined ? {} : { placeName: scenePlaceName }),
    sink: input.sink,
  });
  // Mention history rides the store (slice 6): the cue memory the PROMPT produced,
  // written onto the POST-fold store so one JSONB value carries the wardrobe and
  // what has already been said about it. Flag off ⇒ the prior memory passes through.
  // The CAPTURED effective-coverage read rides the same value for the same
  // reason: it is derived from these garments,
  // at this cut, and restoring it one exchange out of step with them would give
  // narration, images, and a retake three different answers about what is still
  // concealed. Absent (the `CHAT_AFFORDANCE_CUES` default, or an unmodelled
  // wardrobe) ⇒ the prior capture passes through, never cleared.
  const garmentStore =
    input.garmentCueState || input.affordanceCoverage
      ? {
          ...garmentFold.store,
          ...(input.garmentCueState ? { cues: input.garmentCueState } : {}),
          ...(input.affordanceCoverage
            ? { coverage: { ...garmentFold.store.coverage, ...input.affordanceCoverage } }
            : {}),
        }
      : garmentFold.store;
  const wornItemIds =
    garmentFold.applied > 0
      ? garmentProjectionOr(garmentStore, garmentActorForCharacter(input.characterId), garmentSync.wornItemIds)
      : garmentSync.wornItemIds;
  const playerState: ChatPlayerState =
    garmentFold.applied > 0
      ? {
          ...garmentSync.playerState,
          wornItemIds: garmentProjectionOr(
            garmentStore,
            GARMENT_PLAYER_ACTOR,
            garmentSync.playerState.wornItemIds,
          ),
        }
      : garmentSync.playerState;
  const garmentTrace: GarmentOperationTraceEntry[] = garmentFold.trace;

  // --- Scene environment + body surface ---
  // The same shape as the garment fold above: a pure apply over typed proposals,
  // a trace, and diagnostics — never a re-read of the narrator's prose.
  //
  // The ENVIRONMENT is chat-wide and lands on the scenario (one sky for the
  // roster, and it rolls back with `pre_exchange_scenario`); the SURFACE is
  // per-character and lands on the state row. Both folds run on a degraded
  // archivist too, as no-ops: an absent proposal leaves the standing weather
  // standing, and the surface fold still prunes anything that has dried to
  // nothing — which cannot change what any read returns.
  //
  // PRIMARY CHARACTER ONLY this release (owner ruling). The player's surface
  // would ride `ChatScenario` (one player, many characters, like `playerState`);
  // an ensemble member's would ride their own row through the per-member personal
  // pass — neither is wired, and the extraction field says so in as many words.
  const environmentFold = applyEnvironmentProposal({
    environment: input.scenario.environment,
    ...(archivist.value ? { proposal: archivist.value.environment } : {}),
    atMinutes: input.scenario.clockMinutes,
  });
  // The environment patch lands FIRST and the surface fold integrates against
  // the result, so an exchange that opens a downpour holds this exchange's
  // wetness rather than drying it under the sky it was standing in a moment ago.
  const surfaceFold = applySurfaceWetnessProposals({
    surface: input.driftedState.bodySurface,
    proposals: parseSurfaceWetnessProposals(
      archivist.value?.surfaceWetness ?? [],
      input.sink,
      "chat_archivist.surfaceWetness",
    ),
    atMinutes: input.scenario.clockMinutes,
    environment: environmentFold.environment,
    sink: input.sink,
  });
  // Deposits fold next, onto the wetness fold's result — the same owner, one
  // more module, and no flag: material on skin is ordinary authoritative body
  // state exactly as wetness is, and gating it behind the contact-effects
  // switch would make "she still has mud on her hands" unrememberable for the
  // continuity system that has nothing to do with contact.
  //
  // No environment argument, and no prune pass: a deposit does not leave a
  // surface on its own, so there is nothing for the clock to integrate and an
  // empty proposal list returns the wetness fold's surface by reference.
  const depositFold = applySurfaceDepositProposals({
    surface: surfaceFold.surface,
    proposals: parseSurfaceDepositProposals(
      archivist.value?.surfaceDeposits ?? [],
      input.sink,
      "chat_archivist.surfaceDeposits",
    ),
    atMinutes: input.scenario.clockMinutes,
    sink: input.sink,
  });
  // --- Contact-effect owner transaction (`CHAT_CONTACT_EFFECTS`, default off) ---
  // The pressure-mark commit: the body-surface owner
  // validates each proposal against its own vocabulary and commits at most one
  // mark per idempotency identity. Runs AFTER the wetness fold so both modules
  // land in one state value under one rollback anchor, and only when the
  // pipeline actually derived proposals — the absent case leaves the fold's
  // result untouched, byte-identical to a build without the flag.
  const effectFold =
    input.contactMarkProposals !== undefined && input.contactMarkProposals.length > 0
      ? applyBodyMarkProposals({
          surface: depositFold.surface,
          proposals: input.contactMarkProposals,
          atMinutes: input.scenario.clockMinutes,
          ...(input.sink === undefined ? {} : { sink: input.sink }),
        })
      : { surface: depositFold.surface, trace: [] };
  // --- Conserved surface transfer ---
  // The second effect proof, and the one that spans owners: material leaves one
  // body's surface and lands on another body, or on a garment layer in between.
  //
  // It runs HERE, last in the fold chain and inside this function, because the
  // conservation law is a statement about exact quantities: the debit has to come
  // off the same surface value that gets persisted. `effectFold.surface` is that
  // value — it already carries this exchange's drying, deposits and pressure
  // marks — so settling against anything else (a copy loaded before the turn, say)
  // would either silently un-apply those folds on write or need a merge that has
  // no correct answer, both sides having edited the same deposit records.
  //
  // The layer side is `garmentStore` for the same reason: it is the post-fold,
  // about-to-be-persisted wardrobe, so an intermediate garment is credited on the
  // value the scenario write actually stores.
  const transferFold =
    input.surfaceTransfer !== undefined
      ? applySurfaceTransferProposals({
          proposals: input.surfaceTransfer.proposals,
          owners: {
            source: effectFold.surface,
            // Same character on both ends ⇒ ONE surface, and it must be the
            // folded one. The pure transaction warns it never assumes the pair
            // differs: handing it the caller's separately-loaded copy here would
            // fold the debit and the credit onto two stale objects and lose
            // whichever landed second.
            destination:
              input.surfaceTransfer.destination.characterId === input.characterId
                ? effectFold.surface
                : input.surfaceTransfer.destination.state.bodySurface,
            layers: garmentStore,
          },
          resolveLayer: input.surfaceTransfer.resolveLayer,
          atMinutes: input.scenario.clockMinutes,
          ...(input.sink === undefined ? {} : { sink: input.sink }),
        })
      : undefined;
  // Nothing committed ⇒ nothing crossed an owner boundary, so there is no
  // cross-row invariant to protect and the ordinary write path is the correct
  // one. This covers every refusal AND the designed duplicate retry, which is
  // exactly the case that must NOT look like a second transfer.
  const transferSettled =
    input.surfaceTransfer !== undefined && transferFold !== undefined && transferFold.committed > 0
      ? {
          bodySurface: transferFold.owners.source,
          garments: transferFold.owners.layers,
          // Absent when the material never left this character's own body: one
          // row, already written above as `bodySurface`.
          destination:
            input.surfaceTransfer.destination.characterId === input.characterId
              ? undefined
              : {
                  characterId: input.surfaceTransfer.destination.characterId,
                  state: {
                    ...input.surfaceTransfer.destination.state,
                    bodySurface: transferFold.owners.destination,
                  },
                  preExchangeState: input.surfaceTransfer.destination.preExchangeState,
                },
        }
      : undefined;
  const surfaceTrace: ChatSurfaceTraceEntry[] = [
    ...environmentFold.trace,
    ...surfaceFold.trace,
    ...depositFold.trace,
    ...effectFold.trace,
    // Refusals included: a transfer that was rejected is a thing the inspector
    // needs to see, and it contributes no entries at all when nobody proposed one.
    ...(transferFold?.trace ?? []),
  ];
  if (surfaceTrace.length > 0) {
    input.sink?.push(
      diag(
        "info",
        "chat_surface.applied",
        surfaceTrace.map((entry) => `${entry.kind}:${entry.target} ${entry.outcome}`).join(", "),
      ),
    );
  }

  // The familiarity ratchet (owner ruling: moments + time). One trickle tick per
  // exchange (bounded by the acquainted ceiling), plus a moment tick when the
  // archivist recorded durable facts — a real disclosure or shared experience.
  // Both draw from the per-scene budget (`familiaritySceneGain`).
  const preFamiliarity = input.preExchangeState?.familiarity ?? input.driftedState.familiarity;
  let familiarity = pulse.state.familiarity;
  let familiaritySceneGain = pulse.state.familiaritySceneGain;
  const applyTick = (kind: "trickle" | "moment") => {
    const ticked = tickFamiliarity(familiarity, kind, familiaritySceneGain);
    familiaritySceneGain += ticked - familiarity;
    familiarity = ticked;
  };
  applyTick("trickle");
  if ((archivist.value?.facts.length ?? 0) > 0) applyTick("moment");

  // Relationship arc: sample when the exchange moved regard or crossed a
  // band (or it's the first exchange — the sparkline's baseline), and derive the
  // exchange's milestones. When the pulse was skipped (a "go on" beat) or degraded,
  // `lastPulseTrace` is stale/empty — treat the move as zero rather than re-reading it.
  const at = input.now.toISOString();
  // "First exchange" for the arc baseline + first_exchange milestone:
  // no relationship sample has been recorded yet. Robust to a state row that
  // pre-exists the first send — a premise Save, an opening beat, a pickup skip all
  // create the row, so keying on `preExchangeState === null` would miss them and
  // silently skip the baseline sample + milestone.
  const firstExchange = input.driftedState.relationshipHistory.length === 0;
  const preRegard = input.preExchangeState?.regard ?? input.driftedState.regard;
  const postRegard = pulse.state.regard;
  const pulseTrace = input.skipPulse || pulse.state.lastPulseTrace.degraded ? null : pulse.state.lastPulseTrace;
  const moved = postRegard !== preRegard || familiarity !== preFamiliarity;
  const relationshipHistory =
    moved || firstExchange
      ? appendRelationshipSample(input.driftedState.relationshipHistory, {
          at,
          clockMinutes: input.scenario.clockMinutes,
          regard: postRegard,
          band: regardBandForValue(postRegard).id,
          familiarity,
        })
      : input.driftedState.relationshipHistory;
  const exchangeMilestones = deriveExchangeMilestones({
    at,
    messageId: input.assistantMessageId,
    characterName: input.characterName,
    firstExchange,
    preRegard,
    postRegard,
    preFamiliarity,
    postFamiliarity: familiarity,
    regardDelta: pulseTrace?.regardDelta ?? 0,
    concept: pulseTrace?.concept ?? null,
  });
  // Drive movement: fold the archivist's driveUpdates
  // into the runtime set; a degraded archivist keeps the prior drives (the loops
  // rule). Newly-revealed secrets land as `secret_shared` milestones — the spoken
  // reveal itself files as an ordinary extracted fact (ruled: no special wiring).
  const driveResult = archivist.value
    ? applyDriveUpdates(input.driftedState.drives, archivist.value.driveUpdates)
    : { drives: input.driftedState.drives, revealed: [] };
  for (const revealedDrive of driveResult.revealed) {
    exchangeMilestones.push({
      at,
      kind: "secret_shared",
      label: `${input.characterName} shared a secret — ${revealedDrive.want}`,
      messageId: input.assistantMessageId,
    });
  }
  // Plan resolutions land milestones: a kept/missed plan
  // INVOLVING THE PLAYER mints `plan_kept`/`plan_missed` — callback-boosted like
  // `secret_shared`, so "remember our first real date" emerges from the callback system.
  // NPC↔NPC keeps (assume-kept) carry no player milestone (they reach the story as facts).
  for (const kept of planMerge.archivistKept) {
    if (!planInvolvesPlayer(kept, input.playerName)) continue;
    exchangeMilestones.push({ at, kind: "plan_kept", label: `Kept a plan — ${kept.what}`, messageId: input.assistantMessageId });
  }
  for (const missed of planAdvance.justMissed) {
    exchangeMilestones.push({ at, kind: "plan_missed", label: `Missed a plan — ${missed.what}`, messageId: input.assistantMessageId });
  }
  const milestones = appendMilestones(input.driftedState.milestones, exchangeMilestones);
  // Bounded personality evolution (slice 10): apply the archivist's developable-trait
  // nudges ONLY when a relationship milestone landed this exchange (first_exchange is
  // not an arc beat), clamped one band from the authored value. Off-milestone turns and a
  // degraded archivist leave the overlays untouched.
  const milestoneLanded = exchangeMilestones.some((m) => m.kind !== "first_exchange");
  const traitOverlays =
    archivist.value && milestoneLanded
      ? applyChatTraitOverlays(input.profile.traits, input.driftedState.traitOverlays, archivist.value.traitShifts, { minor }, input.sink)
      : input.driftedState.traitOverlays;
  // Selfie send: the pulse read the reply as actually sending
  // a photo AND a deterministic gate armed it. Recording the send here (the cooldown
  // ring) rides the same guarded state write; "another take" rolls it back.
  const selfieKind =
    pulseTrace?.sentPhoto && input.selfie
      ? input.selfie.requested
        ? ("request" as const)
        : input.selfie.offerEligible
          ? ("offer" as const)
          : null
      : null;
  const selfieHistory = selfieKind
    ? appendSelfieEntry(input.driftedState.selfieHistory, { kind: selfieKind, atClockMinutes: input.scenario.clockMinutes })
    : input.driftedState.selfieHistory;
  // "Big moment" (slice 9 auto scenes): a stage crossing or a strong card-driven
  // reaction — not the routine first exchange, which has barely a scene to render.
  const bigMoment = exchangeMilestones.some((m) => m.kind === "stage_up" || m.kind === "stage_down" || m.kind === "strong_reaction");
  const lastMemoryTrace: ChatMemoryTrace = {
    retrievedFacts: input.retrieved?.facts ?? [],
    retrievedEpisodes: input.retrieved?.episodes ?? [],
    episodeSummary: archivist.value?.episodeSummary ?? "",
    factsAdded: archivist.value?.facts.length ?? 0,
    memoryQueries: archivist.value?.memoryQueries ?? [],
    attributeChanges: (archivist.value?.attributeChanges ?? []).map((c) => `${c.attributeId}=${String(c.value)}`),
    retrievedDetail: input.retrieved?.detail ?? [],
    // Every garment proposal's fate: proposed →
    // resolved → applied / no_change / rejected + code. Riding the memory trace
    // puts it in the admin inspector's existing view AND inside the rollback
    // snapshot, so a retake discards the record along with the operations.
    garmentOperations: garmentTrace,
    garmentLane: lane,
    // The MEMORY trace's degraded flag tracks the leg that owns memory (the scribe): its
    // other fields — summary, facts, queries — all come from that leg, so a failed
    // continuity/character leg must not flag the memory read as degraded.
    degraded: archivist.legs.memory,
    // Character-consistency corrective: this exchange's slip note (or "") rides the
    // trace so NEXT turn's prompt build renders a one-turn corrective tail; rolls back safely.
    characterSlip: archivist.value?.characterSlip ?? "",
  };
  // Presence transitions: the archivist's
  // confirmed reads. The primary's own transition folds into THIS save; the
  // caller applies the others' to their member states.
  const presenceChanges = archivist.value?.presence ?? [];
  const selfChange = presenceChanges.find(
    (p) => p.name.trim().toLowerCase() === input.characterName.trim().toLowerCase(),
  );
  const selfPresence = selfChange?.presence;
  // Whereabouts: a member who was PRESENT with a
  // pending whereabouts just spent it on this exchange's return license — clear it;
  // an away departure that named where it went records the phrase.
  const whereabouts =
    input.driftedState.presence === "present" && input.driftedState.whereabouts ? "" : pulse.state.whereabouts;
  const settledState: ChatState = {
    ...pulse.state,
    whereabouts,
    ...(selfPresence ? { presence: selfPresence } : {}),
    ...(selfPresence === "away" && selfChange?.where ? { whereabouts: selfChange.where } : {}),
    familiarity,
    familiaritySceneGain,
    surfacedCues,
    memoryQueries: archivist.value?.memoryQueries ?? [],
    openLoops,
    attributeOverlays,
    traitOverlays,
    voiceExemplars,
    lastMemoryTrace,
    relationshipHistory,
    milestones,
    selfieHistory,
    drives: driveResult.drives,
    // A committed transfer's DEBITED source surface wins over the effect fold's:
    // the owner transaction removed the transferred material
    // from it and wrote the idempotency receipt onto that same value, so
    // persisting the fold's copy instead would un-remove what was moved AND drop
    // the receipt, letting the next retry transfer the same material again.
    bodySurface: transferSettled?.bodySurface ?? effectFold.surface,
    ...outfitPatch,
    // The worn list is a PROJECTION of the garment store, re-derived
    // after the reconcile AND the typed operations above so the column can never
    // become a second truth.
    wornItemIds,
  };
  // The scenario save: the merged scene memory, the ticked
  // clock the pipeline already applied, and the one-shot skip note clearing —
  // guarded like the state save.
  const settledScenario: ChatScenario = {
    // Both one-shot notes clear together: the exchange that rendered the skip
    // note also rendered the meanwhile note.
    ...input.scenario,
    sceneMemory,
    supportingCast,
    plans,
    playerState,
    // The transfer's layer owner is the credited half of the same equation as
    // `bodySurface` above; the two must come from ONE settlement or conservation
    // is only half-recorded.
    garments: transferSettled?.garments ?? garmentStore,
    environment: environmentFold.environment,
    // Mention history rides the scenario beside the weather it was read
    // against. Flag off ⇒ the prior memory passes through, exactly as the
    // garment cue map does.
    ...(input.affordanceCueState ? { affordanceCues: input.affordanceCueState } : {}),
    pendingSkipNote: "",
    pendingMeanwhileNote: "",
  };
  // The rollback anchors ride targeted follow-up UPDATEs (never the shared upsert
  // column list — an author edit must not clobber them): repeated "another take"s
  // keep rolling back to the same pre-exchange point. Guarded on the same prompting
  // message as saveChatState, so a mid-stream delete leaves neither half written.
  //
  // Two persistence shapes, one ruling (2026-08-26). A settle that COMMITTED a
  // transfer moves all of this into ONE transaction, because conservation demands
  // the debit and the credit commit together and they live in two different rows. Every
  // other exchange — which is all of them today, transfer being fixture-only —
  // keeps the four independent writes exactly as they were: this is the hot path,
  // and there is no cross-row invariant to protect when nothing moved between rows.
  if (transferSettled !== undefined) {
    await persistSurfaceTransferSettlement({
      chatId: input.chatId,
      characterId: input.characterId,
      promptMessageId: input.promptMessageId,
      state: settledState,
      scenario: settledScenario,
      preExchangeState: input.preExchangeState,
      preExchangeScenario: input.preExchangeScenario,
      ...(transferSettled.destination === undefined ? {} : { destination: transferSettled.destination }),
    });
  } else {
    await saveChatState({
      chatId: input.chatId,
      characterId: input.characterId,
      promptMessageId: input.promptMessageId,
      state: settledState,
    });
    await saveChatScenario(input.chatId, settledScenario, input.promptMessageId);
    await savePreExchangeSnapshot(input.chatId, input.characterId, input.preExchangeState, input.promptMessageId);
    await savePreExchangeScenario(input.chatId, input.preExchangeScenario, input.promptMessageId);
  }

  // Location sketch: a current place without a
  // sketch gets one from the detached background agent. Enqueued AFTER the state write so
  // the job reads the just-merged memory; fire-and-forget (a lost write re-fires here
  // while the sketch stays absent).
  const sketchPlace = currentScenePlace(sceneMemory);
  if (sketchPlace && !sketchPlace.sketch) {
    void enqueueChatSceneSketch({
      chatId: input.chatId,
      characterId: input.characterId,
      characterName: input.characterName,
      placeName: sketchPlace.name,
    });
  }
  // Current-look refresh: the fiction re-dressed
  // the character or landed a lasting appearance change — mint a fresh look anchor.
  // The job itself gates on image-active chats + key match (ruled), so this enqueue
  // is cheap and idempotent; fire-and-forget after the state write it reads.
  //
  // The garment term is OQ8's pre/post KEY COMPARISON (audit Part 2), not a
  // proposal count: the trigger used to be proposal-shaped, so anything that moved
  // the wardrobe without an archivist outfit proposal left the anchor silently
  // stale — and adding bands to `chatLookKey` alone could never fix that, because
  // the enqueue and the key are independent gates. Both are wired now, off the same
  // fingerprint (worn instance set + structural bands + wetness from `wet` up +
  // deposit/damage presence). A damp→dry drift moves neither.
  // Per-actor rather than one combined call, because the wardrobe-chronology
  // veto below needs to know WHOSE look moved — the image refresh only needs
  // "anyone's".
  const characterLookChanged = chatGarmentLookChanged({
    before: input.scenario.garments,
    after: garmentStore,
    actorIds: [garmentActorForCharacter(input.characterId)],
    atMinutes: input.scenario.clockMinutes,
  });
  const playerLookChanged = chatGarmentLookChanged({
    before: input.scenario.garments,
    after: garmentStore,
    actorIds: [GARMENT_PLAYER_ACTOR],
    atMinutes: input.scenario.clockMinutes,
  });
  const lookChanged = characterLookChanged || playerLookChanged;
  if (outfitChanged || lookChanged || (archivist.value?.attributeChanges.length ?? 0) > 0) {
    void enqueueChatLookImage({ chatId: input.chatId, characterId: input.characterId });
  }
  return {
    bigMoment,
    selfieSend: selfieKind !== null,
    presenceChanges,
    // Two signals OR-ed per body, because they see different change vectors: the
    // worn-id comparison catches set changes on a wardrobe the look key cannot
    // see (an actor with no garment instances — the lazy-materialization and
    // legacy paths), while the look key catches STATE changes that move no id at
    // all — a soaked blouse, a displaced hem, a damage mark — which shift the
    // coverage a contact's material read would compose. Either one is a wardrobe
    // this reply authoritatively moved, and a same-reply contact start must not
    // date its material against it.
    wardrobeChanged: {
      character: wornItemIds.join(",") !== input.driftedState.wornItemIds.join(",") || characterLookChanged,
      player:
        playerState.wornItemIds.join(",") !== input.scenario.playerState.wornItemIds.join(",") ||
        playerLookChanged,
    },
  };
}

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
    const firstExchange = next.relationshipHistory.length === 0;
    const moved = next.regard !== args.preRegard;
    if (moved || firstExchange) {
      next = {
        ...next,
        relationshipHistory: appendRelationshipSample(next.relationshipHistory, {
          at,
          clockMinutes: args.clockMinutes,
          regard: next.regard,
          band: regardBandForValue(next.regard).id,
          familiarity: next.familiarity,
        }),
      };
    }
    const trace = next.lastPulseTrace.degraded ? null : next.lastPulseTrace;
    exchangeMilestones.push(
      ...deriveExchangeMilestones({
        at,
        messageId: args.assistantMessageId,
        characterName: args.characterName,
        firstExchange,
        preRegard: args.preRegard,
        postRegard: next.regard,
        preFamiliarity: next.familiarity,
        postFamiliarity: next.familiarity,
        regardDelta: trace?.regardDelta ?? 0,
        concept: trace?.concept ?? null,
      }),
    );
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
    for (const revealedDrive of driveResult.revealed) {
      exchangeMilestones.push({
        at,
        kind: "secret_shared",
        label: `${args.characterName} shared a secret — ${revealedDrive.want}`,
        messageId: args.assistantMessageId,
      });
    }
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