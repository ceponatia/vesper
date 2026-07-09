import type { NextRequest } from "next/server";
import { z } from "zod";
import { DiagnosticCollector } from "@/contracts/diagnostics";
import {
  applyCharacterSectionPatch,
  characterDraftSchema,
  characterForgeSectionSchema,
  emptyCharacterDraft,
  forgeCharacter,
  forgeCharacterFill,
  forgeCharacterSection,
} from "@/server/authoring";
import { FORGE_RATE_LIMIT, jsonError, jsonOk, rateLimit, readBody, withUser } from "@/server/api";

const forgeBodySchema = z.object({
  /** Required for create mode; fill mode works from the draft alone (sheet-only, no guidance). */
  prompt: z.string().trim().min(1).max(4000).optional(),
  /**
   * "create" (default): prose prompt → full draft, or one `section` of it.
   * "fill": complete a partially-authored sheet without overwriting anything
   * entered (character-sheet-forge.plan.md).
   */
  mode: z.enum(["create", "fill"]).default("create"),
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
  const { prompt, mode, section, draft } = body.value;
  if (mode === "fill") {
    if (!draft) return jsonError("invalid_body", "fill mode requires the current draft", 400);
    const filled = await forgeCharacterFill({ draft, userId: user.id, sink });
    return jsonOk({ draft: filled, diagnostics: sink.items });
  }
  if (!prompt) return jsonError("invalid_body", "create mode requires a prompt", 400);
  if (section) {
    const patch = await forgeCharacterSection(section, { prompt, userId: user.id, sink, draft });
    return jsonOk({ draft: applyCharacterSectionPatch(draft ?? emptyCharacterDraft(), patch), diagnostics: sink.items });
  }
  const forged = await forgeCharacter({ prompt, userId: user.id, sink });
  return jsonOk({ draft: forged, diagnostics: sink.items });
});
