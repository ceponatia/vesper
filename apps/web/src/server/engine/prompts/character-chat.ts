import { buildEnsembleChatPromptParts } from "./character-chat/ensemble";
import { buildCharacterChatPromptParts } from "./character-chat/single";
import type { CharacterChatPromptInput, CharacterChatPromptParts, EnsembleMemberInput, EnsemblePromptExtras } from "./character-chat/types";

export type { CharacterChatPromptInput, CharacterChatPromptParts, CharacterChatPromptNodes, EnsembleMemberInput, EnsemblePairInput, EnsemblePromptExtras } from "./character-chat/types";
export { buildCharacterChatPromptNodes, buildCharacterChatPromptParts, buildCharacterChatSystemPrompt } from "./character-chat/single";
export { buildEnsembleChatPromptNodes, buildEnsembleChatPromptParts, ENSEMBLE_QUIET_EXCHANGES, ensembleQuietThreshold } from "./character-chat/ensemble";
export { AFFORDANCE_CUE_BLOCK_HEADING, VISUAL_STATE_CONSTRAINT_BLOCK_HEADING, VISUAL_STATE_CUE_BLOCK_HEADING, chatAffordanceCueCarveOut, chatVisualStateCueCarveOut } from "./character-chat/sensory-sections";
export { buildChatTurnMessage, chatCallbackLine, chatNotationNote, chatSelfieLine, chatSkipNote, ensembleCallbackLine, narratorInputHeader, narratorInputNote, wrapNarratorInput } from "./character-chat/turn-notes";

/**
 * Dispatch on roster size (ruling 2): a roster of one takes the EXACT single-character
 * path — byte-identical to today's prompt — and only a real ensemble builds the frame.
 */
export function buildChatPromptPartsForRoster(
  input: CharacterChatPromptInput,
  members?: readonly EnsembleMemberInput[],
  extras?: EnsemblePromptExtras,
): CharacterChatPromptParts {
  if (!members || members.length <= 1) return buildCharacterChatPromptParts(input);
  return buildEnsembleChatPromptParts(input, members, extras);
}
