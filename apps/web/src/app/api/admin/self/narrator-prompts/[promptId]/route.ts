import { saveNarratorPromptRequestSchema, type NarratorPromptTemplateDetail } from "@/contracts/narrator-prompts";
import { jsonOk, readBody, withOwnerAdminResource } from "@/server/api";
import {
  getNarratorPromptTemplate,
  saveNarratorPromptRevision,
  softDeleteNarratorPromptTemplate,
} from "@/server/narrator-prompts";
import { narratorPromptFailure } from "../failure";

/**
 * One saved narrator prompt: load it into the editor, save the next immutable
 * revision, or soft-delete it.
 *
 * `withOwnerAdminResource` resolves the template through the owner-scoped
 * service BEFORE any handler runs, so a template id that is not the caller's and
 * a template id that does not exist collapse to the same 404 — an admin session
 * is not a licence to read another account's experiments, and a probe cannot
 * tell the two apart.
 */

type Params = { promptId: string };

const ownedPrompt = (user: { id: string }, params: Params) =>
  getNarratorPromptTemplate(user.id, params.promptId);

export const GET = withOwnerAdminResource<Params, NarratorPromptTemplateDetail>(
  "narrator prompt",
  ownedPrompt,
  async (_user, prompt) => jsonOk({ prompt }),
);

/**
 * Save revision `baseRevision + 1`. There is no autosave: a saved body is an
 * experimental revision that every attached conversation picks up on its next
 * exchange, so an accidental keystroke must not become one.
 *
 * A save from a stale base answers 409 `prompt_conflict` carrying the current
 * revision, rather than overwriting the newer one.
 */
export const PATCH = withOwnerAdminResource<Params, NarratorPromptTemplateDetail>(
  "narrator prompt",
  ownedPrompt,
  async (user, prompt, req) => {
    const body = await readBody(req, saveNarratorPromptRequestSchema);
    if (!body.ok) return body.response;

    const result = await saveNarratorPromptRevision(user.id, prompt.id, body.value);
    if (!result.ok) return narratorPromptFailure(result);
    return jsonOk({ prompt: result.value });
  },
);

/**
 * Soft delete. The template leaves the library and every conversation of this
 * owner selecting it drops back to production instructions on its next exchange;
 * the immutable revisions stay so historical take provenance still resolves.
 */
export const DELETE = withOwnerAdminResource<Params, NarratorPromptTemplateDetail>(
  "narrator prompt",
  ownedPrompt,
  async (user, prompt) => {
    const result = await softDeleteNarratorPromptTemplate(user.id, prompt.id);
    if (!result.ok) return narratorPromptFailure(result);
    return jsonOk({ deletedPromptId: result.value.templateId, clearedChatIds: result.value.clearedChatIds });
  },
);
