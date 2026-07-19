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
