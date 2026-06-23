import type { NextRequest } from "next/server";
import { z } from "zod";
import { DiagnosticCollector } from "@/contracts/diagnostics";
import {
  applyWorldSectionPatch,
  emptyWorldDraft,
  FORGE_COUNT_MAX,
  FORGE_COUNT_MIN,
  forgeWorld,
  forgeWorldSection,
  worldDraftSchema,
  worldForgeSectionSchema,
} from "@/server/authoring";
import { FORGE_RATE_LIMIT, jsonError, jsonOk, rateLimit, readBody, withUser } from "@/server/api";

const forgeCountSchema = z.number().int().min(FORGE_COUNT_MIN).max(FORGE_COUNT_MAX).optional();

const forgeBodySchema = z.object({
  prompt: z.string().trim().min(1).max(4000),
  /** Regenerate a single section against the supplied draft (docs/authoring.md). */
  section: worldForgeSectionSchema.optional(),
  draft: worldDraftSchema.optional(),
  /** How many locations / new cast members to auto-generate (UX-audit §1b); 0 ⇒ skip that family. */
  locationCount: forgeCountSchema,
  characterCount: forgeCountSchema,
});

/** Prose premise → AI world draft. Never saves (drafts live client-side). */
export const POST = withUser(async (user, req: NextRequest) => {
  const body = await readBody(req, forgeBodySchema);
  if (!body.ok) return body.response;
  // After body validation so a malformed request doesn't burn the budget.
  if (!rateLimit(`forge:${user.id}`, FORGE_RATE_LIMIT)) {
    return jsonError("rate_limited", "too many forge requests; try again in a minute", 429);
  }

  const sink = new DiagnosticCollector();
  const { prompt, section, draft, locationCount, characterCount } = body.value;
  if (section) {
    const patch = await forgeWorldSection(section, { prompt, userId: user.id, sink, draft, locationCount, characterCount });
    return jsonOk({ draft: applyWorldSectionPatch(draft ?? emptyWorldDraft(), patch), diagnostics: sink.items });
  }
  const forged = await forgeWorld({ prompt, userId: user.id, sink, locationCount, characterCount });
  return jsonOk({ draft: forged, diagnostics: sink.items });
});
