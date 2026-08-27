import {
  realizeVisualImageDigest,
  visualImageProvenanceOf,
  VISUAL_IMAGE_PROVENANCE_META_KEY,
  type DiagnosticSink,
  type VisualAttentionContext,
  type VisualImageDigest,
  type VisualImageProvenance,
  type VisualImageSelection,
  type VisualStateSnapshot,
} from "@/contracts";
import type { VisualStateShadowBuild } from "./shadow";

/**
 * SERVER-SIDE IMAGE DIGEST ASSEMBLY.
 *
 * The contracts layer owns the digest itself — what a committed cut selects,
 * how it classifies each fact, and the compact provenance a render stores. This
 * module is the thin server seam that feeds it a LIVE cut: it takes the
 * assembly's snapshot and the selection already built over it, realizes the
 * digest, derives the provenance, and hands back the `meta` fragment an image
 * row merges (mirroring `images/entity-prompt-program.ts`, which returns
 * `meta.promptProgram` / `meta.worldState` the same way).
 *
 * Like the rest of this folder it is PURE over passed-in committed state: no
 * IO, no env, no clock, no import from another server area. Nothing here writes
 * an image row — persistence lands with the first consuming render route.
 *
 * ## Reuse the selection, never re-select
 *
 * The digest's consistency gate refuses a selection built from a different
 * snapshot, but it cannot see a context that merely LOOKS like the one the
 * selection ran under. A second `selectVisualImageFacts` call — even with
 * identical-looking inputs — would fingerprint a camera nobody selected under.
 * So the shadow build carries its image context out (`imageContext`), and this
 * module realizes from that exact triple.
 *
 * ## The camera is still the shadow placeholder
 *
 * `visual_state_shadow` is the viewpoint the lane assembly uses, and it stays
 * one until a render route binds a committed scene camera through
 * `visualCameraReadsOfSceneCamera`. This module accepts the context rather than
 * building one precisely so that cutover is a caller change, not a rewrite
 * here — and so nothing invents a studio viewpoint in the meantime.
 *
 * ## Degradation
 *
 * A digest whose fail-closed gates fired (stale cut, foreign selection, wrong
 * consumer) still comes back: an empty digest carrying its suppressions, plus
 * the diagnostic the contracts layer already pushed to the sink. This seam
 * never throws and never substitutes a fabricated digest — whether a render is
 * eligible on an incomplete digest is the caller's decision (docs/resilience.md:
 * degraded defaults over failed turns, diagnostics over exceptions).
 */

export interface VisualStateImageDigestInput {
  readonly snapshot: VisualStateSnapshot;
  /** The camera context the selection was built under, carried, never rebuilt. */
  readonly context: VisualAttentionContext;
  readonly selection: VisualImageSelection;
  /** The committed cut this render is for; a different snapshot fails closed. */
  readonly forCutId?: string;
  readonly sink?: DiagnosticSink;
}

/** The digest, its stored provenance, and the image-row `meta` fragment. */
export interface VisualStateImageDigestBuild {
  readonly digest: VisualImageDigest;
  readonly provenance: VisualImageProvenance;
  /** `meta.visualState`, ready to merge onto an image row beside `meta.render`. */
  readonly meta: Record<string, unknown>;
}

/** Realize the digest over one committed cut and derive what a render stores. */
export function buildVisualStateImageDigest(input: VisualStateImageDigestInput): VisualStateImageDigestBuild {
  const digest = realizeVisualImageDigest({
    snapshot: input.snapshot,
    context: input.context,
    selection: input.selection,
    ...(input.forCutId === undefined ? {} : { forCutId: input.forCutId }),
    ...(input.sink === undefined ? {} : { sink: input.sink }),
  });
  const provenance = visualImageProvenanceOf(digest);
  return { digest, provenance, meta: { [VISUAL_IMAGE_PROVENANCE_META_KEY]: provenance } };
}

/**
 * The shadow-build form: realize the digest from the build's own snapshot,
 * image selection, and the context that selection ran under. `forCutId` is the
 * render's committed cut when a caller has one — the inspector, recomputing the
 * cut it just assembled, has nothing to disagree with and passes none.
 */
export function visualStateImageDigestOfShadow(
  build: VisualStateShadowBuild,
  options?: { readonly forCutId?: string; readonly sink?: DiagnosticSink },
): VisualStateImageDigestBuild {
  return buildVisualStateImageDigest({
    snapshot: build.snapshot,
    context: build.imageContext,
    selection: build.image,
    ...(options?.forCutId === undefined ? {} : { forCutId: options.forCutId }),
    ...(options?.sink === undefined ? {} : { sink: options.sink }),
  });
}
