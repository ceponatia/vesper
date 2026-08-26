import { z } from "zod";

/**
 * Saved narrator prompt templates and their immutable revisions
 * (narrator-prompt-lab.plan.md §Persistence).
 *
 * A template is a stable identity plus an append-only chain of revision bodies.
 * Editing never overwrites: **Save** writes revision `N + 1`. A conversation
 * selects the TEMPLATE, so it picks up the newest revision on its next
 * exchange — but one exchange resolves exactly one revision and freezes it, so
 * a save landing mid-stream can never change the reply being written.
 *
 * Pure shapes and limits only. Persistence lives in `server/narrator-prompts`.
 */

/**
 * The body's syntax version. v1 bodies are **literal text** — braces, `${…}` and
 * every other sigil mean nothing and are sent to the model verbatim.
 *
 * The field exists so the deferred variables/template-language follow-on can be
 * opt-in: a future `plain_v1` compiler must never retroactively start
 * interpreting braces that an owner hand-typed into a `plain_v0` body years
 * earlier. An unknown value is REJECTED at the parse boundary rather than
 * guessed at as `plain_v0` — guessing is how an old prompt silently starts
 * executing as a template.
 */
export const narratorPromptLanguages = ["plain_v0"] as const;
export type NarratorPromptLanguage = (typeof narratorPromptLanguages)[number];
export const narratorPromptLanguageSchema = z.enum(narratorPromptLanguages);

/** Storage/product policy — NOT a promise that a narrator model can fit this much. */
export const NARRATOR_PROMPT_NAME_MAX = 120;
export const NARRATOR_PROMPT_NOTES_MAX = 2_000;
export const NARRATOR_PROMPT_BODY_MAX = 64_000;

/**
 * Where the editor starts warning that the body is crowding the narrator's
 * context. Advisory only — the runtime still owns the truthful context-fit
 * policy for the effective model, and never silently truncates runtime state to
 * make a custom prompt fit.
 */
export const NARRATOR_PROMPT_BODY_WARN_AT = 24_000;

/** Rough chars-per-token for the editor's approximate token read. Display only. */
export const NARRATOR_PROMPT_CHARS_PER_TOKEN = 4;

export function approximateNarratorPromptTokens(body: string): number {
  return Math.ceil(body.length / NARRATOR_PROMPT_CHARS_PER_TOKEN);
}

/**
 * An empty body is rejected on save (owner ruling — the plan left it to
 * product). "No handwritten behavior text" is expressible as a body that says so;
 * a blank editor is far more likely to be an accident, and an accident that
 * silently strips the narrator's entire craft layer from every attached
 * conversation is the wrong default.
 */
export const narratorPromptBodySchema = z
  .string()
  .trim()
  .min(1)
  .max(NARRATOR_PROMPT_BODY_MAX);

export const narratorPromptNameSchema = z.string().trim().min(1).max(NARRATOR_PROMPT_NAME_MAX);
export const narratorPromptNotesSchema = z.string().trim().max(NARRATOR_PROMPT_NOTES_MAX);

/** One immutable revision. Never updated after insert. */
export interface NarratorPromptRevision {
  id: string;
  templateId: string;
  revision: number;
  body: string;
  bodyHash: string;
  templateLanguage: NarratorPromptLanguage;
  createdAt: string;
}

/** A template as the Prompt Lab lists it. */
export interface NarratorPromptTemplateSummary {
  id: string;
  name: string;
  notes: string;
  currentRevision: number;
  currentRevisionId: string;
  /** Conversations currently selecting this template. */
  usageCount: number;
  createdAt: string;
  updatedAt: string;
  duplicatedFromId: string | null;
}

/** A template with its current body — what the editor pane loads. */
export interface NarratorPromptTemplateDetail extends NarratorPromptTemplateSummary {
  body: string;
  bodyHash: string;
  templateLanguage: NarratorPromptLanguage;
}

// ---------------------------------------------------------------------------
// API request shapes (trust boundary — every route parses through these)
// ---------------------------------------------------------------------------

export const createNarratorPromptRequestSchema = z.object({
  name: narratorPromptNameSchema,
  notes: narratorPromptNotesSchema.default(""),
  body: narratorPromptBodySchema,
});
export type CreateNarratorPromptRequest = z.infer<typeof createNarratorPromptRequestSchema>;

/**
 * `baseRevision` is the optimistic-concurrency token: the revision the editor
 * loaded. The server claims `baseRevision + 1` with a conditional update, so two
 * tabs saving from the same base produce exactly one winner and one
 * `409 prompt_conflict`.
 */
export const saveNarratorPromptRequestSchema = z.object({
  name: narratorPromptNameSchema.optional(),
  notes: narratorPromptNotesSchema.optional(),
  body: narratorPromptBodySchema,
  baseRevision: z.number().int().nonnegative(),
});
export type SaveNarratorPromptRequest = z.infer<typeof saveNarratorPromptRequestSchema>;

export const duplicateNarratorPromptRequestSchema = z.object({
  name: narratorPromptNameSchema.optional(),
});
export type DuplicateNarratorPromptRequest = z.infer<typeof duplicateNarratorPromptRequestSchema>;

/**
 * The per-chat selection PATCH. Deliberately the ONLY thing it accepts: a chat
 * send must never carry raw prompt text, a revision body, or a one-call template
 * override, or authorization and provenance stop being server-owned.
 */
export const selectNarratorPromptRequestSchema = z.object({
  promptId: z.string().min(1).nullable(),
});
export type SelectNarratorPromptRequest = z.infer<typeof selectNarratorPromptRequestSchema>;

/** The failure the editor recovers from by reloading. */
export const NARRATOR_PROMPT_CONFLICT_CODE = "prompt_conflict";
/** Active names are unique case-insensitively per owner. */
export const NARRATOR_PROMPT_NAME_TAKEN_CODE = "prompt_name_taken";

/** `Player Agency Minimal` → `Player Agency Minimal — Copy`, then `— Copy 2`, … */
export function duplicateNarratorPromptName(name: string, taken: readonly string[]): string {
  const lowered = new Set(taken.map((entry) => entry.trim().toLowerCase()));
  const base = `${name.trim()} — Copy`;
  if (!lowered.has(base.toLowerCase())) return base.slice(0, NARRATOR_PROMPT_NAME_MAX);
  for (let n = 2; n < 1_000; n += 1) {
    const candidate = `${base} ${n}`;
    if (!lowered.has(candidate.toLowerCase())) return candidate.slice(0, NARRATOR_PROMPT_NAME_MAX);
  }
  return base.slice(0, NARRATOR_PROMPT_NAME_MAX);
}
