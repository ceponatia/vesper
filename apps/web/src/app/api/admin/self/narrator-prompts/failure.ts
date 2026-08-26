import { NextResponse } from "next/server";
import { jsonError } from "@/server/api";
import {
  NARRATOR_PROMPT_CONFLICT_CODE,
  NARRATOR_PROMPT_NAME_TAKEN_CODE,
} from "@/contracts/narrator-prompts";
import type { NarratorPromptRefusal } from "@/server/narrator-prompts";

/**
 * One refusal → response mapping for the three Prompt Lab CRUD routes, so the
 * editor sees the same status and the same `error.code` whichever verb it hit.
 *
 * The stale save is the interesting one. It answers **409 with the current
 * revision number in the body**, following the identity-pack precedent
 * (`characters/[id]/identity-pack/shared.ts`): `jsonError` cannot carry extra
 * fields and must not learn to, because `{ error: { code, message } }` is the
 * envelope every client already parses — so the body WIDENS around the envelope
 * instead. That saves the editor a second round trip before it can offer
 * "reload and re-apply your edit", which is the whole point of reporting the
 * conflict rather than silently clobbering the newer revision.
 */
export function narratorPromptFailure(result: NarratorPromptRefusal): Response {
  if (result.code === NARRATOR_PROMPT_CONFLICT_CODE) {
    return NextResponse.json(
      {
        error: {
          code: result.code,
          message: "this prompt already has a newer revision; reload before saving",
        },
        currentRevision: result.currentRevision,
      },
      { status: 409 },
    );
  }
  if (result.code === NARRATOR_PROMPT_NAME_TAKEN_CODE) {
    return jsonError(result.code, "another active prompt already uses that name", 409);
  }
  return jsonError(result.code, "narrator prompt not found", 404);
}
