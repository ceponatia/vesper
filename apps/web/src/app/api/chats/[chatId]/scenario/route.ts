import type { NextRequest } from "next/server";
import { z } from "zod";
import {
  characterProfileSchema,
  emptyCharacterProfile,
  socialReactionCardSchema,
  supportingCastSchema,
  chatPlansSchema,
  CHAT_PREMISE_MAX_CHARS,
} from "@/contracts";
import { calendarStartSchema } from "@/lib/clock";
import { parseOr } from "@/lib/parse";
import { jsonError, jsonOk, readBody, withOwnedChat } from "@/server/api";
import { isSimRoutedAuthority, readChatEngineAuthority } from "@/server/engine";
import { editChatScenario } from "@/server/engine/chat-state/focused-edit";
import { scenarioView } from "@/server/engine/chat-state/focused-read";
import { loadChatScenario } from "@/server/engine/chat-state/store";
import { seedChatScenario } from "@/server/engine/chat-state/seed";
import { chatBusyResponse, loadOwnedChat, type OwnedChat } from "../../owned";

type Params = { chatId: string };

const patchSchema = z.object({
  premise: z.string().trim().max(CHAT_PREMISE_MAX_CHARS).optional(),
  activeSocialCards: z.array(socialReactionCardSchema).optional(),
  sceneAuto: z.enum(["off", "milestones"]).optional(),
  sceneModel: z.string().trim().max(64).optional(),
  supportingCast: supportingCastSchema.optional(),
  plans: chatPlansSchema.optional(),
  calendarStart: calendarStartSchema.optional(),
}).refine((value) => Object.keys(value).length > 0, "at least one scenario field is required");

function primaryProfile(owned: OwnedChat) {
  return parseOr(
    characterProfileSchema,
    owned.character.profile ?? {},
    emptyCharacterProfile(),
    undefined,
    "characters.profile",
  );
}

export const GET = withOwnedChat<Params, OwnedChat>(
  (user, params) => loadOwnedChat(params.chatId, user.id),
  async (_user, owned, _req, ctx) => {
    const { chatId } = await ctx.params;
    const profile = primaryProfile(owned);
    const scenario = (await loadChatScenario(chatId)) ?? seedChatScenario(profile);
    return jsonOk(scenarioView(scenario));
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
    if (
      body.value.calendarStart !== undefined &&
      isSimRoutedAuthority(await readChatEngineAuthority(chatId))
    ) {
      return jsonError(
        "sim_calendar_managed_by_world",
        "this conversation's calendar is owned by the successor world; change the world calendar rather than the legacy chat scenario anchor",
        409,
      );
    }
    const scenario = await editChatScenario({ chatId, profile: primaryProfile(owned), patch: body.value });
    return jsonOk(scenarioView(scenario));
  },
);
