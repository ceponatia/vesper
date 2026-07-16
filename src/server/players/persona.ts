import { and, eq } from "drizzle-orm";
import { emptyPersonaProfile, personaProfileSchema, type PersonaProfile } from "@/contracts";
import { chatPlayerStateSchema, emptyChatPlayerState } from "@/contracts";
import { parseOr } from "@/lib/parse";
import { characterChats, db, personas, users } from "@/server/db";

/**
 * The resolved player identity every consumer reads through — the user-level analog of
 * the session's `bundlePlayerName()` (engine/bundle.ts).
 *
 * **`title` is deliberately not a field here.** That is what keeps the persona's
 * per-owner-unique library label away from agents — not a rule anyone has to remember,
 * but the shape itself: every prompt consumer reads this type, so there is no path for
 * a title to reach a model without someone adding a field (persona-library.plan.md).
 */
export interface PlayerPersona {
  /** The resolved `personas.id`; null when nothing resolved and we fell back to the account name. */
  id: string | null;
  /** Never empty — the persona's name, else the account display name. */
  name: string;
  /**
   * The persona's bio. A convenience alias for `profile.bio` under the field name the
   * chat prompt seam has always used; empty ⇒ undefined so the block is simply omitted.
   */
  persona?: string;
  /** The full sheet — body, wardrobe, voice, intimacy. Absent when no persona resolved. */
  profile?: PersonaProfile;
}

/** Ultimate fallback name when neither a persona nor an account name resolves (degenerate). */
export const FALLBACK_PLAYER_NAME = "the visitor";

/** The columns the resolver reads off a persona row. */
export interface PersonaRow {
  id: string;
  name: string;
  profile: unknown;
}

/**
 * Pure resolution: an account name + the persona row that won the ladder (or null).
 * Never throws — a malformed profile `parseOr`s to empty and the name falls back to the
 * account name, then {@link FALLBACK_PLAYER_NAME}. Extracted from the queries so the
 * degradation path is unit-testable without Postgres (docs/resilience.md).
 */
export function personaFromRow(accountName: string | undefined, row: PersonaRow | null): PlayerPersona {
  if (!row) {
    return { id: null, name: accountName?.trim() || FALLBACK_PLAYER_NAME };
  }
  const profile = parseOr(personaProfileSchema, row.profile, emptyPersonaProfile(), undefined, "personas.profile");
  const name = row.name.trim() || accountName?.trim() || FALLBACK_PLAYER_NAME;
  const bio = profile.bio.trim() || undefined;
  return { id: row.id, name, ...(bio === undefined ? {} : { persona: bio }), profile };
}

/** Owner-strict persona lookup — a foreign or deleted id resolves to null, never an error. */
async function loadPersona(ownerId: string, personaId: string): Promise<PersonaRow | null> {
  if (!personaId.trim()) return null;
  const [row] = await db()
    .select({ id: personas.id, name: personas.name, profile: personas.profile })
    .from(personas)
    .where(and(eq(personas.id, personaId), eq(personas.ownerId, ownerId)))
    .limit(1);
  return row ?? null;
}

/** The chat's own persona pick, "" when the chat has none (or the id is unreadable). */
export async function chatPersonaId(chatId: string): Promise<string> {
  const [row] = await db()
    .select({ playerState: characterChats.playerState })
    .from(characterChats)
    .where(eq(characterChats.id, chatId))
    .limit(1);
  if (!row) return "";
  return parseOr(chatPlayerStateSchema, row.playerState, emptyChatPlayerState(), undefined, "character_chats.player_state")
    .personaId;
}

/**
 * Resolve who the player is, for a chat or for the account at large
 * (persona-library.plan.md slice 6). A three-rung ladder, each rung degrading rather
 * than throwing, so a turn always has someone to address (docs/resilience.md):
 *
 * 1. the **chat's** picked persona (`player_state.personaId`), when `chatId` is given;
 * 2. the owner's **default** persona (`users.default_persona_id`) — so one-time setup
 *    still works and the per-chat pick is an override, not a chore;
 * 3. the **account name** (then {@link FALLBACK_PLAYER_NAME}).
 *
 * Every lookup is owner-strict, so a dangling/foreign id just misses and falls through.
 */
export async function resolveChatPersona(args: { ownerId: string; chatId?: string }): Promise<PlayerPersona> {
  const [account] = await db()
    .select({ name: users.name, defaultPersonaId: users.defaultPersonaId })
    .from(users)
    .where(eq(users.id, args.ownerId))
    .limit(1);

  const picked = args.chatId ? await chatPersonaId(args.chatId) : "";
  const row =
    (picked ? await loadPersona(args.ownerId, picked) : null) ??
    (account?.defaultPersonaId ? await loadPersona(args.ownerId, account.defaultPersonaId) : null);

  return personaFromRow(account?.name, row);
}

/**
 * The account-level persona (no chat context) — the owner's default, else their account
 * name. Prefer {@link resolveChatPersona} with a `chatId` wherever a conversation is in
 * scope, so the per-chat pick is honoured.
 */
export async function resolvePlayerPersona(ownerId: string): Promise<PlayerPersona> {
  return resolveChatPersona({ ownerId });
}
