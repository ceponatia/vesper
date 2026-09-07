import type { CharacterProfile, DiagnosticSink } from "@/contracts";
import type { NarratorPromptNode } from "@/contracts/narrator-prompts";
import { loadChatRelationships } from "./chat-relationships";
import type { detectSensoryFocus } from "./chat-intent";
import type { retrieveChatMemory } from "./chat-memory";
import type { ChatScenario, ChatState } from "./chat-state/types";
import type { ResolvedChatWardrobe } from "./chat-wardrobe";
import type { buildChatGarmentNarration } from "./chat-garments";
import type { loadVerbatimWindow } from "./chat-summary";
import {
  buildCharacterChatPromptNodes,
  buildCharacterChatPromptParts,
  buildCharacterChatSystemPrompt,
  buildChatPromptPartsForRoster,
  buildChatTurnMessage,
  buildEnsembleChatPromptNodes,
  wrapNarratorInput,
  ENSEMBLE_QUIET_EXCHANGES,
  type CharacterChatPromptInput,
  type EnsembleMemberInput,
  type EnsemblePairInput,
  type EnsemblePromptExtras,
} from "./prompts/character-chat";
import { chatPromptLayout } from "./prompts/constants";
import { promptStateSlice } from "./chat-prompt-input";
import type { PlayerPersona } from "../players";
import type { ChatTurnMember } from "./chat-turn-types";

export async function prepareChatTurnPrompt(args: {
  chatId: string;
  characterId: string;
  characterName: string;
  sink: DiagnosticSink;
  profile: CharacterProfile;
  driftedState: ChatState;
  scenario: ChatScenario;
  others: ChatTurnMember[];
  promptInput: CharacterChatPromptInput;
  playerContent: string;
  syntheticCue: string | null;
  narratorInput: boolean;
  history: Awaited<ReturnType<typeof loadVerbatimWindow>>;
  player: PlayerPersona;
  ensembleActive: boolean;
  memory: Awaited<ReturnType<typeof retrieveChatMemory>>;
  otherMemories: Map<string, Awaited<ReturnType<typeof retrieveChatMemory>>>;
  sensoryFocus: Exclude<ReturnType<typeof detectSensoryFocus>, null> | undefined;
  sensoryFocusMember: { id: string; name: string; aliases: string[] } | undefined;
  selfieRequested: boolean;
  selfieTargetOther: ChatTurnMember | undefined;
  selfieOfferEligible: boolean;
  ensembleCallback: { summary: string; memberName: string; regard: number } | undefined;
  wardrobe: ResolvedChatWardrobe;
  memberWardrobe: (member: ChatTurnMember) => Promise<ResolvedChatWardrobe>;
  garmentNarration: ReturnType<typeof buildChatGarmentNarration> | null;
}) {
  const {
    chatId,
    characterId,
    characterName,
    sink,
    profile,
    driftedState,
    scenario,
    others,
    promptInput,
    playerContent,
    syntheticCue,
    narratorInput,
    history,
    player,
    ensembleActive,
    memory,
    otherMemories,
    sensoryFocus,
    sensoryFocusMember,
    selfieRequested,
    selfieTargetOther,
    selfieOfferEligible,
    ensembleCallback,
    wardrobe,
    memberWardrobe,
    garmentNarration,
  } = args;

  // The relationship matrix: tier-1 pair lines for
  // present×present edges; tier-3 conditional lines for present→away edges
  // whose away endpoint is SALIENT — mentioned within the window (the recency
  // stamp keeps counting for away members) or flagged looming on the edge.
  let ensembleExtras: EnsemblePromptExtras | undefined;
  if (ensembleActive) {
    const matrix = await loadChatRelationships(chatId, sink);
    const membersById = new Map<string, { name: string; presence: ChatState["presence"]; quiet: number }>([
      [characterId, { name: characterName, presence: driftedState.presence, quiet: driftedState.quietExchanges }],
      ...others.map(
        (o) =>
          [o.characterId, { name: o.name, presence: o.state.presence, quiet: o.state.quietExchanges }] as const,
      ),
    ]);
    const pairs: EnsemblePairInput[] = [];
    const awayPairs: EnsemblePairInput[] = [];
    for (const edge of matrix) {
      const from = membersById.get(edge.fromCharacterId);
      const to = membersById.get(edge.toCharacterId);
      if (!from || !to) continue; // an endpoint left the roster — the row is inert
      if (from.presence === "present" && to.presence === "present") {
        pairs.push({ fromName: from.name, toName: to.name, record: edge.record });
      } else if (from.presence === "present" && to.presence === "away") {
        const salient = to.quiet < ENSEMBLE_QUIET_EXCHANGES || edge.record.looming;
        if (salient) awayPairs.push({ fromName: from.name, toName: to.name, record: edge.record });
      }
    }
    // The solo perks' group arms (followups ruling 12): each names the ONE
    // member it aims at, so the frame renders the license in third person.
    ensembleExtras = {
      // The same frozen source the 1-on-1 build gets: an ensemble reply follows the
      // owner's craft instructions while the roster, the presence law and the
      // `[Name]` tag contract stay exactly where they are.
      instructionSource: promptInput.instructionSource,
      pairs,
      awayPairs,
      ...(selfieRequested
        ? { selfie: { kind: "request" as const, memberName: selfieTargetOther?.name ?? characterName } }
        : selfieOfferEligible
          ? { selfie: { kind: "offer" as const, memberName: characterName } }
          : {}),
      ...(ensembleCallback ? { callback: ensembleCallback } : {}),
      ...(sensoryFocus && sensoryFocusMember
        ? { sensoryFocus: { hint: sensoryFocus, memberName: sensoryFocusMember.name } }
        : {}),
    };
  }

  // The ensemble prompt inputs (roster > 1): the primary first, then the others,
  // each with their own state slice + memory leg and the presence/recency the
  // frame's tier compression keys on.
  const ensemble: EnsembleMemberInput[] | undefined = ensembleActive
    ? [
        {
          name: characterName,
          profile,
          state: promptStateSlice(driftedState, scenario, wardrobe, profile, garmentNarration),
          memory,
          presence: driftedState.presence,
          quietExchanges: driftedState.quietExchanges,
        },
        // Each present member resolves their OWN worn state — same
        // owner library, so the shared loader keys their garments too. Through the
        // shared cache: a member the contact leg already resolved this turn renders
        // from that SAME resolve rather than a second one.
        ...(await Promise.all(
          others.map(async (o) => ({
            name: o.name,
            profile: o.profile,
            state: promptStateSlice(o.state, scenario, await memberWardrobe(o), o.profile),
            memory: otherMemories.get(o.characterId),
            presence: o.state.presence,
            quietExchanges: o.state.quietExchanges,
          })),
        )),
      ]
    : undefined;

  // Prompt layout (default `system_tail`): the
  // experimental `turn_context` layout sends system = stable prefix only and moves the
  // volatile tail + the fenced current input into a final user message (the session
  // lane's shape), so system + history form an append-only cached prefix. Real player
  // turns only — opening/continue beats have no current input to compose around.
  // An ensemble always takes the classic layout (the A/B experiment is 1-on-1-scoped).
  // Narrator-mode lines carry their marker into the MODEL history only (the stored
  // rows stay byte-verbatim) — so past authored narration never re-reads as the
  // player's own words on later turns.
  const markedHistory = history.map((m) =>
    m.role === "user" && m.narrator ? { ...m, content: wrapNarratorInput(m.content, player.name) } : m,
  );
  let system: string;
  let modelHistory: typeof history;
  /**
   * The whole assembled narrator prompt — prefix AND tail, whatever transport
   * each carries. `assembledSystemHash` identifies the assembly, so it must not
   * change meaning when the `turn_context` layout moves the tail beside the
   * player's input; that is a placement decision, not a different prompt.
   */
  let assembledNarratorPrompt: string;
  if (ensemble) {
    const parts = buildChatPromptPartsForRoster(promptInput, ensemble, ensembleExtras);
    system = [parts.prefix, parts.tail].filter(Boolean).join("\n\n");
    assembledNarratorPrompt = system;
    modelHistory = syntheticCue ? [...markedHistory, { role: "user" as const, content: syntheticCue }] : markedHistory;
  } else if (chatPromptLayout() === "turn_context" && playerContent) {
    const parts = buildCharacterChatPromptParts(promptInput);
    system = parts.prefix;
    assembledNarratorPrompt = [parts.prefix, parts.tail].filter(Boolean).join("\n\n");
    // The window's last entry is the current player message (inserted before the window
    // loaded); it moves into the composed final message, so drop it from what we send.
    const priorHistory = markedHistory.at(-1)?.role === "user" ? markedHistory.slice(0, -1) : markedHistory;
    modelHistory = [
      ...priorHistory,
      {
        role: "user" as const,
        content: buildChatTurnMessage(
          parts.tail,
          narratorInput ? wrapNarratorInput(playerContent, player.name) : playerContent,
          player.name,
        ),
      },
    ];
  } else {
    system = buildCharacterChatSystemPrompt(promptInput);
    assembledNarratorPrompt = system;
    modelHistory = syntheticCue ? [...markedHistory, { role: "user" as const, content: syntheticCue }] : markedHistory;
  }

  /**
   * The classified node trees behind the prompt just built — the provenance's
   * per-authority weights and, on production, the hash of the instruction text a
   * test prompt would have replaced. Rebuilt rather than threaded because the
   * builders own the byte-pinned assembly and must keep owning it; this is a pure
   * tree walk with no IO, and it runs once, only on a reply that actually settled.
   */
  const narratorPromptNodes = (): readonly NarratorPromptNode[] => {
    const nodes = ensemble
      ? buildEnsembleChatPromptNodes(promptInput, ensemble, ensembleExtras)
      : buildCharacterChatPromptNodes(promptInput);
    return [...nodes.prefix, ...nodes.tail];
  };
  return { system, modelHistory, assembledNarratorPrompt, narratorPromptNodes };
}
