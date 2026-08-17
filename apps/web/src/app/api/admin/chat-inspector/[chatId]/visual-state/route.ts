import { jsonOk } from "@/server/api";
import {
  isSimRoutedAuthority,
  previewChatVisualState,
  previewSimVisualState,
  readChatEngineAuthority,
} from "@/server/engine";
import { withSelfOwnedChat } from "../../owned";

type Params = { chatId: string };

/**
 * The READ-ONLY visual-state inspector for an owner-admin's own chat
 * (visual-state.plan.md slice 6; spec §Consumer digests — "the inspector
 * exposes the complete source-to-selection staircase without changing state").
 *
 * Serves BOTH lanes from one route: a sim-routed chat previews the successor
 * assembly against its branch, everything else previews the legacy chat cut.
 * Computes on demand and stores NOTHING — the observer-memory load is
 * read-only under a nonce guard, no notice or mention state is spent, and
 * `CHAT_VISUAL_STATE_SHADOW` is reported rather than obeyed. Same self-scoped
 * boundary as every other inspector handler.
 */
export const GET = withSelfOwnedChat<Params>(async (_user, owned) => {
  const authority = await readChatEngineAuthority(owned.chat.id);
  if (isSimRoutedAuthority(authority)) {
    return jsonOk(
      await previewSimVisualState({
        chatId: owned.chat.id,
        branchId: authority.simBranchId,
        playerActorId: authority.simPlayerActorId,
        primaryActorId: authority.simPrimaryActorId,
      }),
    );
  }
  return jsonOk(
    await previewChatVisualState({
      chatId: owned.chat.id,
      memoryGroupId: owned.participant.memoryGroupId,
      character: { id: owned.character.id, name: owned.character.name, profile: owned.character.profile },
    }),
  );
});
