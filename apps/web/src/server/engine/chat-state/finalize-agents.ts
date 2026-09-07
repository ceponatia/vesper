import {
  resolveTraits,
  traitRegistry,
  hasVoiceAnchors,
  type ChatPlan,
  planOthersLabel,
  describePlanWhen,
  currentScenePlace,
  buildGarmentHandleTable,
  garmentActorForCharacter,
  GARMENT_PLAYER_ACTOR,
  advancePlans,
} from "@/contracts";
import { lifeStageForAge, lifeStageThirdPersonLine } from "@/contracts/world/life-stage";
import { runChatPulse } from "./pulse-agent";
import { runChatExtraction } from "../chat-memory";
import type { FinalizeChatStateInput } from "./finalize-types";

type RunFinalizationAgentsInput = Pick<
  FinalizeChatStateInput,
  "profile"
  | "driftedState"
  | "characterName"
  | "scenario"
  | "playerName"
  | "characterId"
  | "skipPulse"
  | "exchange"
  | "pulseScope"
  | "chatId"
  | "assistantMessageId"
  | "sink"
  | "roster"
  | "priorSummary"
>;

export async function runFinalizationAgents(
  input: RunFinalizationAgentsInput,
) {
  // Character-fidelity slices 7-10: arm the archivist's voice reads (voiceExemplar /
  // characterSlip) with a compact voice reference, and its trait-shift proposals with the
  // character's DEVELOPABLE traits at their current (authored + evolved) band. Intimate
  // traits are fenced for a minor, mirroring the prompt-builder fence.
  const lifeStage = lifeStageForAge(input.profile.age);
  const minor = lifeStage?.minor ?? false;
  const evolvedTraits = resolveTraits(input.profile.traits, input.driftedState.traitOverlays);
  const developableTraits = evolvedTraits.flatMap((t) => {
    const def = traitRegistry.byId(t.id);
    if (!def || def.mutability !== "developable" || (minor && def.intimate)) return [];
    return [{ id: def.id, label: def.label, band: traitRegistry.bandFor(def.id, t.value)?.label ?? "" }];
  });
  const anchors = input.profile.voiceAnchors;
  const voiceReference =
    hasVoiceAnchors(anchors) || (lifeStage?.registerRules.length ?? 0) > 0
      ? {
          petPhrases: anchors.petPhrases,
          cadence: anchors.cadence,
          neverSays: anchors.neverSays,
          registerRule: lifeStageThirdPersonLine(lifeStage, input.characterName),
        }
      : undefined;

  // Plans coming due: the DETERMINISTIC transitions are knowable from
  // the already-ticked clock before the fan-out, so the pulse — which runs in PARALLEL with
  // the archivist — can see a just-missed commitment and propose the hurt (consequences stay
  // model-mediated, ruling C: no deterministic regard penalty). The real fold below re-runs
  // the advance AFTER the archivist's kept/canceled land (which may spare an overdue plan).
  const planLabelCtx = { nowMinutes: input.scenario.clockMinutes, calendarStart: input.scenario.calendarStart };
  const planPhrase = (p: ChatPlan): string => {
    const others = planOthersLabel(p, input.playerName);
    const when = describePlanWhen(p.when, planLabelCtx);
    return `"${p.what}"${others ? ` ${others}` : ""}${when ? ` (${when})` : ""}`;
  };
  // The grounded wardrobe lane: the exact
  // garment/part handles this exchange may address. Built from the store as it
  // stands BEFORE the fan-out, because that is what the extractor's prompt shows.
  // Empty (an unmodelled chat, a first exchange) ⇒ the field never arms and the
  // legacy free-text grammar stands — which is exactly the bridge.
  //
  // "Here" is the place the exchange STARTED in, not wherever the archivist's
  // scene proposal moved them: the enumeration and the `left_here` locus then mean
  // one and the same room, so a garment dropped this exchange is re-findable by
  // exactly the handles the model was just shown.
  const scenePlaceName = currentScenePlace(input.scenario.sceneMemory)?.name;
  const garmentHandles = buildGarmentHandleTable({
    store: input.scenario.garments,
    actors: [
      { actorId: garmentActorForCharacter(input.characterId), label: input.characterName },
      { actorId: GARMENT_PLAYER_ACTOR, label: input.playerName || "you", slug: "you" },
    ],
    ...(scenePlaceName === undefined ? {} : { placeName: scenePlaceName }),
  });

  const preAdvance = advancePlans(input.scenario.plans, input.scenario.clockMinutes, input.playerName);
  const commitmentsDue =
    input.skipPulse || preAdvance.justMissed.length === 0
      ? undefined
      : { missed: preAdvance.justMissed.map(planPhrase), kept: [] as string[] };

  // The post-turn fan-out: the reaction pulse ‖ the three extraction legs (the memory
  // scribe, the continuity tracker, the character tracker), all in flight
  // together after the reply has already flushed.
  const [pulse, archivist] = await Promise.all([
    input.skipPulse
      ? Promise.resolve({ state: input.driftedState, degraded: false })
      : runChatPulse({
          state: input.driftedState,
          profile: input.profile,
          characterName: input.characterName,
          playerName: input.playerName,
          exchange: input.exchange,
          activeSocialCards: input.scenario.activeSocialCards,
          scope: input.pulseScope,
          commitmentsDue,
          trace: { chatId: input.chatId, messageId: input.assistantMessageId },
          sink: input.sink,
        }),
    runChatExtraction({
      characterName: input.characterName,
      playerName: input.playerName,
      exchange: input.exchange,
      openLoops: input.driftedState.openLoops,
      drives: input.driftedState.drives,
      roster: input.roster,
      supportingCast: input.scenario.supportingCast.map((m) => ({ name: m.name, relation: m.relation })),
      // Open commitments the archivist can mark kept/canceled.
      openPlans: input.scenario.plans
        .filter((p) => p.status === "upcoming")
        .map((p) => ({ what: p.what, who: p.participants.join(", "), when: describePlanWhen(p.when, planLabelCtx) })),
      developableTraits,
      voiceReference,
      // The in-scope garment handles — present ⇒ the
      // continuity leg proposes typed operations instead of free-text garments.
      garmentHandles,
      // The recap's ledger grounds the scribe's facts in NAMES (a pronoun-heavy
      // beat used to file a dangling referent).
      priorSummary: input.priorSummary,
      // Failure telemetry only — never reaches a prompt (agent-failure.ts).
      trace: { chatId: input.chatId, messageId: input.assistantMessageId },
      sink: input.sink,
    }),
  ]);

  return { pulse, archivist, minor, garmentHandles, scenePlaceName };
}

export type FinalizationAgents = Awaited<ReturnType<typeof runFinalizationAgents>>;
