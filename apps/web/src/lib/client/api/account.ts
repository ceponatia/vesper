import { z } from "zod";

import { apiGet, apiPatch } from "./http";
import { optionalId, textOr } from "./shared";

// ---------------------------------------------------------------------------
// Account / default persona
// ---------------------------------------------------------------------------

export const meSchema = z.object({
  /** The account display name — the resolver's last rung before FALLBACK_PLAYER_NAME. */
  accountName: textOr(""),
  /** Which persona new chats start as; null ⇒ none picked (chats fall back to the account name). */
  defaultPersonaId: optionalId,
  /** The account's own role — lets admin-only settings pages explain themselves, never a gate. */
  role: z.string().catch("user"),
});
export type Me = z.infer<typeof meSchema>;

export const meApi = {
  get: () => apiGet(meSchema, "/api/users/me"),
  /** Set (or clear, with null) the persona new chats start as. */
  setDefaultPersona: (defaultPersonaId: string | null) =>
    apiPatch(z.object({ defaultPersonaId: optionalId }), "/api/users/me", {
      defaultPersonaId,
    }),
};
