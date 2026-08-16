/**
 * What the projection dropped, and why (visual-state.spec.md §Snapshot,
 * §Diagnostics and degraded behavior).
 *
 * A leaf module: both the snapshot assembler and the composition resolver
 * record suppressions, and neither may import the other
 * (`pnpm lint:cycles`).
 *
 * A suppression is the INSPECTOR's half of a degradation — the diagnostic sink
 * tells a developer what happened during one run, this tells a reader of the
 * snapshot why something is missing without re-running the read.
 */
export interface VisualStateSuppression {
  /** The feature key the drop is attributed to. */
  readonly key: string;
  /** A `visual_state.*` diagnostic code — the machine-readable reason. */
  readonly code: string;
  /**
   * Short elaboration in the dropper's own vocabulary: the losing adapter id for
   * a duplicate key, `<relationship kind>:<target key>` for a dropped
   * composition edge. Never prose.
   */
  readonly detail?: string;
}
