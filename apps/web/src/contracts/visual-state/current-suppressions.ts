import { diag, type DiagnosticSink } from "../diagnostics";
import { VISUAL_STATE_SOURCE_UNAVAILABLE } from "./diagnostics";
import { visualStateFeatureKey } from "./feature";
import type { VisualStateSuppression } from "./suppression";

/**
 * The current-state facts Vesper CANNOT answer, on the record
 * (visual-state.audit.md finding 14 — nine of thirteen current-state facts
 * have no owner, and the plan's ruling is that missing owners mean silence
 * plus a diagnostic, never invention).
 *
 * This module is the "as much code on suppression as projection" half of
 * slice 3 made structural: a fixed table of the unsupported fact families and
 * one function that turns it into snapshot suppressions. The point is that the
 * inspector can show "dirt on skin: no owner" beside the facts that DO exist,
 * instead of a reader having to know the difference between "clean" and
 * "unmodelled" — which is precisely the difference between an answer and a gap.
 *
 * Each row names the nearest thing that exists, so the table doubles as the
 * checklist for retiring itself: when an owner ships, its row is DELETED here
 * and an adapter takes over. A row and an adapter for the same fact would be a
 * snapshot arguing with itself.
 *
 * Body language (posture, gaze, occupied hands) is slice 4's scope and is
 * deliberately not tabled here; `contact` below is the current-state half
 * only — what committed contact has visibly done to a body.
 *
 * `occupied_hands` was tabled here before slice 4 shipped and has been REMOVED
 * per the rule above: `body_language.hand_occupation` derives it from the
 * committed contacts, so leaving the row would make one snapshot report the
 * fact as unavailable and state it in the same breath.
 */

export const visualStateUnsupportedFamilies = [
  /** Involuntary body responses — swelling, visible fatigue, flushing. */
  "physiology",
  /** Makeup coming off. Substances ON skin now have the body-surface deposits module; wear does not. */
  "contamination",
  /** Visible traces of committed contact — pressure marks, an occupied surface. */
  "contact",
  /** How a garment sits against the body — fitted, loose, straining. */
  "fit",
] as const;
export type VisualStateUnsupportedFamily = (typeof visualStateUnsupportedFamilies)[number];

export interface VisualStateUnsupportedFact {
  readonly family: VisualStateUnsupportedFamily;
  /** The fact, in `snake_case` — the aspect the missing feature would carry. */
  readonly fact: string;
  /** The nearest owner that DOES exist — inspector context, never a substitute. */
  readonly nearest: string;
}

/**
 * The audit's unavailable rows, verbatim where finding 14 names them. Adding a
 * row is a data edit; removing one means an owner shipped.
 */
export const VISUAL_STATE_UNSUPPORTED_CURRENT_FACTS: readonly VisualStateUnsupportedFact[] = [
  { family: "physiology", fact: "swelling", nearest: "authored static attributes" },
  { family: "physiology", fact: "visible_fatigue", nearest: "energy meter prompt hint (prose-only)" },
  // `dirt_on_skin` and `blood_on_skin` were tabled here and have been RETIRED
  // per the rule above: the body-surface owner's deposits module commits
  // material on skin and `projectBodySurfaceFeatures` reads it as
  // `body_surface.deposit`, so both facts now have an owner and an adapter.
  // `cosmetics_wear` STAYS, because it is a different fact: a cosmetic deposit
  // is makeup material present on a surface, while this row is makeup coming
  // OFF — the degradation of a deliberate presentation, which the deposits
  // module cannot state and no producer writes.
  { family: "contamination", fact: "cosmetics_wear", nearest: "presentation makeup disturbance (smudged, running)" },
  // `contact_marks` was tabled here and has been RETIRED per the rule above:
  // the body-surface owner's marks module commits temporary contact marks and
  // `projectBodySurfaceFeatures` reads them as `body_surface.contact_mark`
  // features, so the fact now has an owner and an adapter. The `contact`
  // family stays in the vocabulary for the current-state facts it still lacks
  // (an occupied surface, for one).
  { family: "fit", fact: "garment_fit", nearest: "no wardrobe vocabulary member" },
];

/**
 * The unsupported table as snapshot suppressions for one subject.
 *
 * Each key is the key the feature WOULD have carried, at the subject locus —
 * an address for a fact that cannot exist yet, so the inspector's staircase
 * has somewhere to hang the explanation. The diagnostics are `info`, not
 * `warn`: a permanent, designed absence on every snapshot is context, and
 * warning about it each cut would bury the degradations that are actually
 * news.
 */
export function unsupportedCurrentStateSuppressions(
  subjectId: string,
  sink?: DiagnosticSink,
  path = "visual_state.current.unsupported",
): readonly VisualStateSuppression[] {
  const locus = { kind: "subject", subjectId } as const;
  return VISUAL_STATE_UNSUPPORTED_CURRENT_FACTS.map((row) => {
    const key = visualStateFeatureKey(subjectId, locus, `${row.family}.${row.fact}`);
    sink?.push(
      diag("info", VISUAL_STATE_SOURCE_UNAVAILABLE, `No owner for ${row.family}:${row.fact}`, {
        path,
        context: { subjectId, family: row.family, fact: row.fact, nearest: row.nearest },
      }),
    );
    return { key, code: VISUAL_STATE_SOURCE_UNAVAILABLE, detail: `${row.family}:${row.fact}` };
  });
}
