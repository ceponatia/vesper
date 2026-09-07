import type { ChatState, ChatScenario } from "./types";
import { persistSurfaceTransferSettlement } from "./surface-transfer";
import { saveChatState, saveChatScenario } from "./store";
import { savePreExchangeSnapshot, savePreExchangeScenario } from "./snapshots";
import type { FinalizeChatStateInput } from "./finalize-types";
import type { FinalizationSurface } from "./surface-fold";

type PersistFinalizationInput = Pick<
  FinalizeChatStateInput,
  "chatId"
  | "characterId"
  | "promptMessageId"
  | "preExchangeState"
  | "preExchangeScenario"
>;

export async function persistFinalization(
  input: PersistFinalizationInput,
  settledState: ChatState,
  settledScenario: ChatScenario,
  transferSettled: FinalizationSurface["transferSettled"],
) {
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


}
