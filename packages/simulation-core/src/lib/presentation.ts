import type { DiagnosticSink } from "@vesper/contracts";
import {
  narratorResultSchema,
  presentationAuditSchema,
  type NarrativeCut,
  type NarratorResult,
  type PresentationAudit,
} from "../contracts/narrative";
import {
  softCanonProposalSchema,
  type SoftCanonProposal,
} from "../contracts/soft-canon";
import { parseOr } from "@vesper/contracts";

/**
 * E4.3 — the narrator trust boundary and the presentation auditor. Everything a
 * model returns is parsed with `parseOr` and safe defaults: a malformed reply
 * degrades to an empty result the auditor will send back for rerender — never a
 * thrown turn (docs/resilience.md).
 *
 * The prompt BUILDER lives in `server/engine/prompts/sim-render.ts` — this
 * module keeps only the parse + audit, the two pure trust-boundary halves. The
 * audit is deterministic and structural: it audits what the narrator DECLARED
 * and how the prose reads against what the cut REQUIRED. It may request a
 * rerender or supply a deterministic bridge built from beat summaries; it
 * cannot mutate truth.
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
   * Proposals stamped with the cut they rendered from. Provenance is
   * assigned here, at the boundary — a model is never trusted to cite itself.
   */
  proposals: SoftCanonProposal[];
}

/**
 * Translate the model's declared HANDLES (B1…, E1…) back to real event/effect
 * ids. `sim-render` shows the model opaque handles so no id ever needs to
 * appear in prose; here at the boundary they map back before validation against
 * the cut. A declared value not in the map flows through unchanged — the
 * existing unknown-id flagging catches it.
 */
function mapDeclaredHandles(result: NarratorResult, handleMap: Record<string, string>): NarratorResult {
  const map = (value: string): string => handleMap[value] ?? value;
  return {
    ...result,
    enactedBeatEventIds: result.enactedBeatEventIds.map(map),
    enactedArmedEffectIds: result.enactedArmedEffectIds.map(map),
  };
}

/**
 * Parse one raw narrator reply against the narrator contract, safely. When a
 * `handleMap` is given (the successor lane), declared handles are translated to
 * real ids before the proposals are stamped and the audit runs.
 */
export function parseNarratorResult(
  raw: unknown,
  cut: NarrativeCut,
  sink?: DiagnosticSink,
  handleMap?: Record<string, string>,
): ParsedNarratorResult {
  const parsed = parseOr(narratorResultSchema, raw, emptyNarratorResult, sink, "narrator.result");
  const result = handleMap ? mapDeclaredHandles(parsed, handleMap) : parsed;
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
  /**
   * The 1-based attempt index. It gates two attempt-aware behaviours: the
   * demoted bridge (a small omission gets a feedback retry first, and only
   * bridges from attempt ≥2) and the substance floor (a thin render retries
   * once but is ACCEPTED on the final attempt — a turn is never withheld over
   * length alone). Absent ⇒ treated as final (accept), so direct callers keep
   * the legacy accept/bridge semantics.
   */
  attempt?: number;
  /** Total attempts (default 2) — the last attempt accepts a thin render. */
  maxAttempts?: number;
  /** True when the player gave an utterance this turn — the substance floor's other trigger. */
  hadUtterance?: boolean;
  /**
   * Extra tokens that must never appear in prose (the render's handle
   * vocabulary), unioned with the ids the audit derives from the cut itself.
   */
  leakTokens?: readonly string[];
}

/** A render under this word count (with beats or an utterance in play) is too thin. */
const MIN_SUBSTANCE_WORDS = 40;
/**
 * Ids shorter than this are not scanned for in prose — real sim ids are long and
 * distinctive (UUIDs, `rollout-actor-…`, `zone-…`), so this keeps a short actor
 * id that happens to be an English word (`player`) from false-positive leaking.
 */
const MIN_LEAK_ID_LENGTH = 8;
/** The output-contract field names — prose that embeds one is echoing the envelope. */
const CONTRACT_FIELD_NAMES = ["enactedBeatEventIds", "enactedArmedEffectIds", "proposedSoftCanon"] as const;

/** The distinctive ids + the deterministic B/E handle vocabulary a cut yields. */
function collectCutLeakTokens(cut: NarrativeCut): { ids: string[]; handles: string[] } {
  const ids = new Set<string>();
  const add = (value: string | null | undefined): void => {
    if (value && value.length >= MIN_LEAK_ID_LENGTH) ids.add(value);
  };
  add(cut.viewpointActorId);
  for (const beat of [...cut.mustEnact, ...cut.allowedTransitions]) add(beat.eventId);
  for (const effect of cut.armedEffects) {
    add(effect.id);
    add(effect.actorId);
    for (const target of effect.targetActorIds) add(target);
  }
  for (const locus of cut.currentLoci) {
    add(locus.actorId);
    add(locus.zoneId);
  }
  for (const activity of cut.currentActivities) {
    add(activity.zoneId);
    for (const actorId of activity.actorIds) add(actorId);
  }
  for (const claim of cut.forbiddenClaims) for (const actorId of claim.subjectActorIds) add(actorId);
  for (const read of cut.bodilyReads.observed) add(read.actorId);
  for (const belief of cut.speakerBeliefs) for (const subjectId of belief.subjectIds) add(subjectId);

  const beatHandleCount = cut.mustEnact.length + cut.allowedTransitions.length;
  const handles: string[] = [];
  for (let i = 1; i <= beatHandleCount; i += 1) handles.push(`B${i}`);
  for (let i = 1; i <= cut.armedEffects.length; i += 1) handles.push(`E${i}`);
  return { ids: [...ids], handles };
}

/** Which forbidden tokens actually appear in the prose (ids by substring, handles word-bounded). */
function detectLeaks(prose: string, ids: readonly string[], handles: readonly string[]): string[] {
  const leaked: string[] = [];
  for (const id of ids) if (prose.includes(id)) leaked.push(id);
  // Handles are `/^[BE]\d+$/`, safe to embed in a RegExp; word boundaries keep a stray
  // "B1" inside another token from a false hit.
  for (const handle of handles) if (new RegExp(`\\b${handle}\\b`).test(prose)) leaked.push(handle);
  return leaked;
}

/** Prose that IS a JSON envelope, or embeds a contract field name — a template echo. */
function detectContractEcho(prose: string): boolean {
  const trimmed = prose.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      JSON.parse(trimmed);
      return true;
    } catch {
      // Not valid JSON — fall through to the field-name check.
    }
  }
  return CONTRACT_FIELD_NAMES.some((field) => prose.includes(field));
}

/** Whitespace-delimited word count of the trimmed prose. */
function wordCount(prose: string): number {
  const trimmed = prose.trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
}

/** The audit: flags omissions, overreach, and prose hygiene; requests rerender or bridges. */
export function auditPresentation(
  cut: NarrativeCut,
  result: NarratorResult,
  options: AuditPresentationOptions = {},
): PresentationAudit {
  const maxBridgedBeats = options.maxBridgedBeats ?? 2;
  const maxAttempts = options.maxAttempts ?? 2;
  const { attempt } = options;
  const diagnostics: string[] = [];

  // A template echo is empty prose wearing brackets: models sometimes return
  // the output contract's own placeholder verbatim (caught live, R5 slice 6).
  // Structurally valid, narratively nothing — send it back.
  const trimmedProse = result.prose.trim();
  const placeholderEcho = /^<[^<>]{0,120}>$/.test(trimmedProse) || trimmedProse.includes("100-350 words");
  if (placeholderEcho && trimmedProse.length > 0) diagnostics.push("presentation.placeholder_echo");
  const proseEmpty = trimmedProse.length === 0 || placeholderEcho;
  if (trimmedProse.length === 0) diagnostics.push("presentation.prose_empty");

  // (a) Id/handle leak: no B/E handle, event/effect/actor/zone id from the cut may
  // sit in the prose surface — the prose is story, the ids are the envelope's alone.
  const { ids, handles } = collectCutLeakTokens(cut);
  const leaked = trimmedProse.length > 0 ? detectLeaks(result.prose, [...ids, ...(options.leakTokens ?? [])], handles) : [];
  const idLeak = leaked.length > 0;
  if (idLeak) diagnostics.push("presentation.id_leak");

  // (b) JSON / contract-field echo: the prose is (or embeds) the output envelope.
  const contractEcho = !proseEmpty && detectContractEcho(result.prose);
  if (contractEcho) diagnostics.push("presentation.contract_echo");

  const declaredBeatIds = new Set(result.enactedBeatEventIds);
  const missingBeats = cut.mustEnact.filter((beat) => !declaredBeatIds.has(beat.eventId));
  if (missingBeats.length > 0) diagnostics.push(`presentation.missing_beats:${missingBeats.length}`);

  const knownBeatIds = new Set<string>([...cut.mustEnact, ...cut.allowedTransitions].map((beat) => beat.eventId));
  const unknownEnactedBeatEventIds = result.enactedBeatEventIds.filter((eventId) => !knownBeatIds.has(eventId)).sort();
  if (unknownEnactedBeatEventIds.length > 0) diagnostics.push("presentation.unknown_beats_declared");

  const armedIds = new Set(cut.armedEffects.map((effect) => effect.id));
  const unknownEnactedArmedEffectIds = result.enactedArmedEffectIds.filter((effectId) => !armedIds.has(effectId)).sort();
  if (unknownEnactedArmedEffectIds.length > 0) diagnostics.push("presentation.unknown_effects_declared");

  // (c) Substance floor: a render under the word floor while the cut carries beats or an
  // utterance was given is too thin. It forces ONE retry, but the FINAL attempt accepts it
  // (never withhold over length alone). Absent attempt info ⇒ final (accept).
  const tooThin =
    !proseEmpty &&
    wordCount(result.prose) < MIN_SUBSTANCE_WORDS &&
    (cut.mustEnact.length > 0 || (options.hadUtterance ?? false));
  if (tooThin) diagnostics.push("presentation.too_thin");
  const isFinalAttempt = attempt === undefined || attempt >= maxAttempts;

  let verdict: PresentationAudit["verdict"] = "accept";
  let bridgeProse: string | undefined;
  const smallOmission = missingBeats.length > 0 && missingBeats.length <= maxBridgedBeats;
  if (proseEmpty || idLeak || contractEcho || missingBeats.length > maxBridgedBeats) {
    verdict = "rerender";
  } else if (smallOmission) {
    // Bridge demoted to last resort: a small omission gets a FEEDBACK retry first;
    // it bridges only from attempt ≥2 (or a direct audit call with no attempt
    // info, which keeps the legacy accept-with-bridge semantics).
    if (attempt === undefined || attempt >= 2) {
      verdict = "accept_with_bridge";
      bridgeProse = missingBeats.map((beat) => beat.summary).join(" ");
    } else {
      verdict = "rerender";
    }
  } else if (tooThin && !isFinalAttempt) {
    verdict = "rerender";
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
