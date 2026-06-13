/**
 * The `{{player}}` authoring token: authored free text may name the player
 * character without knowing who will embody them. It resolves exactly once,
 * server-side, at session-bundle load (server/engine/bundle.ts
 * `fillBundlePlayerToken`) — prompts, post-turn agents, and the status
 * payload never see the raw token (docs/authoring.md §The {{player}} token).
 *
 * Pure module: no IO, importable from anywhere.
 */

/** Matches `{{player}}` case-insensitively, with optional inner whitespace: `{{ Player }}`, `{{PLAYER}}`, … */
export const PLAYER_TOKEN = /\{\{\s*player\s*\}\}/gi;

/**
 * What the token resolves to when the session has no player participant
 * (observer sessions spawn no is_user row): a fixed phrase naming the story
 * role without asserting a present character.
 */
export const OBSERVER_PLAYER_NAME = "the protagonist";

/**
 * Replace every `{{player}}` occurrence in `text` with `name`. Text without
 * a `{{` returns as-is (no-op fast path — old content behaves identically).
 * The replacement is literal: `$`-patterns in display names stay verbatim.
 */
export function fillPlayerToken(text: string, name: string): string {
  if (!text.includes("{{")) return text;
  return text.replace(PLAYER_TOKEN, () => name);
}

/** `fillPlayerToken` lifted over optional fields (snapshot voice, narrator guidance, sensory text). */
export function fillPlayerTokenOpt(text: string | undefined, name: string): string | undefined {
  return text === undefined ? undefined : fillPlayerToken(text, name);
}
