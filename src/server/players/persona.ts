import { eq } from "drizzle-orm";
import { emptyPlayerPersona, playerPersonaSchema } from "@/contracts";
import { parseOr } from "@/lib/parse";
import { db, users } from "@/server/db";

/**
 * The resolved player identity every consumer reads through — the user-level
 * analog of the session's `bundlePlayerName()` (engine/bundle.ts). v1 reads the
 * light `users.playerPersona` blob; `id` is always `null` (an inline persona,
 * not a character row). When the persona graduates to a real library character
 * (player-character.plan.md), only this resolver changes — callers keep reading
 * the same shape, and `id` becomes that character's id.
 */
export interface PlayerPersona {
  /** null in v1 (inline persona); a character id after graduation. */
  id: string | null;
  /** Never empty — the stored name, else the account display name. */
  name: string;
  /** Short bio/voice; undefined when the player hasn't written one. */
  persona?: string;
}

/** Ultimate fallback name when neither a persona nor an account name resolves (degenerate). */
export const FALLBACK_PLAYER_NAME = "the visitor";

/**
 * Pure resolution: derive the persona from an account name + the raw stored blob.
 * Never throws — a malformed blob `parseOr`s to empty, then the name falls back
 * to the account name (then {@link FALLBACK_PLAYER_NAME}). Extracted from the DB
 * query so the degradation path is unit-testable without Postgres.
 */
export function resolvePersonaFromRow(accountName: string | undefined, rawBlob: unknown): PlayerPersona {
  const stored = parseOr(playerPersonaSchema, rawBlob, emptyPlayerPersona(), undefined, "users.player_persona");
  const name = stored.name?.trim() || accountName?.trim() || FALLBACK_PLAYER_NAME;
  const persona = stored.persona.trim() || undefined;
  return { id: null, name, persona };
}

/**
 * Resolve the owner's default player character. Never throws: a missing row or a
 * malformed blob degrades to the account name (or {@link FALLBACK_PLAYER_NAME}),
 * so a chat turn always has someone to address (docs/resilience.md).
 */
export async function resolvePlayerPersona(ownerId: string): Promise<PlayerPersona> {
  const [row] = await db()
    .select({ name: users.name, playerPersona: users.playerPersona })
    .from(users)
    .where(eq(users.id, ownerId))
    .limit(1);
  return resolvePersonaFromRow(row?.name, row?.playerPersona);
}
