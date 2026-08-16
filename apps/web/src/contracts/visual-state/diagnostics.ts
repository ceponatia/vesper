/**
 * Visual-state diagnostic codes (visual-state.spec.md §Diagnostics and degraded
 * behavior). Everything this family reports lives under `visual_state.*`.
 *
 * Only the codes slice 1 actually emits are declared. Visibility, detail-tier,
 * intimate-gate, missing-mandatory-fact, stale-snapshot and extraction-conflict
 * codes join when the slice that emits them lands — a declared-but-unreachable
 * code reads like coverage that does not exist.
 *
 * Every one of these is a DEGRADATION report: the feature is dropped and the
 * projection continues. Nothing here throws (docs/resilience.md §2).
 */

/** A feature named a kind id the registry does not know. */
export const VISUAL_STATE_KIND_UNKNOWN = "visual_state.kind.unknown";
/** The kind's value schema rejected the feature's value. */
export const VISUAL_STATE_VALUE_INVALID = "visual_state.value.invalid";
/** The body locus failed registry validation, or would have to be coarsened. */
export const VISUAL_STATE_LOCUS_INVALID = "visual_state.locus.invalid";
/** The kind does not allow features at this locus kind. */
export const VISUAL_STATE_LOCUS_NOT_ALLOWED = "visual_state.locus.not_allowed";
/** The record's shape, or its key, could not be reconciled with its own fields. */
export const VISUAL_STATE_FEATURE_MALFORMED = "visual_state.feature.malformed";
/** A semantic tag looked like prose rather than vocabulary; it was dropped. */
export const VISUAL_STATE_TAG_REJECTED = "visual_state.tag.rejected";
/** Two contributions claimed one feature key; the earlier adapter wins. */
export const VISUAL_STATE_DUPLICATE_KEY = "visual_state.snapshot.duplicate_key";
/** A source owner exists in the upstream union but has no visual-state mapping yet. */
export const VISUAL_STATE_SOURCE_UNAVAILABLE = "visual_state.source.unavailable";
