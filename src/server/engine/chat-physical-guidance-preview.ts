import {
  hairClaim,
  type Diagnostic,
  type NarratorPhysicalGuidance,
  type PhysicalNarrationConstraint,
  type PhysicalPremiseCorrection,
} from "@/contracts";
import { parseMessageSpans } from "@/lib/message-spans";
import type { ChatCommittedHairState } from "./chat-affordances";

/**
 * The READ-ONLY developer preview of the narrator physical-guidance staircase
 * (narrator-physical-guidance.plan.md slice 2: "read-only inspector output showing
 * source resolution → candidate → disclosure → selection → rendered instruction").
 *
 * It answers the question a fence makes people ask, which is not "what did it say"
 * but "why did it say nothing". Silence here has five different causes and they look
 * identical from the prompt: the flag is off, the message was never eligible, the
 * committed owner could not answer, the claim was ambiguous, or the candidate lost a
 * budget. So each stage is shown separately, with what entered it.
 *
 * Three deliberate properties, matching the affordance preview beside it:
 *
 * - **It stores nothing.** There is nothing to store — guidance is recomputed from the
 *   cut and the message every turn by design, so a preview is simply a second
 *   evaluation and cannot spend anything.
 * - **It ignores the flag and reports it.** A developer asking why a fence never
 *   appeared needs the answer with the flag off too.
 * - **It renders the same lines production would.** The caller passes the rendered
 *   block through rather than re-wording it, so the preview cannot explain prose that
 *   differs from the prompt's.
 */

/** One candidate, flattened for display. Codes stay raw — this is a debug surface. */
export interface PhysicalGuidancePreviewCandidate {
  readonly kind: "constraint" | "correction";
  readonly fingerprint: string;
  readonly id: string;
  readonly disclosure: string;
  /** Constraint: its priority. Correction: its verdict. */
  readonly grade: string;
  readonly locusIds: readonly string[];
  readonly prohibitedClaimCodes: readonly string[];
  readonly allowedClaimCodes: readonly string[];
  /** Which claim areas the codes above belong to — the lexicon's own grouping. */
  readonly areas: readonly string[];
  readonly evidence: readonly string[];
}

/** Where an input-authority decision came from, per span of the current message. */
export interface PhysicalGuidancePreviewSpan {
  readonly kind: string;
  readonly eligible: boolean;
  readonly text: string;
}

export interface PhysicalGuidancePreview {
  /** Whether `CHAT_PHYSICAL_CONSTRAINTS` is on — i.e. whether these lines reach the narrator. */
  readonly flagEnabled: boolean;
  /** Stage 1 — who is allowed to assert a premise this turn, and which spans qualified. */
  readonly inputAuthority: {
    readonly narratorInput: boolean;
    readonly message: string;
    readonly spans: readonly PhysicalGuidancePreviewSpan[];
    readonly eligibleSpans: number;
  };
  /** Stage 2 — the committed physical facts every verdict is measured against. */
  readonly committed: {
    readonly wetnessBand: string;
    readonly wetnessCause: string;
    readonly arrangement: string;
    readonly coveredFraction: string;
    readonly available: readonly { readonly owner: string; readonly available: boolean }[];
  };
  /** Stage 3 — what the compiler was offered, before disclosure and budget. */
  readonly candidates: {
    readonly constraints: readonly PhysicalGuidancePreviewCandidate[];
    readonly corrections: readonly PhysicalGuidancePreviewCandidate[];
    readonly diagnostics: readonly { readonly level: string; readonly code: string; readonly message: string }[];
  };
  /** Stage 4 — what survived, and what a budget or the disclosure gate dropped. */
  readonly selection: {
    readonly constraints: readonly string[];
    readonly corrections: readonly string[];
    readonly dropped: readonly string[];
  };
  /** Stage 5 — the exact lines the narrator prompt would carry. */
  readonly rendered: readonly string[];
}

/** `null` reads as an explicit "—": absent is a real answer here, not a gap. */
function shown(value: string | number | null): string {
  return value === null ? "—" : String(value);
}

function evidenceStrings(
  evidence: readonly { readonly kind: string; readonly ref: string; readonly detail?: string }[],
): readonly string[] {
  return evidence.map((entry) => `${entry.kind}:${entry.ref}${entry.detail ? ` (${entry.detail})` : ""}`);
}

/** The claim areas a set of codes touches, deduped and in lexicon order. */
function areasOf(codes: readonly string[]): readonly string[] {
  const areas: string[] = [];
  for (const code of codes) {
    const area = hairClaim(code)?.area;
    if (area !== undefined && !areas.includes(area)) areas.push(area);
  }
  return areas;
}

function constraintRow(constraint: PhysicalNarrationConstraint): PhysicalGuidancePreviewCandidate {
  return {
    kind: "constraint",
    fingerprint: constraint.fingerprint,
    id: constraint.id,
    disclosure: constraint.disclosure,
    grade: constraint.priority,
    locusIds: [...constraint.locusIds],
    prohibitedClaimCodes: [...constraint.prohibitedClaimCodes],
    allowedClaimCodes: [...constraint.allowedClaimCodes],
    areas: areasOf([...constraint.prohibitedClaimCodes, ...constraint.allowedClaimCodes]),
    evidence: evidenceStrings(constraint.evidence),
  };
}

function correctionRow(correction: PhysicalPremiseCorrection): PhysicalGuidancePreviewCandidate {
  return {
    kind: "correction",
    fingerprint: correction.fingerprint,
    id: correction.id,
    disclosure: correction.disclosure,
    grade: `${correction.verdict} · ${correction.source}`,
    locusIds: [],
    prohibitedClaimCodes: [correction.claimCode],
    // The committed truth a correction carries is shown HERE and nowhere in the prose:
    // the renderer never voices it (see `chat-physical-guidance-render.ts`), and this
    // is the surface where knowing it is the whole point.
    allowedClaimCodes: [...correction.truthCodes],
    areas: areasOf([correction.claimCode]),
    evidence: evidenceStrings(correction.evidence),
  };
}

function diagnosticRows(
  diagnostics: readonly Diagnostic[],
): readonly { readonly level: string; readonly code: string; readonly message: string }[] {
  return diagnostics.map((entry) => ({ level: entry.severity, code: entry.code, message: entry.message }));
}

/**
 * The fingerprints a diagnostic says were dropped — over budget or withheld by the
 * disclosure gate. Read off the diagnostics rather than diffed from the candidate
 * lists, so the reason survives with the fact.
 */
function droppedFingerprints(diagnostics: readonly Diagnostic[]): readonly string[] {
  const dropped: string[] = [];
  for (const entry of diagnostics) {
    const context: unknown = entry.context;
    if (typeof context !== "object" || context === null) continue;
    const bag = context as { dropped?: unknown; fingerprint?: unknown };
    if (Array.isArray(bag.dropped)) {
      for (const value of bag.dropped) if (typeof value === "string") dropped.push(`${entry.code}: ${value}`);
    } else if (typeof bag.fingerprint === "string") {
      dropped.push(`${entry.code}: ${bag.fingerprint}`);
    }
  }
  return dropped;
}

/**
 * Build the staged preview for one already-computed compile.
 *
 * Takes the CANDIDATES and the compiled result separately, because the interesting
 * failure is between them: a candidate that existed and did not survive is invisible
 * from the result alone, and that is the case a developer is usually chasing.
 */
export function buildChatPhysicalGuidancePreview(input: {
  readonly flagEnabled: boolean;
  readonly narratorInput: boolean;
  readonly message: string;
  readonly playerName: string;
  readonly characterName: string;
  readonly committed: ChatCommittedHairState;
  readonly candidateConstraints: readonly PhysicalNarrationConstraint[];
  readonly candidateCorrections: readonly PhysicalPremiseCorrection[];
  readonly guidance: NarratorPhysicalGuidance;
  readonly rendered: readonly string[];
  /** Everything the compile filed, including what the constraint mapping skipped. */
  readonly diagnostics: readonly Diagnostic[];
}): PhysicalGuidancePreview {
  // Narrator-mode input is excluded before any span is looked at, so the preview must
  // say so rather than showing spans that were never consulted.
  const spans = input.narratorInput
    ? []
    : parseMessageSpans(input.message, {
        playerName: input.playerName,
        knownNames: [input.characterName],
      }).map((span) => ({
        kind: span.kind,
        eligible: span.kind === "speech" || span.kind === "narration",
        text: span.text,
      }));

  return {
    flagEnabled: input.flagEnabled,
    inputAuthority: {
      narratorInput: input.narratorInput,
      message: input.message,
      spans,
      eligibleSpans: spans.filter((span) => span.eligible).length,
    },
    committed: {
      wetnessBand: shown(input.committed.wetnessBand),
      wetnessCause: shown(input.committed.wetnessCause),
      arrangement: shown(input.committed.arrangement),
      coveredFraction: shown(input.committed.coveredFraction),
      available: [
        { owner: "wetness", available: input.committed.available.wetness },
        { owner: "arrangement", available: input.committed.available.arrangement },
        { owner: "coverage", available: input.committed.available.coverage },
      ],
    },
    candidates: {
      constraints: input.candidateConstraints.map(constraintRow),
      corrections: input.candidateCorrections.map(correctionRow),
      diagnostics: diagnosticRows(input.diagnostics),
    },
    selection: {
      constraints: input.guidance.constraints.map((constraint) => constraint.fingerprint),
      corrections: input.guidance.corrections.map((correction) => correction.fingerprint),
      dropped: droppedFingerprints(input.diagnostics),
    },
    rendered: [...input.rendered],
  };
}
