import { jsonOk } from "@/server/api";
import { previewChatPhysicalGuidance } from "@/server/engine";
import { withSelfOwnedChat } from "../../owned";

type Params = { chatId: string };

/**
 * The READ-ONLY narrator physical-guidance preview for an owner-admin's own chat
 * (narrator-physical-guidance.plan.md slice 2): the staircase — input authority →
 * committed state → candidates → disclosure and selection → rendered instruction —
 * for the stored cut and the newest player line.
 *
 * Computes on demand and stores NOTHING: guidance is recomputed every turn by design,
 * so a preview is simply a second evaluation and cannot spend anything. The
 * `CHAT_PHYSICAL_CONSTRAINTS` flag is reported rather than obeyed (a developer asking
 * why a fence never appeared needs the answer with the flag off too). Same self-scoped
 * boundary as every other inspector handler.
 */
export const GET = withSelfOwnedChat<Params>(async (_user, owned) =>
  jsonOk(
    await previewChatPhysicalGuidance({
      chatId: owned.chat.id,
      character: { id: owned.character.id, name: owned.character.name, profile: owned.character.profile },
    }),
  ),
);
