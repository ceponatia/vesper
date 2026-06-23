import type { NextRequest } from "next/server";
import { z } from "zod";
import { DiagnosticCollector } from "@/contracts/diagnostics";
import {
  applyCharacterSectionPatch,
  characterDraftSchema,
  characterForgeSectionSchema,
  emptyCharacterDraft,
  forgeCharacter,
  forgeCharacterSection,
} from "@/server/authoring";
import { FORGE_RATE_LIMIT, jsonError, jsonOk, rateLimit, readBody, withUser } from "@/server/api";

const forgeBodySchema = z.object({
  prompt: z.string().trim().min(1).max(4000),
  /** Regenerate a single section against the supplied draft (docs/authoring.md). */
  section: characterForgeSectionSchema.optional(),
  draft: characterDraftSchema.optional(),
});

/** Prose prompt → AI character draft. Never saves (drafts live client-side). */
export const POST = withUser(async (user, req: NextRequest) => {
  const body = await readBody(req, forgeBodySchema);
  if (!body.ok) return body.response;
  // After body validation so a malformed request doesn't burn the budget.
  if (!rateLimit(`forge:${user.id}`, FORGE_RATE_LIMIT)) {
    return jsonError("rate_limited", "too many forge requests; try again in a minute", 429);
  }

  const sink = new DiagnosticCollector();
  const { prompt, section, draft } = body.value;
  if (section) {
    const patch = await forgeCharacterSection(section, { prompt, userId: user.id, sink, draft });
    return jsonOk({ draft: applyCharacterSectionPatch(draft ?? emptyCharacterDraft(), patch), diagnostics: sink.items });
  }
  const forged = await forgeCharacter({ prompt, userId: user.id, sink });
  return jsonOk({ draft: forged, diagnostics: sink.items });
});
