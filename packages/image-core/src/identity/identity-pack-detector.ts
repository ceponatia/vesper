import type { DetectedFaceCandidate } from "./identity-pack";

/**
 * The face-detection seam.
 *
 * The interface lives here rather than in `src/contracts` because `detect()` takes
 * a Node `Buffer`, and nothing in the pure contracts layer references binary or
 * platform types. Its OUTPUT (`DetectedFaceCandidate`) is plain numbers and stays
 * in contracts, where the pure candidate-ruling helpers can read it.
 *
 * An adapter reports what it SAW and makes no product decision. Choosing which
 * face a pack is about — or refusing to choose — is
 * `selectIdentityFaceCandidate`'s job, under a versioned policy, so that swapping
 * detector libraries can never quietly change who a character looks like.
 */

export interface IdentityFaceDetector {
  /** Stamped onto every detector revision; a change here is evaluated against the
   * derivation version (spec.lifecycle.md §"Staleness rules"). */
  version: string;
  detect(image: Buffer): Promise<DetectedFaceCandidate[]>;
}

/**
 * The shipped v1 adapter: a real seam that finds nothing.
 *
 * This is a deliberate stance, not a stub someone forgot to finish. Automatic
 * derivation is therefore heuristic-only — a portrait-shaped canonical source
 * gets the deterministic `heuristic_v1` crop, and every other shape fails closed
 * with `no_usable_face` rather than guessing a rectangle out of a group shot.
 *
 * Two reasons the real detector is not here yet:
 *
 * 1. **Library selection is a trial-slice decision.** The fixed corpus
 *    (`image-identity-packs.spec.trial.md`) is what decides whether a given
 *    detector is good enough, and the pack contract deliberately does not depend
 *    on one library — so picking before there is anything to measure would be
 *    picking blind.
 * 2. **The portrait must never leave this machine.** Any candidate adapter runs
 *    locally; uploading a user's canonical portrait to an unreviewed third-party
 *    face-analysis service is a separate privacy and provider review
 *    (spec.lifecycle.md §"Privacy boundary"), never a configuration flip.
 *
 * Until then the seam is exercised in full by injected test detectors, so the
 * detector code path is proven before any library lands behind it.
 */
export const nullIdentityFaceDetector: IdentityFaceDetector = {
  version: "null_v1",
  detect: async () => [],
};

/** Test-only override; `null` restores the shipped adapter. Process-local. */
let injected: IdentityFaceDetector | null = null;

/** The detector `ensureIdentityPack` runs — the injected one in tests, else the shipped adapter. */
export function identityFaceDetector(): IdentityFaceDetector {
  return injected ?? nullIdentityFaceDetector;
}

/**
 * Swap the detector for a scripted one. Integration tests use this to drive the
 * detector, ambiguity and exception paths that `nullIdentityFaceDetector` can
 * never reach; production never calls it. Pass `null` in teardown so one suite's
 * fake cannot leak into the next.
 */
export function setIdentityFaceDetectorForTesting(detector: IdentityFaceDetector | null): void {
  injected = detector;
}
