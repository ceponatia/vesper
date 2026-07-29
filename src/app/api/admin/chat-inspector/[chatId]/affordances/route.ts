import { jsonOk } from "@/server/api";
import { previewChatAffordances } from "@/server/engine";
import { withSelfOwnedChat } from "../../owned";

type Params = { chatId: string };

/**
 * The READ-ONLY affordance preview for an owner-admin's own chat
 * (body-attribute-affordances.spec.architecture.md §Resolved, "Developer
 * preview"): the staged calculation — source inputs → structural profile →
 * mechanics → observations or suppression reason → perception filtering →
 * selected cue — for every domain this lane can feed.
 *
 * Computes on demand and stores NOTHING: no cue memory is spent, no condition is
 * integrated forward into the store, and the `CHAT_AFFORDANCE_CUES` flag is
 * reported rather than obeyed (a developer asking why a read said nothing needs
 * the answer with the flag off too). Same self-scoped boundary as every other
 * inspector handler.
 */
export const GET = withSelfOwnedChat<Params>(async (_user, owned) =>
  jsonOk(
    await previewChatAffordances({
      chatId: owned.chat.id,
      character: { id: owned.character.id, name: owned.character.name, profile: owned.character.profile },
    }),
  ),
);
