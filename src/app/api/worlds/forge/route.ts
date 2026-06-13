import type { NextRequest } from "next/server";
import { z } from "zod";
import { DiagnosticCollector } from "@/contracts/diagnostics";
import {
  applyWorldSectionPatch,
  emptyWorldDraft,
  forgeWorld,
  forgeWorldSection,
  worldDraftSchema,
  worldForgeSectionSchema,
} from "@/server/authoring";
import { FORGE_RATE_LIMIT, jsonError, jsonOk, rateLimit, readBody, withUser } from "@/server/api";

const forgeBodySchema = z.object({
  prompt: z.string().trim().min(1).max(4000),
  /** Regenerate a single section against the supplied draft (docs/authoring.md). */
  section: worldForgeSectionSchema.optional(),
  draft: worldDraftSchema.optional(),
});

/** Prose premise → AI world draft. Never saves (drafts live client-side). */
export const POST = withUser(async (user, req: NextRequest) => {
  if (!rateLimit(`forge:${user.id}`, FORGE_RATE_LIMIT)) {
    return jsonError("rate_limited", "too many forge requests; try again in a minute", 429);
  }
  const body = await readBody(req, forgeBodySchema);
  if (!body.ok) return body.response;

  const sink = new DiagnosticCollector();
  const { prompt, section, draft } = body.value;
  if (section) {
    const patch = await forgeWorldSection(section, { prompt, userId: user.id, sink, draft });
    return jsonOk({ draft: applyWorldSectionPatch(draft ?? emptyWorldDraft(), patch), diagnostics: sink.items });
  }
  const forged = await forgeWorld({ prompt, userId: user.id, sink });
  return jsonOk({ draft: forged, diagnostics: sink.items });
});
