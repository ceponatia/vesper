import type { Diagnostic, DiagnosticSink } from "../../diagnostics";
import { filterGuidanceForConsumer } from "./disclosure";
import { selectNarratorGuidance } from "./selection";
import type { GuidanceCandidateInput, NarratorPhysicalGuidance } from "./types";

/**
 * The one-call entry point (narrator-physical-guidance.spec.md §"File map").
 *
 * Two stages, in this order and no other: gate for the narrator consumer, then
 * order and budget what survived. Reversing them would let a high-priority
 * secret be ranked before it is dropped, and the whole disclosure design rests on
 * that not being possible.
 *
 * Silence is the default, not an error path: absent or empty candidate lists
 * compile to the empty guidance with NO diagnostics. A turn where nothing
 * physical is at stake must produce no evidence that this layer ran, so a
 * feature-off or nothing-to-say turn cannot be told from a byte-identical
 * control by its diagnostics.
 */
export function compileNarratorPhysicalGuidance(
  input: GuidanceCandidateInput & { readonly sink?: DiagnosticSink },
): NarratorPhysicalGuidance {
  // One fan-out sink: every diagnostic lands on the guidance AND on the caller's
  // sink exactly once, so the two views can never disagree about what happened.
  const diagnostics: Diagnostic[] = [];
  const sink: DiagnosticSink = {
    push(diagnostic) {
      diagnostics.push(diagnostic);
      input.sink?.push(diagnostic);
    },
  };

  const gated = filterGuidanceForConsumer(input, "narrator_prompt", sink);
  const selected = selectNarratorGuidance({ candidates: gated, sink });
  // `selected.diagnostics` holds only the budget drops; `diagnostics` holds those
  // plus the withheld candidates, each recorded once.
  return { ...selected, diagnostics };
}
