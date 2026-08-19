import { imageConcept, type ImageConceptId } from "./concepts";
import {
  imageMediumProtections,
  imageMorphologyProtectionOf,
  type ImageConflictKey,
} from "./conflict-keys";
import { imageFramingIsCropped, imageMotionImpliesBlur } from "./camera-bands";
import type { ImageNegativeBlockId, ImageNegativeConstraint } from "./negative-constraints";
import type { ImagePositiveClaim } from "./positive-claims";
import type { ImageCameraFact, ImageOperationContract } from "./world-digest";

/**
 * The conflict linter (model-aware-image-prompts.plan.md §"Conflict linter").
 *
 * This is the single place where the two independently-versioned prompt channels
 * are reconciled, and the reason they may be versioned independently at all: a
 * negative pack can be researched, promoted and rolled back without anybody
 * having to reason about whether it forbids something the world requires,
 * because that question is answered here, deterministically, on every render.
 *
 * The mechanism is set subtraction over conflict keys, and it is deliberately
 * boring. A claim declares the keys it protects; a constraint declares the keys
 * it forbids; a key claimed on both sides is removed from the NEGATIVE, because
 * the plan's rule is that a conflict with authoritative world truth resolves in
 * favor of truth. A constraint that loses every key is dropped with a reason. A
 * REQUIRED constraint that loses every key makes the profile ineligible before
 * any provider spend, rather than rendering something Vesper knows is wrong.
 *
 * What it is not: a semantic model of English. It cannot tell that "avoid busy
 * scenes" overlaps "a crowded market", and it does not try — that is what makes
 * every rule here checkable in a unit test instead of an eyeball comparison.
 * Keeping the keys closed and small is how the coverage stays honest.
 */

/** One protection: a key, and the claim that put it beyond reach. */
export interface ImageConflictProtection {
  readonly key: ImageConflictKey;
  readonly claimId: string;
  readonly concept: ImageConceptId;
}

/**
 * Every key this render's positive side protects, with the claim responsible.
 *
 * Two sources, and both are needed. STATIC protections come from the concept
 * registry — asserting `location.signage` protects lettering whatever the sign
 * says. DERIVED protections depend on the value: which medium was named, which
 * framing band the camera asked for, whether the cast is one person or five, and
 * which morphology tags a subject's facts carry.
 *
 * Recording the responsible claim rather than a bare key set is what lets a
 * dropped constraint explain itself. "background_clutter dropped" tells an
 * operator nothing; "dropped because location.contents lists the shelving" tells
 * them the render is behaving correctly.
 */
export function imagePositiveProtections(input: {
  readonly claims: readonly ImagePositiveClaim[];
  readonly operation: ImageOperationContract;
  readonly camera: readonly ImageCameraFact[];
}): readonly ImageConflictProtection[] {
  const protections: ImageConflictProtection[] = [];
  const add = (key: ImageConflictKey, claimId: string, concept: ImageConceptId): void => {
    protections.push({ key, claimId, concept });
  };

  for (const claim of input.claims) {
    const definition = imageConcept(claim.concept);
    for (const key of definition?.protects ?? []) add(key, claim.id, claim.concept);
    // Morphology protections ride the fact's own tags, so a tail protects
    // appendages while an ordinary shoulder protects nothing — see
    // `imageMorphologyProtectionTags` for why the handshake is a tag.
    for (const tag of claim.semanticTags) {
      const key = imageMorphologyProtectionOf(tag);
      if (key !== null) add(key, claim.id, claim.concept);
    }
  }

  // The requested medium. Read off the operation rather than off a style claim,
  // because the medium is a fact about the job and survives a budget squeeze that
  // could drop the claim describing it.
  for (const key of imageMediumProtections(input.operation.style.medium)) {
    add(key, "operation.style.medium", "style.medium");
  }

  // An ensemble. "No multiple people" against a two-hander is the plan's named
  // collision, and the cast size is on the operation contract precisely so this
  // check never has to count subject slices.
  if (input.operation.subjectCount > 1) add("multiple_people", "operation.subject_count", "operation.subject_count");

  // Camera intent. A portrait crop asks to cut the figure and a moving subject
  // asks for blur; forbidding either would be the prompt arguing with the shot.
  for (const fact of input.camera) {
    if (fact.component === "framing" && imageFramingIsCropped(fact.band)) {
      add("cropped", "camera.framing", "camera.framing");
      add("close_up", "camera.framing", "camera.framing");
      add("out_of_frame", "camera.framing", "camera.framing");
    }
    if (fact.component === "motion" && imageMotionImpliesBlur(fact.band)) {
      add("blur", "camera.motion", "camera.motion");
    }
  }

  return protections;
}

/** What the linter decided about one constraint. */
export interface ImageCollisionDecision {
  readonly constraintId: ImageNegativeBlockId;
  readonly outcome: "kept" | "narrowed" | "dropped";
  /** The keys that survived, in the constraint's own order. */
  readonly keptKeys: readonly ImageConflictKey[];
  /** Every removal, with the claim that caused it. */
  readonly removed: readonly ImageConflictProtection[];
}

export interface ImageCollisionReport {
  /** The constraints as they should now be compiled — narrowed, never rewritten. */
  readonly constraints: readonly ImageNegativeConstraint[];
  readonly decisions: readonly ImageCollisionDecision[];
  /**
   * Required constraints the world contradicted outright.
   *
   * Non-empty means this profile may not render: a required exclusion that
   * cannot be expressed is the plan's fail-closed case, and running anyway would
   * produce an image Vesper already knows disagrees with its own state.
   */
  readonly refusedRequired: readonly ImageNegativeBlockId[];
}

/**
 * Subtract world truth from the selected exclusions.
 *
 * A constraint whose keys are all protected is DROPPED rather than emitted with
 * an empty roster, because a dialect handed an empty key list would either emit
 * nothing (a wasted entry in provenance) or fall back on its own wording (the
 * exact reach-around this design forbids).
 *
 * The `provider_default_override` constraint is the one that carries no keys by
 * construction. It is never narrowed and never dropped: what it neutralizes is a
 * wrapper's injected text, which no world fact can protect.
 */
export function lintImagePromptCollisions(input: {
  readonly constraints: readonly ImageNegativeConstraint[];
  readonly protections: readonly ImageConflictProtection[];
}): ImageCollisionReport {
  const byKey = new Map<ImageConflictKey, ImageConflictProtection>();
  for (const protection of input.protections) {
    if (!byKey.has(protection.key)) byKey.set(protection.key, protection);
  }

  const constraints: ImageNegativeConstraint[] = [];
  const decisions: ImageCollisionDecision[] = [];
  const refusedRequired: ImageNegativeBlockId[] = [];

  for (const constraint of input.constraints) {
    // A keyless constraint is the provider-default override. It has nothing to
    // subtract and everything to say, so it passes through untouched.
    if (constraint.conflictKeys.length === 0) {
      constraints.push(constraint);
      decisions.push({ constraintId: constraint.id, outcome: "kept", keptKeys: [], removed: [] });
      continue;
    }
    const keptKeys: ImageConflictKey[] = [];
    const removed: ImageConflictProtection[] = [];
    for (const key of constraint.conflictKeys) {
      const protection = byKey.get(key);
      if (protection === undefined) keptKeys.push(key);
      else removed.push(protection);
    }
    if (keptKeys.length === 0) {
      decisions.push({ constraintId: constraint.id, outcome: "dropped", keptKeys, removed });
      if (constraint.required) refusedRequired.push(constraint.id);
      continue;
    }
    constraints.push(keptKeys.length === constraint.conflictKeys.length ? constraint : { ...constraint, conflictKeys: keptKeys });
    decisions.push({
      constraintId: constraint.id,
      outcome: removed.length === 0 ? "kept" : "narrowed",
      keptKeys,
      removed,
    });
  }

  return { constraints, decisions, refusedRequired };
}

/**
 * The reverse check: does any compiled negative key also appear on the positive
 * side after transport resolution?
 *
 * Run AFTER positive replacement claims are merged, because that merge is the one
 * step that can reintroduce a contradiction the first pass cleared — a negative
 * constraint compiled to an affirmative claim adds a claim, and a claim adds
 * protections. Anything this finds is a compiler bug rather than a pack problem,
 * so it is reported as a hard invariant rather than quietly repaired.
 */
export function imagePostMergeCollisions(input: {
  readonly constraints: readonly ImageNegativeConstraint[];
  readonly protections: readonly ImageConflictProtection[];
}): readonly ImageConflictProtection[] {
  const forbidden = new Set<ImageConflictKey>(input.constraints.flatMap((constraint) => constraint.conflictKeys));
  return input.protections.filter((protection) => forbidden.has(protection.key));
}
