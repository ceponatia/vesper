import { and, eq } from "drizzle-orm";
import {
  identityCandidateReferenceSpecs,
  identityReferenceProvenanceListSchema,
  type IdentityReferenceCandidate,
  type IdentityReferenceProvenance,
  type ImageIdentityPackFailureCode,
  type ImageRenderReference,
  type ResolvedImageProfile,
  type SceneReferenceSource,
} from "@vesper/image-core";
import { diag, type DiagnosticSink } from "@/contracts/diagnostics";
import { readAppearanceRevision } from "@/contracts/images/appearance-revision";
import { db, images } from "../db";
import { imageMeta, readImageBytes } from "./asset-storage";
import { evaluateIdentityPackForProfile } from "./identity-pack-references";

/**
 * The render lanes' identity-pack entry: evaluate the pack under the
 * resolved profile's declared strategy, read the authorized bytes for what the
 * evaluation allowed, and hand back render-intent references with the provenance
 * that must travel to the output row's meta.
 *
 * This is the ONLY identity source the lanes have (the slice-7 close-out
 * removed the rollout flag and the legacy direct-avatar reads): every
 * identity-critical render sources its references here, and the trial and
 * admin surfaces exercise the same path directly.
 *
 * Refusal is a VALUE, before any provider spend: an ineligible pack refuses the
 * identity-critical render rather than substituting another Gallery image (the
 * spec's explicit prohibition), and each lane settles that refusal into its own
 * failure shape. The evaluation pushes `images.identity_pack.profile_ineligible`;
 * this module adds `images.identity_pack.reference_fetch_failed` for candidate
 * bytes that could not be read.
 */

/** One selected reference with everything a lane records or sends about it. */
export interface IdentityPackRenderReference {
  /** Ready for `renderImageIntent`: the generic `identity` role, bytes attached. */
  reference: ImageRenderReference;
  /** The record for the output row's `meta.identityReferences` entry. */
  provenance: IdentityReferenceProvenance;
  /** The pack's own answer — role, ids, measurements. */
  candidate: IdentityReferenceCandidate;
  /** How the scene lane tags an anchor: whether the stored row began as an upload. */
  source: SceneReferenceSource;
  /**
   * What the CANONICAL PORTRAIT this pack was derived from depicts — its
   * appearance revision (issue #551, `contracts/images/appearance-revision.ts`).
   *
   * The portrait's own, not the crop's: a face crop is a rectangle cut out of it
   * by local derivation, which renders nothing and so stamps nothing, and every
   * role in one pack shows the same person at the same moment. Null for an
   * uploaded portrait, for one rendered before this contract existed, and
   * whenever the source row cannot be read — all of which compare as `unknown`
   * and compile what the lane compiled before the stamp existed.
   */
  appearanceRevision: string | null;
}

export type IdentityPackRenderReferencesResult =
  | {
      ok: true;
      /** In profile-plan send order, only entries whose bytes were actually read. */
      references: IdentityPackRenderReference[];
      /** Parallel to `references` — exactly what a lane persists for this send. */
      provenance: IdentityReferenceProvenance[];
    }
  | {
      ok: false;
      code: ImageIdentityPackFailureCode | "profile_ineligible" | "reference_fetch_failed";
      error: string;
    };

export interface IdentityPackRenderReferencesInput {
  ownerId: string;
  characterId: string;
  /** The lane's resolved profile — its policy declares the identity strategy. */
  profile: ResolvedImageProfile;
  sink?: DiagnosticSink;
}

/**
 * Resolve one character's identity references for one flag-on render.
 *
 * Evaluation runs before any byte read (a blocked pack stops the render before
 * budget is spent), and the bytes are read through
 * an owner-scoped, ready-only query — the same authorization the rest of the
 * image service applies, never a bare id read.
 *
 * An unreadable REQUIRED candidate refuses the render; an unreadable optional
 * one is omitted loudly, mirroring the evaluation's own optional-role rule. The
 * returned provenance covers only what will actually be sent.
 */
export async function identityPackRenderReferences(
  input: IdentityPackRenderReferencesInput,
): Promise<IdentityPackRenderReferencesResult> {
  const { ownerId, characterId, sink } = input;
  const evaluated = await evaluateIdentityPackForProfile({
    ownerId,
    characterId,
    strategy: input.profile.profile.referencePolicy.identityStrategy,
    purpose: "identity_render",
    sink,
  });
  if (!evaluated.eligible) {
    return { ok: false, code: evaluated.code, error: `identity references unavailable (${evaluated.messageKey})` };
  }

  // One read for the whole selection: every candidate in one evaluation comes
  // from one pack revision, so they all name the same accepted portrait and its
  // stamp is one fact rather than one per role.
  const appearanceRevision = await readSourceAppearanceRevision(
    evaluated.candidates[0]?.sourceImageId ?? null,
    ownerId,
    characterId,
  );
  const specs = identityCandidateReferenceSpecs(evaluated.candidates);
  const references: IdentityPackRenderReference[] = [];
  const provenance: IdentityReferenceProvenance[] = [];
  for (const [index, candidate] of evaluated.candidates.entries()) {
    const spec = specs[index];
    const record = evaluated.provenance[index];
    if (!spec || !record) continue; // unreachable: both lists are candidate-parallel
    const loaded = await readOwnedReadyImage(candidate.imageId, ownerId);
    if (!loaded) {
      sink?.push(
        diag(
          "warn",
          "images.identity_pack.reference_fetch_failed",
          `${candidate.role} reference bytes unreadable${candidate.required ? "" : " — optional role omitted"}`,
          { context: { characterId, imageId: candidate.imageId, role: candidate.role, required: candidate.required } },
        ),
      );
      if (candidate.required) {
        return { ok: false, code: "reference_fetch_failed", error: `the ${candidate.role} reference could not be read` };
      }
      continue;
    }
    references.push({
      reference: { ...spec, buffer: loaded.buffer },
      provenance: record,
      candidate,
      source: loaded.uploaded ? "uploaded" : "generated",
      appearanceRevision,
    });
    provenance.push(record);
  }

  if (references.length === 0) {
    return { ok: false, code: "reference_fetch_failed", error: "no identity reference could be read" };
  }
  // Through the schema on the way out so what a lane persists is exactly the
  // degraded-safe shape `meta.identityReferences` readers will parse.
  return { ok: true, references, provenance: identityReferenceProvenanceListSchema.parse(provenance) };
}

/**
 * The appearance the pack's canonical portrait DEPICTS, read off that row's own
 * meta under the owner (issue #551).
 *
 * Read from the image rather than copied onto the pack row when the pack is
 * derived, because the two answers differ exactly where it matters: derivation
 * runs at acceptance, and an owner who accepts an older portrait after a haircut
 * would have the pack claim the haircut it does not show. The image is the only
 * thing that knows what it shows, and it was stamped when it was drawn.
 *
 * Every failure — no row, not this owner's, no stamp, a stamp for somebody else
 * — reads null, which compares as `unknown`.
 */
async function readSourceAppearanceRevision(
  sourceImageId: string | null,
  ownerId: string,
  characterId: string,
): Promise<string | null> {
  if (sourceImageId === null) return null;
  const [row] = await db()
    .select({ meta: images.meta })
    .from(images)
    .where(and(eq(images.id, sourceImageId), eq(images.ownerId, ownerId)))
    .limit(1);
  return row === undefined ? null : readAppearanceRevision(row.meta, characterId);
}

/** Bytes + origin for one owned, ready image; null for missing, foreign, unready or file-less. */
async function readOwnedReadyImage(
  imageId: string,
  ownerId: string,
): Promise<{ buffer: Buffer; uploaded: boolean } | null> {
  const [row] = await db()
    .select()
    .from(images)
    .where(and(eq(images.id, imageId), eq(images.ownerId, ownerId), eq(images.status, "ready")))
    .limit(1);
  if (!row) return null;
  const buffer = await readImageBytes(row);
  if (!buffer) return null;
  return { buffer, uploaded: imageMeta(row.meta).source === "upload" };
}
