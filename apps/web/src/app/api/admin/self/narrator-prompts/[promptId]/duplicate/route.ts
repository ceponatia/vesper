import {
  duplicateNarratorPromptRequestSchema,
  type NarratorPromptTemplateDetail,
} from "@/contracts/narrator-prompts";
import { jsonOk, readBody, withOwnerAdminResource } from "@/server/api";
import { duplicateNarratorPromptTemplate, getNarratorPromptTemplate } from "@/server/narrator-prompts";
import { narratorPromptFailure } from "../../failure";

/**
 * Branch an independent experiment.
 *
 * The copy starts at revision 1 holding the source's current body and notes,
 * records `duplicated_from_id`, and has no conversations attached. Nothing is
 * shared afterwards: editing the copy leaves the source's revision chain
 * untouched, which is what makes duplication — rather than revision history —
 * the way a variant diverges.
 *
 * The name is optional and defaults through `duplicateNarratorPromptName`
 * (`… — Copy`, then `— Copy 2`). A JSON body is still REQUIRED — send `{}` for
 * the default — because `readBody` rejects a bodyless request as `invalid_json`
 * before any schema runs, and every mutating route in this app reads its body
 * the same way.
 */

type Params = { promptId: string };

export const POST = withOwnerAdminResource<Params, NarratorPromptTemplateDetail>(
  "narrator prompt",
  (user, params: Params) => getNarratorPromptTemplate(user.id, params.promptId),
  async (user, prompt, req) => {
    const body = await readBody(req, duplicateNarratorPromptRequestSchema);
    if (!body.ok) return body.response;

    const result = await duplicateNarratorPromptTemplate(user.id, prompt.id, body.value);
    if (!result.ok) return narratorPromptFailure(result);
    return jsonOk({ prompt: result.value }, 201);
  },
);
