import { type ChatPlan, advancePlans, mergeSceneMemory, mergeSupportingCast, mergeChatPlans } from "@/contracts";
import { newId } from "@/lib/ids";
import type { ChatExtractionResult } from "../chat-memory";
import type { FinalizeChatStateInput } from "./finalize-types";

type FoldFinalizationNarrativeInput = Pick<
  FinalizeChatStateInput,
  "scenario"
  | "playerName"
  | "characterName"
  | "roster"
>;

export function foldFinalizationNarrative(
  input: FoldFinalizationNarrativeInput,
  archivist: ChatExtractionResult,
) {
  // Scene memory: reconcile the archivist's `scene` proposal onto the pre-turn memory (the
  // deterministic movement switch already applied to `scenario.sceneMemory` before the
  // prompt built). A degraded / empty proposal is a no-op, so the memory only ever accretes
  // what the fiction established — never re-establishing an unchanged setting.
  const sceneMemory = archivist.value
    ? mergeSceneMemory(input.scenario.sceneMemory, archivist.value.scene)
    : input.scenario.sceneMemory;

  // Supporting cast: same accrete-only shape as the
  // scene merge — a degraded/empty proposal is a no-op, and roster members + the
  // player can never be minted as cast entries (full characters stay full characters).
  const supportingCast = archivist.value
    ? mergeSupportingCast(input.scenario.supportingCast, archivist.value.cast, [
        input.playerName,
        input.characterName,
        ...(input.roster?.map((m) => m.name) ?? []),
      ])
    : input.scenario.supportingCast;

  // Plans: merge the archivist's struck/changed/canceled commitments
  // (new ids via `newId`), then advance deterministically as the ticked clock passes each
  // due-time — an overdue player plan the archivist did NOT resolve becomes `missed`, an
  // overdue NPC↔NPC plan is assumed kept (ruling E). A degraded archivist proposes nothing
  // but the plans still advance. Rolls back with the snapshot (ruling B).
  const planMerge = archivist.value
    ? mergeChatPlans(input.scenario.plans, archivist.value.plans, {
        nowMinutes: input.scenario.clockMinutes,
        mintId: newId,
        calendarStart: input.scenario.calendarStart,
      })
    : { plans: input.scenario.plans, archivistKept: [] as ChatPlan[] };
  const planAdvance = advancePlans(planMerge.plans, input.scenario.clockMinutes, input.playerName);
  const plans = planAdvance.plans;

  return { sceneMemory, supportingCast, plans, planMerge, planAdvance };
}

export type FinalizationNarrative = ReturnType<typeof foldFinalizationNarrative>;
