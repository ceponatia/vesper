import { diag, type Diagnostic, type DiagnosticSink } from "../../diagnostics";
import {
  normalizeGuidanceCandidates,
  type GuidanceCandidateInput,
  type GuidanceCandidateShape,
  type GuidanceCandidates,
  type NarratorPhysicalGuidance,
} from "./types";

/**
 * The disclosure gate (narrator-physical-guidance.plan.md §Architecture 5).
 *
 * A HARD gate, and it runs BEFORE ranking. That ordering is the whole design: if
 * salience could rank a `resolver_only` candidate first, then a sufficiently
 * important secret would leak, and "important" is exactly the property secrets
 * have. Filtering first makes the leak unreachable rather than unlikely.
 *
 * A withheld candidate is `info`, never `warn` or `error`. Hidden state that
 * constrains resolution without entering the prompt is the feature (plan
 * §Boundaries: "Hidden state may constrain a resolver without entering the
 * narrator prompt"); an error-level log would train readers to treat correct
 * behaviour as a fault.
 *
 * `assertNoResolverOnlyLeak` is the other end — the render seam's last-line
 * check, where a leak IS an error, because by then the gate has already run.
 */

/** A `resolver_only` candidate was withheld from a narrator prompt. Correct behaviour. */
export const GUIDANCE_DISCLOSURE_WITHHELD = "guidance.disclosure.resolver_only";

/** A `resolver_only` candidate reached prompt-bound guidance. A bug, always. */
export const GUIDANCE_DISCLOSURE_LEAK = "guidance.disclosure.leak";

export const guidanceConsumers = ["narrator_prompt", "resolver"] as const;
export type GuidanceConsumer = (typeof guidanceConsumers)[number];

/** The four lists, each with its kind label for diagnostics. */
function labelledLists(candidates: GuidanceCandidates): readonly {
  readonly kind: string;
  readonly items: readonly GuidanceCandidateShape[];
}[] {
  return [
    { kind: "constraint", items: candidates.constraints },
    { kind: "correction", items: candidates.corrections },
    { kind: "action_outcome", items: candidates.actionOutcomes },
    { kind: "transition", items: candidates.transitions },
  ];
}

/**
 * Drop the resolver-only candidates from one list.
 *
 * Checked at RUNTIME for every kind, including the two whose types forbid
 * `resolver_only` (corrections, transitions). The types constrain producers
 * inside this repo; the values can also arrive from a lane adapter that parsed a
 * persisted or remote shape, and a gate that trusted the type would be no gate.
 */
function promptSafe<T extends GuidanceCandidateShape>(
  kind: string,
  items: readonly T[],
  sink?: DiagnosticSink,
): readonly T[] {
  const kept: T[] = [];
  for (const item of items) {
    if (item.disclosure === "resolver_only") {
      sink?.push(
        diag("info", GUIDANCE_DISCLOSURE_WITHHELD, `Withheld a resolver-only ${kind} from the narrator prompt`, {
          path: `guidance.disclosure.${kind}`,
          context: { kind, fingerprint: item.fingerprint },
        }),
      );
      continue;
    }
    kept.push(item);
  }
  return kept;
}

/**
 * Gate candidates for one consumer. Normalizes as it goes, so a producer may
 * omit any list and a missing list is never confused with an emptied one.
 */
export function filterGuidanceForConsumer(
  candidates: GuidanceCandidateInput,
  consumer: GuidanceConsumer,
  sink?: DiagnosticSink,
): GuidanceCandidates {
  const normalized = normalizeGuidanceCandidates(candidates);
  switch (consumer) {
    case "resolver":
      // The resolver is the layer allowed to know everything — that is what
      // `resolver_only` means. Nothing is dropped and nothing is logged.
      return normalized;
    case "narrator_prompt":
      return {
        constraints: promptSafe("constraint", normalized.constraints, sink),
        corrections: promptSafe("correction", normalized.corrections, sink),
        actionOutcomes: promptSafe("action_outcome", normalized.actionOutcomes, sink),
        transitions: promptSafe("transition", normalized.transitions, sink),
      };
  }
}

/**
 * The render seam's last-line check: one `error` diagnostic per resolver-only
 * candidate found in guidance that is about to become prompt text.
 *
 * Returns diagnostics rather than throwing (resilience: "diagnostics over
 * exceptions"). The caller's contract is to drop the offending guidance — or all
 * of it — not to fail the turn; a leak must never be the reason a player sees an
 * error, and it must never be silent either.
 */
export function assertNoResolverOnlyLeak(guidance: NarratorPhysicalGuidance): readonly Diagnostic[] {
  const leaks: Diagnostic[] = [];
  for (const list of labelledLists(guidance)) {
    for (const item of list.items) {
      if (item.disclosure !== "resolver_only") continue;
      leaks.push(
        diag("error", GUIDANCE_DISCLOSURE_LEAK, `A resolver-only ${list.kind} reached narrator-bound guidance`, {
          path: `guidance.disclosure.${list.kind}`,
          context: { kind: list.kind, fingerprint: item.fingerprint },
        }),
      );
    }
  }
  return leaks;
}
