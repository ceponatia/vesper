import { z } from "zod";

/**
 * Client data layer (docs/streaming-api.md, docs/ui/conventions.md): typed
 * fetch helpers over the route-handler API. Every response crosses a trust boundary, so it
 * is parsed with forgiving schemas — unknown fields are stripped, bad fields
 * fall back, bad list elements are dropped. Errors use the
 * `{ error: { code, message } }` envelope.
 *
 * This module is client-safe: it imports only pure contracts and `zod`.
 */
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

// Type alias (not interface) so it satisfies withQuery's index signature.
