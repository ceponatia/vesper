/**
 * The Prompt Lab's small shared vocabulary.
 *
 * The library pane and the editor pane both have to say the same things about
 * the same template — how many conversations use it, what saving will do to
 * them — so those sentences are written once here rather than twice in two
 * components that would drift.
 *
 * Pure: no IO, no React. The starter body lives here too, because it is
 * product copy rather than editor mechanics.
 */

/** The three fields the editor edits. Everything else about a template is server-owned. */
export interface NarratorPromptDraft {
  name: string;
  notes: string;
  body: string;
}

/**
 * Dirty is a plain three-field comparison against what the editor LOADED, not
 * against the newest server state: the point of the optimistic-concurrency
 * flow is that a newer revision existing elsewhere is a conflict to recover
 * from, not something that quietly makes the editor look clean.
 */
export function isNarratorPromptDraftDirty(
  loaded: NarratorPromptDraft,
  draft: NarratorPromptDraft,
): boolean {
  return loaded.name !== draft.name || loaded.notes !== draft.notes || loaded.body !== draft.body;
}

/** `3 conversations` / `1 conversation` / `unused` — the library row and the editor chip. */
export function usageCountLabel(usageCount: number): string {
  if (usageCount <= 0) return "unused";
  return usageCount === 1 ? "1 conversation" : `${String(usageCount)} conversations`;
}

/**
 * The warning shown BEFORE a save that will reach live
 * conversations, not a toast after the fact: a saved body is an experimental
 * revision, and the owner should know how far it travels before it travels.
 */
export function inUseSaveWarning(usageCount: number, nextRevision: number): string {
  return `Used by ${usageCountLabel(usageCount)}. Saving will apply revision ${String(nextRevision)} to their next replies.`;
}

/** Grouped digits with an explicit locale, so the count never depends on the reader's. */
export function formatCount(value: number): string {
  return value.toLocaleString("en-US");
}

/**
 * What a brand-new prompt opens with. Deliberately short: a starting point the
 * owner rewrites, not a production prompt to inherit. It only says
 * behavior/craft things — role, player agency, beat resolution, camera, voice,
 * length — because those are the only things a test prompt is allowed to
 * replace. Vesper still supplies the character sheet, world and relationship
 * state, the per-turn constraints and the response format.
 *
 * Literal text (`plain_v0`): nothing in here is interpolated.
 */
export const NARRATOR_PROMPT_STARTER_BODY = `You are the narrator of a roleplaying game, and you embody every character except the player's.

Never speak, act, think, or decide for the player. End the reply where their next choice begins.

Resolve the immediate beat before advancing the scene. If the player did something, show what it changed here and now, before any time passes or anyone moves on.

Write in close third person, anchored to what the player can actually perceive from where they are. Prefer one concrete physical detail over three adjectives.

Give each character their own voice, their own wants, and the willingness to act on them — including refusing, changing the subject, or leaving.

Keep the reply to two or three short paragraphs, and stop while the scene still has somewhere to go.`;
