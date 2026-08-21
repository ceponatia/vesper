import {
  isMandatoryImagePromptSegmentKind,
  orderImagePromptSegments,
  type ImagePromptSegment,
  type ImagePromptSegmentKind,
} from "@vesper/image-core";
import { AFFORDANCE_UNIT_ONE } from "../affordances/core";
import { attributeRegistry, type AttributeDefinition } from "../attributes";
import {
  bodyLocationRegistry,
  isBelowWaist,
  isFeatureAttributeCategory,
  isIntimateAttributeCategory,
} from "../body/locations";
import { diag, type DiagnosticSink } from "../diagnostics";
import { exposureRegionOf, type RegionExposure } from "../items/visibility";
import type { VisualStateSuppression } from "../visual-state";
import { IMAGE_SUBJECT_PROJECTION_OWNER } from "./subject-digest";
import { visualImageMorphologyOf, type VisualImageDigest, type VisualImageFact } from "./visual-digest";

/**
 * ONE digest → segments builder for every character-bearing lane
 * (image-lane-consolidation.plan.md Stage 3; spec.prompts.md §Segment mapping).
 *
 * This is the piece the avatar and scene cutovers both call: one subject's
 * slice of a `VisualImageDigest`, plus the canonical garment-coverage readout
 * and a small per-task policy, become the ordered `ImagePromptSegment[]` a
 * render intent compiles. The reference-count ruling lives here structurally —
 * a multi-character scene repeats this same producer per subject rather than
 * growing a second appearance algorithm — and the jscpd gate is why the shared
 * assembly sits in one module instead of once per route.
 *
 * ## What the builder decides, and what it does not
 *
 * It decides GROUPING, ORDER, PROTECTION and POLICY: which facts a task may
 * state at all, which segment each surviving clause lands in, which segments
 * are mandatory, and how the coverage readout becomes the `exposure` segment
 * the digest deliberately never maps (`visualImageFactSegmentKind` has no
 * exposure arm — exposure is a composition read, not a projected feature).
 *
 * It does NOT decide what a fact SAYS. Appearance facts reach the digest with
 * their truth fingerprint as `value` (see `subject-digest.ts` §"Where the
 * semantic value comes from"), so prose must come from the canonical owners.
 * The caller supplies {@link VisualFactClauseResolver}; a fact it cannot phrase
 * is suppressed with a reason, and a REQUIRED fact it cannot phrase lands in
 * `missingRequired` so the route refuses before provider spend rather than
 * rendering a character whose anchors quietly turned into hashes
 * (spec.prompts.md §Failure behavior).
 *
 * ## The three policy hooks
 *
 * - **Age** (`age: "omit"`): scene lanes must never state age — the
 *   narrative/visual age split froze apparent age to the avatar and variant
 *   lanes only, and `age-context-separation.test.ts` tripwires the scene
 *   source. Omitting is a policy suppression, never a fitting decision; a task
 *   that states age keeps the digest's age facts and may append its own
 *   attribute-registry anchor segment beside this builder's output.
 * - **Frame** (`frame: "waist_up"`): a waist-up portrait drops below-the-waist
 *   body facts, mirroring the avatar route's attribute gate — except signature
 *   species morphology (a pelvis-rooted tail sweeps up into frame and defines
 *   the character). The exposure statement is likewise restricted to in-frame
 *   regions. Garment-side waist-up filtering needs coverage the wardrobe fact
 *   does not carry, so it stays with the caller's resolver, which omits
 *   deliberately via `{ omit }` rather than reading as degradation.
 * - **Intimate** (`intimate`): the digest's consent gate has already removed
 *   intimate facts a lane may not see at all; this hook is the LANE policy over
 *   what survived it. `"never"` (the avatar rule) states no intimate anatomy
 *   whatever the wardrobe exposes. `"when_bare"` keeps the cross-lane
 *   invariant the characterization matrix asserts everywhere: covered intimate
 *   SKIN is never described — a skin-reveal fact needs its region to read
 *   `bare` — while SHAPE reads through clothing by design.
 *
 * ## Segment shape
 *
 * Protected kinds (the `isMandatoryImagePromptSegmentKind` floor) and every
 * required fact fold into ONE mandatory segment per kind — required clauses
 * first, optional detail after, which is coherent because fitting drops whole
 * segments and sentences, never facts. Optional facts of droppable kinds
 * become one segment PER FACT carrying the fact's own selection priority, so
 * the fitter sheds them individually from the weakest up. `source` carries the
 * projection owner for diagnostics and structurally never reaches a provider.
 *
 * Pure by construction: no IO, no registry writes, deterministic over its
 * inputs.
 */

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

export interface VisualSegmentTaskPolicy {
  /** Whether this task may state apparent age. Scene and chat-look lanes: `"omit"`. */
  readonly age: "state" | "omit";
  /** The task's body frame. `"waist_up"` drops below-the-waist facts and regions. */
  readonly frame: "waist_up" | "full_figure";
  /** The lane's intimate-anatomy rule. Avatar: `"never"`; uncensored scene: `"when_bare"`. */
  readonly intimate: "never" | "when_bare";
}

// ---------------------------------------------------------------------------
// Clause resolution — the join with the canonical owners
// ---------------------------------------------------------------------------

/**
 * What the caller's resolver may answer for one fact: the clause its segment
 * carries; a DELIBERATE omission with a short reason (recorded as a
 * suppression, never as a missing anchor — the waist-up garment filter and the
 * avatar's curated attribute cuts live here); or `undefined`, meaning no
 * semantic value could be resolved — degradation, which costs a required fact
 * its render eligibility.
 */
export type VisualFactClause = string | { readonly omit: string } | undefined;

export type VisualFactClauseResolver = (fact: VisualImageFact) => VisualFactClause;

// ---------------------------------------------------------------------------
// Suppression codes
// ---------------------------------------------------------------------------

/** The requested subject is not in this digest; the build degrades to empty. */
export const VISUAL_SEGMENTS_SUBJECT_UNKNOWN = "visual_state.segments.subject_unknown";
/** An age fact dropped because this task's policy states no age. */
export const VISUAL_SEGMENTS_AGE_POLICY = "visual_state.segments.age_policy";
/** A below-the-waist fact dropped by a waist-up frame. */
export const VISUAL_SEGMENTS_OUT_OF_FRAME = "visual_state.segments.out_of_frame";
/** An intimate fact dropped because this lane never states intimate anatomy. */
export const VISUAL_SEGMENTS_INTIMATE_POLICY = "visual_state.segments.intimate_policy";
/** An intimate SKIN fact dropped because its region does not read bare. */
export const VISUAL_SEGMENTS_INTIMATE_COVERED = "visual_state.segments.intimate_covered";
/** The caller's resolver deliberately omitted this fact. */
export const VISUAL_SEGMENTS_CLAUSE_OMITTED = "visual_state.segments.clause_omitted";
/** No clause could be resolved; a required fact additionally lands in `missingRequired`. */
export const VISUAL_SEGMENTS_CLAUSE_UNRESOLVED = "visual_state.segments.clause_unresolved";

const SEGMENTS_PATH = "visual_state.segments";

// ---------------------------------------------------------------------------
// Input and result
// ---------------------------------------------------------------------------

export interface VisualSubjectSegmentsInput {
  readonly digest: VisualImageDigest;
  /** The one subject this call describes; a multi-subject lane calls once per subject. */
  readonly subjectId: string;
  /**
   * THIS subject's canonical garment-coverage readout
   * (`exposedRegions(toWornInputs(...))`). Passed as a value so the builder
   * stays pure and route-agnostic — and per subject, because one character's
   * clothing can never answer what another is showing.
   */
  readonly exposure: RegionExposure;
  readonly policy: VisualSegmentTaskPolicy;
  readonly clause: VisualFactClauseResolver;
  readonly sink?: DiagnosticSink;
}

export interface VisualSubjectSegmentsBuild {
  /** The subject's segments, in canonical emission order. */
  readonly segments: readonly ImagePromptSegment[];
  /** Every fact a policy or the resolver excluded, and why. */
  readonly suppressions: readonly VisualStateSuppression[];
  /**
   * Required fact keys with nothing to say: the digest's own missing-mandatory
   * report plus required facts the resolver could not phrase. Non-empty means
   * the render-eligibility decision is the caller's to make before spend.
   */
  readonly missingRequired: readonly string[];
}

// ---------------------------------------------------------------------------
// Fact classification against the registries
// ---------------------------------------------------------------------------

function attributeDefOf(fact: VisualImageFact): AttributeDefinition | undefined {
  return fact.sourceRef.kind === "appearance" && fact.sourceRef.ref.kind === "attribute"
    ? attributeRegistry.byId(fact.sourceRef.ref.attributeId)
    : undefined;
}

/** The body location a fact is about — its body locus, else its attribute's home. */
function bodyLocationIdOf(fact: VisualImageFact, def: AttributeDefinition | undefined): string | undefined {
  if (fact.locus.kind === "body") return fact.locus.locus.bodyLocationId;
  return def?.bodyLocationId;
}

/** A species feature group — signature morphology, exempt from the frame cut. */
function isSignatureMorphology(fact: VisualImageFact, def: AttributeDefinition | undefined): boolean {
  if (visualImageMorphologyOf(fact.kindId) === "species_feature_group") return true;
  return def !== undefined && isFeatureAttributeCategory(def.category);
}

interface IntimateRead {
  readonly region: keyof RegionExposure | undefined;
  /** `skin` is the conservative default — only an explicit `shape` reads through clothing. */
  readonly reveal: "skin" | "shape";
}

/** Whether a fact describes intimate anatomy, and how it reveals. `null` for ordinary facts. */
function intimateReadOf(
  def: AttributeDefinition | undefined,
  locationId: string | undefined,
): IntimateRead | null {
  const location = locationId === undefined ? undefined : bodyLocationRegistry.byId(locationId);
  const intimate =
    location?.intimateGroup !== undefined || (def !== undefined && isIntimateAttributeCategory(def.category));
  if (!intimate) return null;
  return {
    region: locationId === undefined ? undefined : exposureRegionOf(locationId),
    reveal: def?.imageReveal === "shape" ? "shape" : "skin",
  };
}

/** The policy suppression for one fact, or `null` when the fact may be stated. */
function policySuppression(
  fact: VisualImageFact,
  policy: VisualSegmentTaskPolicy,
  exposure: RegionExposure,
): { code: string; detail: string } | null {
  if (fact.segmentKind === "age" && policy.age === "omit") {
    return { code: VISUAL_SEGMENTS_AGE_POLICY, detail: "age:omit" };
  }
  const def = attributeDefOf(fact);
  const locationId = bodyLocationIdOf(fact, def);
  if (
    policy.frame === "waist_up" &&
    locationId !== undefined &&
    isBelowWaist(locationId) &&
    !isSignatureMorphology(fact, def)
  ) {
    return { code: VISUAL_SEGMENTS_OUT_OF_FRAME, detail: `frame:${locationId}` };
  }
  const intimate = intimateReadOf(def, locationId);
  if (intimate !== null) {
    if (policy.intimate === "never") {
      return { code: VISUAL_SEGMENTS_INTIMATE_POLICY, detail: "intimate:never" };
    }
    // Covered intimate SKIN is never described — the one invariant that holds
    // across every lane and stage. An unknown region is coverage nobody
    // resolved, and the answer to unknown is silence, never bare.
    if (intimate.reveal === "skin" && (intimate.region === undefined || exposure[intimate.region] !== "bare")) {
      return { code: VISUAL_SEGMENTS_INTIMATE_COVERED, detail: `region:${intimate.region ?? "unknown"}` };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Exposure segment — the coverage readout, stated
// ---------------------------------------------------------------------------

/**
 * The canonical bare/sheer wording per region — one table, so every lane
 * states exposure identically. Covered regions are silent (silence IS the
 * covered statement; wardrobe authority says what covers them), and bare legs
 * stay unstated when the pelvis is already bare, per the readout's own
 * contract.
 */
const EXPOSURE_CLAUSES: Readonly<Record<keyof RegionExposure, { bare: string; sheer: string }>> = {
  torso: { bare: "the torso is bare", sheer: "the torso shows through sheer fabric" },
  pelvis: { bare: "bare below the waist", sheer: "the hips show through sheer fabric" },
  legs: { bare: "the legs are bare", sheer: "the legs show through sheer fabric" },
  feet: { bare: "barefoot", sheer: "the feet show through sheer fabric" },
};

const FRAME_REGIONS: Readonly<Record<VisualSegmentTaskPolicy["frame"], readonly (keyof RegionExposure)[]>> = {
  waist_up: ["torso"],
  full_figure: ["torso", "pelvis", "legs", "feet"],
};

function exposureClauses(exposure: RegionExposure, frame: VisualSegmentTaskPolicy["frame"]): string[] {
  const clauses: string[] = [];
  for (const region of FRAME_REGIONS[frame]) {
    const coverage = exposure[region];
    if (coverage === "covered") continue;
    if (region === "legs" && coverage === "bare" && exposure.pelvis === "bare") continue;
    clauses.push(EXPOSURE_CLAUSES[region][coverage]);
  }
  return clauses;
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

/** Clauses of one segment, joined as prompt prose. */
function joinClauses(clauses: readonly string[]): string {
  return `${clauses.join("; ")}.`;
}

function segmentOf(
  kind: ImagePromptSegmentKind,
  text: string,
  mandatory: boolean,
  priority: number,
): ImagePromptSegment {
  return { kind, text, mandatory, priority, source: IMAGE_SUBJECT_PROJECTION_OWNER };
}

/**
 * One subject's ordered prompt segments from a committed visual digest.
 * Policy gates run first, then clause resolution; everything excluded is a
 * recorded suppression, and a required fact with nothing to say is reported
 * rather than papered over. Deterministic over its inputs.
 */
export function buildVisualSubjectSegments(input: VisualSubjectSegmentsInput): VisualSubjectSegmentsBuild {
  const { digest, policy, exposure, sink } = input;
  const subject = digest.subjects.find((entry) => entry.subjectId === input.subjectId);
  if (subject === undefined) {
    sink?.push(
      diag("warn", VISUAL_SEGMENTS_SUBJECT_UNKNOWN, "The requested subject is not in this visual digest", {
        path: SEGMENTS_PATH,
        context: { subjectId: input.subjectId, cutId: digest.cutId },
      }),
    );
    return { segments: [], suppressions: [], missingRequired: [] };
  }

  const suppressions: VisualStateSuppression[] = [];
  const unresolvedRequired: string[] = [];
  /** One mandatory segment per kind: required clauses first, optional detail after. */
  const grouped = new Map<ImagePromptSegmentKind, string[]>();
  const optionalSegments: ImagePromptSegment[] = [];

  for (const fact of [...subject.required, ...subject.optional]) {
    const suppression = policySuppression(fact, policy, exposure);
    if (suppression !== null) {
      suppressions.push({ key: fact.key, code: suppression.code, detail: suppression.detail });
      continue;
    }
    const clause = input.clause(fact);
    if (clause === undefined) {
      suppressions.push({ key: fact.key, code: VISUAL_SEGMENTS_CLAUSE_UNRESOLVED });
      if (fact.required) {
        unresolvedRequired.push(fact.key);
        sink?.push(
          diag("warn", VISUAL_SEGMENTS_CLAUSE_UNRESOLVED, "A required visual fact resolved no prompt clause", {
            path: SEGMENTS_PATH,
            context: { key: fact.key, kindId: fact.kindId },
          }),
        );
      }
      continue;
    }
    if (typeof clause !== "string") {
      suppressions.push({ key: fact.key, code: VISUAL_SEGMENTS_CLAUSE_OMITTED, detail: clause.omit });
      continue;
    }
    const text = clause.trim();
    if (text.length === 0) {
      suppressions.push({ key: fact.key, code: VISUAL_SEGMENTS_CLAUSE_UNRESOLVED, detail: "empty" });
      if (fact.required) unresolvedRequired.push(fact.key);
      continue;
    }
    if (fact.required || isMandatoryImagePromptSegmentKind(fact.segmentKind)) {
      const clauses = grouped.get(fact.segmentKind) ?? [];
      clauses.push(text);
      grouped.set(fact.segmentKind, clauses);
    } else {
      optionalSegments.push(segmentOf(fact.segmentKind, `${text}.`, false, fact.priority));
    }
  }

  const segments: ImagePromptSegment[] = [];
  for (const [kind, clauses] of grouped) {
    segments.push(segmentOf(kind, joinClauses(clauses), true, AFFORDANCE_UNIT_ONE));
  }
  segments.push(...optionalSegments);

  const bared = exposureClauses(exposure, policy.frame);
  if (bared.length > 0) {
    segments.push(segmentOf("exposure", joinClauses(bared), true, AFFORDANCE_UNIT_ONE));
  }

  return {
    segments: orderImagePromptSegments(segments),
    suppressions,
    missingRequired: [...subject.missingMandatory, ...unresolvedRequired],
  };
}
