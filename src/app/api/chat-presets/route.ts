import type { NextRequest } from "next/server";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { CHAT_OUTFIT_MAX_CHARS, CHAT_PREMISE_MAX_CHARS, socialReactionCardSchema } from "@/contracts";
import { jsonError, jsonOk, readBody, withUser } from "@/server/api";
import { chatScenarioPresets, db } from "@/server/db";

/**
 * Scenario presets (character-chat-standalone.spec.md §1.5): reusable
 * premise/outfit/cards/starting-stage bundles, seeded into a new conversation's
 * state at create time. Small owned CRUD — `LibraryKind` graduation
 * (sharing/cloning) stays a later idea.
 */

const createBodySchema = z.object({
  name: z.string().trim().min(1).max(80),
  premise: z.string().trim().max(CHAT_PREMISE_MAX_CHARS).default(""),
  outfit: z.string().max(CHAT_OUTFIT_MAX_CHARS).default(""),
  outfitExposed: z.boolean().default(false),
  socialCards: z.array(socialReactionCardSchema).default([]),
  startingStage: z.string().trim().max(40).default("stranger"),
});

/** GET /api/chat-presets — the user's presets, newest first. */
export const GET = withUser(async (user) => {
  const presets = await db()
    .select({
      id: chatScenarioPresets.id,
      name: chatScenarioPresets.name,
      premise: chatScenarioPresets.premise,
      outfit: chatScenarioPresets.outfit,
      outfitExposed: chatScenarioPresets.outfitExposed,
      socialCards: chatScenarioPresets.socialCards,
      startingStage: chatScenarioPresets.startingStage,
    })
    .from(chatScenarioPresets)
    .where(eq(chatScenarioPresets.ownerId, user.id))
    .orderBy(desc(chatScenarioPresets.createdAt));
  return jsonOk({ presets });
});

/** POST /api/chat-presets — save a preset (e.g. "Save as preset" in the scenario modal). */
export const POST = withUser(async (user, req: NextRequest) => {
  const body = await readBody(req, createBodySchema);
  if (!body.ok) return body.response;
  const [created] = await db()
    .insert(chatScenarioPresets)
    .values({ ownerId: user.id, ...body.value })
    .returning({ id: chatScenarioPresets.id });
  if (!created) return jsonError("internal", "preset insert failed", 500);
  return jsonOk({ id: created.id }, 201);
});
