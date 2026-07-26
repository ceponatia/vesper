import type { NextRequest } from "next/server";
import { z } from "zod";
import { DiagnosticCollector } from "@/contracts/diagnostics";
import { characterSheetScopeSchema } from "@/lib/character-scopes";
import {
  applyCharacterSectionPatch,
  characterDraftSchema,
  characterForgeSectionSchema,
  emptyCharacterDraft,
  forgeCharacter,
  forgeCharacterFill,
  forgeCharacterSection,
  redraftCharacterScope,
} from "@/server/authoring";
import { backpressureRejection, dailyBudgetRejection, jsonError, jsonOk, readBody, withUser } from "@/server/api";

const forgeBodySchema = z.object({
  /** Required for create mode; fill and redraft work from the draft alone (sheet-only, no guidance). */
  prompt: z.string().trim().min(1).max(4000).optional(),
  /**
   * "create" (default): prose prompt → full draft, or one `section` of it.
   * "fill": complete a partially-authored sheet without overwriting anything
   * entered. "redraft": rewrite one tab (`scope`) from the whole sheet
   * (character-sheet-forge.plan.md).
   */
  mode: z.enum(["create", "fill", "redraft"]).default("create"),
  /** Regenerate a single section against the supplied draft (docs/authoring.md). */
  section: characterForgeSectionSchema.optional(),
  /** The tab to rewrite (redraft mode). */
  scope: characterSheetScopeSchema.optional(),
  draft: characterDraftSchema.optional(),
});

/** Prose prompt → AI character draft. Never saves (drafts live client-side). */
export const POST = withUser(async (user, req: NextRequest) => {
  const body = await readBody(req, forgeBodySchema);
  if (!body.ok) return body.response;

  const shed = await backpressureRejection("text", user, req);
  if (shed) return shed;
  // After body validation so a malformed request doesn't burn the budget.
  const overBudget = await dailyBudgetRejection("provider_text_day", user, req);
  if (overBudget) return overBudget;

  const sink = new DiagnosticCollector();
  const { prompt, mode, section, scope, draft } = body.value;
  if (mode === "fill") {
    if (!draft) return jsonError("invalid_body", "fill mode requires the current draft", 400);
    const filled = await forgeCharacterFill({ draft, userId: user.id, sink });
    return jsonOk({ draft: filled, diagnostics: sink.items });
  }
  if (mode === "redraft") {
    if (!draft || !scope) return jsonError("invalid_body", "redraft mode requires the current draft and a scope", 400);
    const redrafted = await redraftCharacterScope({ draft, scope, userId: user.id, sink });
    return jsonOk({ draft: redrafted, diagnostics: sink.items });
  }
  if (!prompt) return jsonError("invalid_body", "create mode requires a prompt", 400);
  if (section) {
    const patch = await forgeCharacterSection(section, { prompt, userId: user.id, sink, draft });
    return jsonOk({ draft: applyCharacterSectionPatch(draft ?? emptyCharacterDraft(), patch), diagnostics: sink.items });
  }
  const forged = await forgeCharacter({ prompt, userId: user.id, sink });
  return jsonOk({ draft: forged, diagnostics: sink.items });
}, { limit: "forge" });
