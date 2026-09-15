import type { NextRequest } from "next/server";
import { z } from "zod";
import {
  CHAT_PREMISE_MAX_CHARS,
  characterProfileSchema,
  chatPlansSchema,
  emptyCharacterProfile,
  socialReactionCardSchema,
  supportingCastSchema,
} from "@/contracts";
import { calendarStartSchema } from "@/lib/clock";
import { parseOr } from "@/lib/parse";
import { jsonError, jsonOk, readBody, withOwnedChat } from "@/server/api";
import {
  editChatScenario,
  isSimRoutedAuthority,
  loadChatScenario,
  readChatEngineAuthority,
  seedChatScenario,
} from "@/server/engine";
import { chatBusyResponse, loadOwnedChat, type OwnedChat } from "../../owned";

type Params = { chatId: string };

const patchSchema = z
  .object({
    premise: z.string().trim().max(CHAT_PREMISE_MAX_CHARS).optional(),
    activeSocialCards: z.array(socialReactionCardSchema).optional(),
    sceneAuto: z.enum(["off", "milestones"]).optional(),
    sceneModel: z.string().trim().max(64).optional(),
    supportingCast: supportingCastSchema.optional(),
    plans: chatPlansSchema.optional(),
    calendarStart: calendarStartSchema.optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, "at least one scenario field is required");

const view = (scenario: Awaited<ReturnType<typeof loadChatScenario>> extends infer T ? Exclude<T, null> : never) => ({
  premise: scenario.premise,
  activeSocialCards: scenario.activeSocialCards,
  sceneAuto: scenario.sceneAuto,
  sceneModel: scenario.sceneModel,
  supportingCast: scenario.supportingCast,
  plans: scenario.plans,
  calendarStart: scenario.calendarStart,
  clockMinutes: scenario.clockMinutes,
});

export const GET = withOwnedChat<Params, OwnedChat>(
  (user, params) => loadOwnedChat(params.chatId, user.id),
  async (_user, owned, _req, ctx) => {
    const { chatId } = await ctx.params;
    const profile = parseOr(
      characterProfileSchema,
      owned.character.profile ?? {},
      emptyCharacterProfile(),
      undefined,
      "characters.profile",
    );
    const scenario = (await loadChatScenario(chatId)) ?? seedChatScenario(profile);
    return jsonOk(view(scenario));
  },
);

export const PATCH = withOwnedChat<Params, OwnedChat>(
  (user, params) => loadOwnedChat(params.chatId, user.id),
  async (_user, owned, req: NextRequest, ctx) => {
    const { chatId } = await ctx.params;
    const busy = chatBusyResponse(chatId);
    if (busy) return busy;
    const body = await readBody(req, patchSchema);
    if (!body.ok) return body.response;

    if (body.value.calendarStart !== undefined && isSimRoutedAuthority(await readChatEngineAuthority(chatId))) {
      return jsonError(
        "sim_calendar_managed_by_world",
        "this conversation's calendar is owned by the successor world; change the world calendar instead",
        409,
      );
    }

    const profile = parseOr(
      characterProfileSchema,
      owned.character.profile ?? {},
      emptyCharacterProfile(),
      undefined,
      "characters.profile",
    );
    const scenario = await editChatScenario({ chatId, profile, patch: body.value });
    return jsonOk(view(scenario));
  },
);
