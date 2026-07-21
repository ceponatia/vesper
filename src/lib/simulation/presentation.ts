import type { DiagnosticSink } from "@/contracts/diagnostics";
import {
  narratorResultSchema,
  presentationAuditSchema,
  type NarrativeCut,
  type NarratorResult,
  type PresentationAudit,
} from "@/contracts/simulation/narrative";
import {
  softCanonProposalSchema,
  type SoftCanonProposal,
} from "@/contracts/simulation/soft-canon";
import { parseOr } from "@/lib/parse";

/**
 * E4.3 — the §23.1 narrator trust boundary and the §23.2 presentation
 * auditor. Everything a model returns is parsed with `parseOr` and safe
 * defaults: a malformed reply degrades to an empty result the auditor will
 * send back for rerender — never a thrown turn (docs/resilience.md).
 *
 * The auditor is deterministic and structural: it audits what the narrator
 * DECLARED against what the cut REQUIRED. It may request a rerender or supply
 * a deterministic bridge built from beat summaries; it cannot mutate truth.
 */

/** A parse-failed render: nothing enacted, nothing proposed, empty prose. */
export const emptyNarratorResult: NarratorResult = {
  prose: "",
  enactedArmedEffectIds: [],
  enactedBeatEventIds: [],
  proposedSoftCanon: [],
};

export interface ParsedNarratorResult {
  result: NarratorResult;
  /**
   * §23.4 proposals stamped with the cut they rendered from. Provenance is
   * assigned here, at the boundary — a model is never trusted to cite itself.
   */
  proposals: SoftCanonProposal[];
}

/** Parse one raw narrator reply against the §23.1 contract, safely. */
export function parseNarratorResult(
  raw: unknown,
  cut: NarrativeCut,
  sink?: DiagnosticSink,
): ParsedNarratorResult {
  const result = parseOr(narratorResultSchema, raw, emptyNarratorResult, sink, "narrator.result");
  const proposals = result.proposedSoftCanon.flatMap((draft) => {
    const stamped = softCanonProposalSchema.safeParse({ ...draft, sourceCutId: cut.id });
    return stamped.success ? [stamped.data] : [];
  });
  return { result, proposals };
}

export interface AuditPresentationOptions {
  /**
   * How many missing hard beats a deterministic bridge may carry before the
   * render goes back entirely. Two reads as an editor's touch-up; more means
   * the render ignored the scene.
   */
  maxBridgedBeats?: number;
}

/**
 * R2 (engine.rollout.plan.md) — serialize one committed cut into the live
 * narrator's system/prompt pair. Pure and deterministic: the prompt IS the
 * §22 boundary made text — everything in it comes from the cut, and the
 * §23.1 result contract is stated verbatim so the reply parses.
 */
export interface CutRenderConversation {
  /** The viewpoint actor's words/intent THIS turn — presentation input only. */
  playerUtterance?: string;
  /** Recent dialogue, oldest first, for conversational continuity. */
  dialogueTail?: readonly { speaker: string; text: string }[];
}

export function buildCutRenderPrompt(
  cut: NarrativeCut,
  conversation: CutRenderConversation = {},
): { system: string; prompt: string } {
  const lines: string[] = [];
  lines.push(
    `VIEWPOINT: ${cut.viewpointActorId}`,
    `STORY SPAN: second ${cut.fromStorySecond} through ${cut.throughStorySecond}`,
  );
  if (cut.currentLoci.length > 0) {
    lines.push(
      "SCENE (who is physically here):",
      ...cut.currentLoci.map(
        (locus) => `- ${locus.actorId}: ${locus.kind}${locus.zoneId ? ` at ${locus.zoneId}` : ""}`,
      ),
    );
  }
  if (cut.currentActivities.length > 0) {
    lines.push(
      "VISIBLE ACTIVITIES:",
      ...cut.currentActivities.map(
        (activity) => `- ${activity.actorIds.join(", ")}: ${activity.actionDefinitionId} (${activity.phase})`,
      ),
    );
  }
  lines.push(
    "MUST ENACT (each beat exactly once; echo its event id in enactedBeatEventIds):",
    ...(cut.mustEnact.length > 0
      ? cut.mustEnact.map((beat) => `- [${beat.eventId}] ${beat.summary}`)
      : ["- (none this turn)"]),
  );
  if (cut.allowedTransitions.length > 0) {
    lines.push(
      "MAY PORTRAY (already-resolved; never invent new outcomes):",
      ...cut.allowedTransitions.map((beat) => `- [${beat.eventId}] ${beat.summary}`),
    );
  }
  if (cut.speakerBeliefs.length > 0) {
    lines.push(
      "VIEWPOINT BELIEFS (voiceable, possibly false):",
      ...cut.speakerBeliefs.map(
        (belief) => `- ${belief.propositionKey} = ${JSON.stringify(belief.claimedValue)} (${belief.status})`,
      ),
    );
  }
  if (cut.relevantPressures.length > 0) {
    lines.push(
      "VIEWPOINT PRESSURES (their own obligations only):",
      ...cut.relevantPressures.map((pressure) => `- ${pressure.severity}, act by second ${pressure.actBy}`),
    );
  }
  if (cut.bodilyReads.self || cut.bodilyReads.observed.length > 0) {
    lines.push(`BODILY READS: ${JSON.stringify(cut.bodilyReads)}`);
  }
  if (cut.failurePresentations.length > 0) {
    lines.push(
      "FAILED ATTEMPTS (present ONLY these public faces; never a private cause):",
      ...cut.failurePresentations.map(
        (failure) =>
          `- ${failure.publicReason}${failure.legalAlternatives.length > 0 ? ` (alternatives: ${failure.legalAlternatives.join(", ")})` : ""}`,
      ),
    );
  }
  if (cut.creativeLicenses.length > 0) {
    lines.push(
      "CREATIVE LICENSES (bounded invention you MAY use):",
      ...cut.creativeLicenses.map((license) => `- ${license.kind}: ${license.note}`),
    );
  }
  lines.push(
    "FORBIDDEN (never state or imply):",
    ...(cut.forbiddenClaims.length > 0
      ? cut.forbiddenClaims.map((claim) => `- ${claim.claim}`)
      : ["- (no additional bans)"]),
  );
  if (cut.armedEffects.length > 0) {
    lines.push(
      "ARMED SPEECH ACTS (enact ONLY if your prose delivers it in meaning; list the ids you enacted):",
      ...cut.armedEffects.map(
        (effect) =>
          `- [${effect.id}] ${effect.effectType}: ${effect.actorId} → ${effect.targetActorIds.join(", ")} — ${effect.detail}`,
      ),
    );
  }
  const tail = (conversation.dialogueTail ?? []).filter((line) => line.text.trim().length > 0).slice(-6);
  if (tail.length > 0) {
    lines.push(
      "RECENT CONVERSATION (oldest first — continuity only, never new facts):",
      ...tail.map((line) => `- ${line.speaker}: ${line.text.length > 300 ? `${line.text.slice(0, 300)}…` : line.text}`),
    );
  }
  if (conversation.playerUtterance && conversation.playerUtterance.trim().length > 0) {
    lines.push(
      "THE VIEWPOINT ACTOR'S TURN — this drives the scene:",
      `- ${conversation.playerUtterance.trim()}`,
      "Portray the viewpoint actor saying/doing this and have the characters",
      "present RESPOND to it naturally (dialogue is yours under the small-talk",
      "license). If it implies an action or outcome the committed state above",
      "does not establish, portray only the attempt or the words — never the",
      "unearned outcome.",
    );
  }
  lines.push(
    "",
    "Return STRICT JSON only, no prose outside it:",
    '{"prose": "<the scene, 100-350 words>", "enactedBeatEventIds": ["..."], "enactedArmedEffectIds": ["..."], "proposedSoftCanon": []}',
  );

  const system = [
    "You are the narrator of a live scene in a simulated world. You render ONLY what the",
    "committed world state below establishes — you never move anyone, create objects,",
    "reveal knowledge, or decide outcomes. Write immersive third-person present-tense",
    "prose from the viewpoint actor's perspective. Every MUST ENACT beat appears exactly",
    "once, in meaning. Nothing FORBIDDEN appears in any form. Failed attempts show only",
    "their public face. The scene must ANSWER the viewpoint actor's turn when one is",
    "given — background texture supports the exchange, never replaces it. Armed speech",
    "acts are optional — enact one only when your prose",
    "actually delivers it, and declare exactly what you enacted. Reply with the strict",
    "JSON object requested and nothing else.",
  ].join(" ");

  return { system, prompt: lines.join("\n") };
}

/** The §23.2 audit: flags omissions and overreach, requests rerender or bridges. */
export function auditPresentation(
  cut: NarrativeCut,
  result: NarratorResult,
  options: AuditPresentationOptions = {},
): PresentationAudit {
  const maxBridgedBeats = options.maxBridgedBeats ?? 2;
  const diagnostics: string[] = [];

  const proseEmpty = result.prose.trim().length === 0;
  if (proseEmpty) diagnostics.push("presentation.prose_empty");

  const declaredBeatIds = new Set(result.enactedBeatEventIds);
  const missingBeats = cut.mustEnact.filter((beat) => !declaredBeatIds.has(beat.eventId));
  if (missingBeats.length > 0) {
    diagnostics.push(`presentation.missing_beats:${missingBeats.length}`);
  }

  const knownBeatIds = new Set<string>(
    [...cut.mustEnact, ...cut.allowedTransitions].map((beat) => beat.eventId),
  );
  const unknownEnactedBeatEventIds = result.enactedBeatEventIds
    .filter((eventId) => !knownBeatIds.has(eventId))
    .sort();
  if (unknownEnactedBeatEventIds.length > 0) diagnostics.push("presentation.unknown_beats_declared");

  const armedIds = new Set(cut.armedEffects.map((effect) => effect.id));
  const unknownEnactedArmedEffectIds = result.enactedArmedEffectIds
    .filter((effectId) => !armedIds.has(effectId))
    .sort();
  if (unknownEnactedArmedEffectIds.length > 0) diagnostics.push("presentation.unknown_effects_declared");

  let verdict: PresentationAudit["verdict"] = "accept";
  let bridgeProse: string | undefined;
  if (proseEmpty || missingBeats.length > maxBridgedBeats) {
    verdict = "rerender";
  } else if (missingBeats.length > 0) {
    verdict = "accept_with_bridge";
    bridgeProse = missingBeats.map((beat) => beat.summary).join(" ");
  }

  return presentationAuditSchema.parse({
    verdict,
    missingBeatEventIds: missingBeats.map((beat) => beat.eventId),
    ...(bridgeProse === undefined ? {} : { bridgeProse }),
    unknownEnactedArmedEffectIds,
    unknownEnactedBeatEventIds,
    proseEmpty,
    diagnostics,
  });
}
