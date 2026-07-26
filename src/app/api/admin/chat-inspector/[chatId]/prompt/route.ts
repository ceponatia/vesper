import { jsonOk } from "@/server/api";
import { previewChatPrompt } from "@/server/engine";
import { withSelfOwnedChat } from "../../owned";

type Params = { chatId: string };

/** Rebuild the narrator prompt for an owner-admin's own chat only. */
export const GET = withSelfOwnedChat<Params>(async (_user, owned) =>
  jsonOk(
    await previewChatPrompt({
      chatId: owned.chat.id,
      memoryGroupId: owned.participant.memoryGroupId,
      character: { id: owned.character.id, name: owned.character.name, profile: owned.character.profile },
    }),
  ),
);
