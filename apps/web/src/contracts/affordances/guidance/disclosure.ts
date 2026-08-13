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
 * The gate is an **allowlist**, not a denylist, and that is the second half of
 * the design. `GuidanceDisclosure` is a closed union, but a closed union only
 * binds the producers the compiler can see; this layer explicitly expects input
 * that a lane adapter parsed out of a persisted or remote shape (slice 6). A gate
 * that dropped exactly `resolver_only` would pass an unrecognised value straight
 * into a prompt — the one failure mode this file exists to prevent. So narrator-
 * bound filtering keeps exactly `consistency_only` and `positive_detail_allowed`,
 * compared at RUNTIME against a `ReadonlySet<string>`, and everything else is
 * dropped. Unknown disclosure ⇒ no disclosure.
 *
 * A withheld `resolver_only` candidate is `info`, never `warn` or `error`. Hidden
 * state that constrains resolution without entering the prompt is the feature
 * (plan §Boundaries: "Hidden state may constrain a resolver without entering the
 * narrator prompt"); an error-level log would train readers to treat correct
 * behaviour as a fault. An unrecognised value is the opposite — nobody meant it,
 * so it is an `error` naming the candidate and the bad value.
 *
 * `assertNoResolverOnlyLeak` is the other end — the render seam's last-line
 * check, where reaching prompt-bound guidance with a non-allowlisted disclosure
 * IS an error, because by then the gate has already had its chance.
 */

/** A `resolver_only` candidate was withheld from a narrator prompt. Correct behaviour. */
export const GUIDANCE_DISCLOSURE_WITHHELD = "guidance.disclosure.resolver_only";

/**
 * A candidate carried a disclosure outside the vocabulary. Dropped from the
 * narrator prompt and reported as an `error`: the value came from somewhere no
 * producer in this repo can reach, so it is a bug in an adapter or a store.
 */
export const GUIDANCE_DISCLOSURE_INVALID = "guidance.disclosure.invalid";

/** A `resolver_only` candidate reached prompt-bound guidance. A bug, always. */
export const GUIDANCE_DISCLOSURE_LEAK = "guidance.disclosure.leak";

export const guidanceConsumers = ["narrator_prompt", "resolver"] as const;
export type GuidanceConsumer = (typeof guidanceConsumers)[number];

/**
 * The ONLY disclosures a narrator prompt may carry.
 *
 * `ReadonlySet<string>` rather than `ReadonlySet<GuidanceDisclosure>` on purpose:
 * a set typed to the union would only accept union members as lookup keys, which
 * is precisely the compile-time assumption this check exists to stop trusting.
 * The types stay closed; the membership test does not.
 */
const narratorPromptDisclosures: ReadonlySet<string> = new Set([
  "consistency_only",
  "positive_detail_allowed",
]);

/** What the narrator-bound gate makes of one candidate's disclosure. */
type DisclosureVerdict = "allowed" | "withheld" | "invalid";

/**
 * Classify one candidate for a narrator-bound consumer. The single place the
 * allowlist is consulted, so the filter and the render-seam assertion can never
 * drift apart on what "prompt-safe" means.
 */
function classifyDisclosure(item: GuidanceCandidateShape): DisclosureVerdict {
  if (narratorPromptDisclosures.has(item.disclosure)) return "allowed";
  return item.disclosure === "resolver_only" ? "withheld" : "invalid";
}

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
 * Keep only the allowlisted candidates from one list.
 *
 * Checked at RUNTIME for every kind, including the two whose types already pin
 * the disclosure (corrections, transitions). The types constrain producers inside
 * this repo; the values can also arrive from a lane adapter that parsed a
 * persisted or remote shape, and a gate that trusted the type would be no gate.
 */
function promptSafe<T extends GuidanceCandidateShape>(
  kind: string,
  items: readonly T[],
  sink?: DiagnosticSink,
): readonly T[] {
  const kept: T[] = [];
  for (const item of items) {
    switch (classifyDisclosure(item)) {
      case "allowed":
        kept.push(item);
        break;
      case "withheld":
        sink?.push(
          diag("info", GUIDANCE_DISCLOSURE_WITHHELD, `Withheld a resolver-only ${kind} from the narrator prompt`, {
            path: `guidance.disclosure.${kind}`,
            context: { kind, fingerprint: item.fingerprint },
          }),
        );
        break;
      case "invalid":
        sink?.push(
          diag(
            "error",
            GUIDANCE_DISCLOSURE_INVALID,
            `Dropped ${kind} ${item.fingerprint} from the narrator prompt: unrecognized disclosure ` +
              `"${String(item.disclosure)}"`,
            {
              path: `guidance.disclosure.${kind}`,
              context: { kind, fingerprint: item.fingerprint, disclosure: String(item.disclosure) },
            },
          ),
        );
        break;
    }
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
 * The render seam's last-line check: one `error` diagnostic per candidate in
 * about-to-be-prompt-text guidance whose disclosure is NOT on the narrator
 * allowlist (`consistency_only`, `positive_detail_allowed`).
 *
 * The name says `resolver_only` because that is the leak worth naming, but the
 * law is the allowlist's: `resolver_only` reports `guidance.disclosure.leak`, and
 * any other non-allowlisted value — the shape only an adapter or a store can
 * produce — reports `guidance.disclosure.invalid`. Both are `error`, so a caller
 * that already drops guidance on any error needs no change to fail closed on the
 * values the compiler cannot see.
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
      switch (classifyDisclosure(item)) {
        case "allowed":
          break;
        case "withheld":
          leaks.push(
            diag("error", GUIDANCE_DISCLOSURE_LEAK, `A resolver-only ${list.kind} reached narrator-bound guidance`, {
              path: `guidance.disclosure.${list.kind}`,
              context: { kind: list.kind, fingerprint: item.fingerprint },
            }),
          );
          break;
        case "invalid":
          leaks.push(
            diag(
              "error",
              GUIDANCE_DISCLOSURE_INVALID,
              `A ${list.kind} with an unrecognized disclosure "${String(item.disclosure)}" reached ` +
                `narrator-bound guidance (${item.fingerprint})`,
              {
                path: `guidance.disclosure.${list.kind}`,
                context: { kind: list.kind, fingerprint: item.fingerprint, disclosure: String(item.disclosure) },
              },
            ),
          );
          break;
      }
    }
  }
  return leaks;
}
