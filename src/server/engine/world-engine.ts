import type { ItemTransferNarrativeCut } from "@/contracts/simulation/item-transfer";
import {
  appendItemTransferNarrativeCut,
  type ItemTransferPresentationVariant,
} from "@/lib/simulation";
import {
  buildCharacterChatSystemPrompt,
  type CharacterChatPromptInput,
} from "./prompts/character-chat";

/**
 * Gate 1 bridge into the narrator already used by character chat. The cut is
 * compiled before this call; this adapter has no state authority and rerendering
 * it cannot submit commands or write memory.
 */
export function buildCharacterChatPromptForNarrativeCut(
  input: CharacterChatPromptInput,
  cut: ItemTransferNarrativeCut,
  presentationVariant: ItemTransferPresentationVariant = "default",
): string {
  return appendItemTransferNarrativeCut(
    buildCharacterChatSystemPrompt(input),
    cut,
    presentationVariant,
  );
}
