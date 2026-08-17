/**
 * Visual-state diagnostic codes (visual-state.spec.md §Diagnostics and degraded
 * behavior). Every code this family DECLARES lives under `visual_state.*`.
 *
 * Two foreign codes still reach a caller's sink from this family, because the
 * sink is passed straight through to a shared helper rather than wrapped:
 * `appearance.locus.unknown_location` from `validateBodyLocusRef`, and
 * `parse.boundary_failed` from `parseOr`. That is deliberate — the reader wants
 * the upstream reason, not a re-labelled one — so a caller asserting on codes
 * should expect a namespaced pair, not a single `visual_state.*` entry.
 *
 * Only the codes the shipped slices actually emit are declared — a
 * declared-but-unreachable code reads like coverage that does not exist. The
 * extraction codes joined with slice 9, which emits them; the digest codes
 * live beside their emitter in `contracts/images/visual-digest.ts`.
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
/** A relationship named a feature key the snapshot does not hold; the edge is dropped. */
export const VISUAL_STATE_RELATIONSHIP_TARGET_MISSING = "visual_state.relationship.missing_target";
/** A relationship closed a composition cycle; the closing edge is dropped. */
export const VISUAL_STATE_RELATIONSHIP_CYCLE = "visual_state.relationship.cycle";
/** A presentation operation named an entry the state does not hold. */
export const VISUAL_STATE_PRESENTATION_ENTRY_UNKNOWN = "visual_state.presentation.entry_unknown";
/** A presentation operation cannot apply to the entry or kind it named. */
export const VISUAL_STATE_PRESENTATION_OPERATION_INVALID = "visual_state.presentation.operation_invalid";
/** A presentation entry's own record failed its schema — a bad id, subject, or story minute. */
export const VISUAL_STATE_PRESENTATION_ENTRY_MALFORMED = "visual_state.presentation.entry_malformed";
/** A group is realized on the body with no body location to sit at — an authoring contradiction. */
export const VISUAL_STATE_FEATURE_GROUP_UNPLACED = "visual_state.species.feature_group_unplaced";
/**
 * A source owner ANSWERED and its stored entry failed the owner's own parse —
 * the body-surface quarantine marker is the live case. Distinct from
 * `source.unavailable` (no owner, or no mapping yet): unavailable is a design
 * gap, invalid is corrupt data, and neither may become a convenient default.
 */
export const VISUAL_STATE_SOURCE_INVALID = "visual_state.source.invalid";
/** A body-language fact has no owner anywhere in the app — gaze, fine joint pose, a microexpression. */
export const VISUAL_STATE_BODY_LANGUAGE_UNAVAILABLE = "visual_state.body_language.unavailable";
/** A visibility component read answered `unknown`; nothing is claimed visible under it. */
export const VISUAL_STATE_VISIBILITY_UNKNOWN = "visual_state.visibility.unknown";
/** A visibility component read answered `invalid` — a value broke its trust boundary. */
export const VISUAL_STATE_VISIBILITY_INVALID = "visual_state.visibility.invalid";
/**
 * One or more visibility components came from a DECLARED RELEASE DEFAULT rather
 * than from an owner (spec §Visibility → declared defaults). Info severity: the
 * policy is deliberate and written down, and this is the line that makes it
 * measurable instead of invisible.
 */
export const VISUAL_STATE_VISIBILITY_DECLARED = "visual_state.visibility.declared_default";
/** Hidden from this viewpoint: exposure-covered, composed away, replaced, or extinguished. NOT a claim of absence. */
export const VISUAL_STATE_VISIBILITY_HIDDEN = "visual_state.visibility.hidden";
/** The observer viewpoint has no sight channel this cut. */
export const VISUAL_STATE_VISIBILITY_CHANNEL_UNAVAILABLE = "visual_state.visibility.channel_unavailable";
/** The feature's body zone is outside the frame, or cannot be placed inside one. */
export const VISUAL_STATE_VISIBILITY_OUT_OF_FRAME = "visual_state.visibility.out_of_frame";
/** Visible, but not at the closeness these viewing conditions can resolve. */
export const VISUAL_STATE_DETAIL_TIER_INSUFFICIENT = "visual_state.detail_tier.insufficient";
/** An intimate region without an explicit allowance. A hard gate; rarity never lifts it. */
export const VISUAL_STATE_INTIMATE_GATED = "visual_state.intimate.gated";
/** An extraction proposal the target owner's own vocabulary refuses; it is dropped unreviewed. */
export const VISUAL_STATE_EXTRACTION_PROPOSAL_INVALID = "visual_state.extraction.proposal_invalid";
/**
 * The reserved extraction-conflict code (spec §Diagnostics), now with live
 * emitters: a newer run disagrees with a reviewed proposal for the same slot
 * (`reason: "reviewed_value_differs"`), or canonical truth moved between the
 * reviewer's look and their accept (`reason: "canonical_moved"`). Either way
 * the ruling and the canonical value are PRESERVED and the disagreement
 * becomes a review item — never an overwrite.
 */
export const VISUAL_STATE_EXTRACTION_CONFLICT = "visual_state.extraction.conflict";
/** An accepted proposal's target owner has no canonical write path yet; the ruling is kept, nothing is written. */
export const VISUAL_STATE_EXTRACTION_OWNER_UNAVAILABLE = "visual_state.extraction.owner_unavailable";
