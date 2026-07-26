import type { NextRequest } from "next/server";
import { z } from "zod";
import { itemKindSchema } from "@/contracts";
import {
  backpressureRejection,
  dailyBudgetRejection,
  draftItemProposal,
  jsonError,
  jsonOk,
  readBody,
  withUser,
} from "@/server/api";

const draftBodySchema = z
  .object({
    kind: itemKindSchema,
    name: z.string().trim().max(200).default(""),
    description: z.string().trim().max(4000).default(""),
  })
  .refine((b) => b.name.length > 0 || b.description.length > 0, {
    message: "a name or a description is required",
    path: ["description"],
  });

/**
 * ✦ Draft from description (ux-improvements.plan.md slice 5): propose the
 * item's structured record — category/layer/wearer/color/opacity, explicit
 * coverage with carve-outs, the three sensory lines — from name + description.
 * Stateless: nothing is written; the editor fill-merges into the unsaved form
 * so the SaveBar stays the review step (the Forge-the-rest discipline).
 */
export const POST = withUser(
  async (user, req: NextRequest) => {
    const body = await readBody(req, draftBodySchema);
    if (!body.ok) return body.response;

    const shed = await backpressureRejection("text", user, req);
    if (shed) return shed;
    const overBudget = await dailyBudgetRejection("provider_text_day", user, req);
    if (overBudget) return overBudget;

    const draft = await draftItemProposal(body.value);
    if (!draft) {
      return jsonError("draft_failed", "the draft model returned nothing usable — try again", 502);
    }
    return jsonOk({ draft });
  },
  { limit: "forge" },
);
