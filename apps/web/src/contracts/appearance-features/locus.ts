import { z } from "zod";
import { bodyLocationRegistry } from "../body/locations";
import { diag, type DiagnosticSink } from "../diagnostics";

/**
 * Fine body locus without coverage-tree explosion.
 *
 * The body-location tree stays coarse for coverage (`hands` → `fingers`);
 * recognition and acquired topology address finer structure through a
 * registry-validated detail path instead of new coverage nodes. The coarse
 * `bodyLocationId` is always legal and remains the coverage fallback.
 *
 * FROZEN SEAM (slice 7): the exported names and shapes in this file are the
 * interface between the appearance-features package and the affordance
 * recognition layer. Add exports freely; do not rename or reshape these.
 */

export const bodyLocusSides = ["left", "right", "center"] as const;

export const bodyLocusSideSchema = z.enum(bodyLocusSides);

export type BodyLocusSide = z.infer<typeof bodyLocusSideSchema>;

/** Registry id of a finite fine-detail schema (e.g. `humanoid_hand_v1`). */
export type BodyDetailSchemaId = string;

/** One registry-validated segment of a detail path (e.g. `ring_finger`). */
export type BodyDetailSegmentId = string;

/** The first (and, in slice 7, only) fine-detail schema: left/right named digits. */
export const HUMANOID_HAND_DETAIL_SCHEMA_ID = "humanoid_hand_v1";

export const humanoidHandSegmentIds = [
  "thumb",
  "index_finger",
  "middle_finger",
  "ring_finger",
  "little_finger",
] as const;

export const bodyLocusDetailSchema = z.object({
  schemaId: z.string().min(1),
  path: z.array(z.string().min(1)).min(1).max(4),
});

export type BodyLocusDetail = z.infer<typeof bodyLocusDetailSchema>;

export const bodyLocusRefSchema = z.object({
  bodyLocationId: z.string().min(1),
  side: bodyLocusSideSchema.optional(),
  detail: bodyLocusDetailSchema.optional(),
});

export type BodyLocusRef = z.infer<typeof bodyLocusRefSchema>;

/**
 * Deterministic key for a locus — `bodyLocationId[:side][:path segments]`,
 * e.g. `fingers:left:ring_finger`. Used inside feature keys and as the
 * grouping key for anatomy state; never parsed back into parts.
 */
export function bodyLocusKey(locus: BodyLocusRef): string {
  const parts: string[] = [locus.bodyLocationId];
  if (locus.side) parts.push(locus.side);
  if (locus.detail) parts.push(...locus.detail.path);
  return parts.join(":");
}

// ---------------------------------------------------------------------------
// The finite detail-schema registry
// ---------------------------------------------------------------------------

/**
 * One registered fine-detail schema. Flat for v1 (`segments` is the closed set
 * of legal path elements and `maxPathDepth` is 1); a later schema that needs a
 * small tree grows this shape rather than admitting free text — "detail paths
 * are registry-validated, never free text".
 *
 * `appliesToBodyLocationIds` is what keeps a hand schema off a nose: the
 * coarse location the path hangs from must be one of these (or a descendant of
 * one), so `{fingers, humanoid_hand_v1:[ring_finger]}` is legal while
 * `{nose, humanoid_hand_v1:[ring_finger]}` is not.
 */
export interface BodyDetailSchemaDefinition {
  readonly id: BodyDetailSchemaId;
  readonly label: string;
  readonly segments: readonly BodyDetailSegmentId[];
  readonly appliesToBodyLocationIds: readonly string[];
  readonly maxPathDepth: number;
}

/** The first (and, in slice 7, only) registered schema: left/right named digits. */
export const humanoidHandDetailSchemaDefinition: BodyDetailSchemaDefinition = {
  id: HUMANOID_HAND_DETAIL_SCHEMA_ID,
  label: "humanoid hand",
  segments: humanoidHandSegmentIds,
  appliesToBodyLocationIds: ["hands", "fingers"],
  maxPathDepth: 1,
};

/** Every registered detail schema, by id. Seeded with the humanoid hand only. */
export const bodyDetailSchemas: ReadonlyMap<BodyDetailSchemaId, BodyDetailSchemaDefinition> = new Map([
  [humanoidHandDetailSchemaDefinition.id, humanoidHandDetailSchemaDefinition],
]);

export function bodyDetailSchemaById(id: string): BodyDetailSchemaDefinition | undefined {
  return bodyDetailSchemas.get(id);
}

// ---------------------------------------------------------------------------
// Validation — healing for appearance reads, fail-closed for topology writes
// ---------------------------------------------------------------------------

/** The locus shape itself was unusable (not an object, empty id, …). */
export const APPEARANCE_LOCUS_MALFORMED = "appearance.locus.malformed";
/** `bodyLocationId` is not in the body-location registry — always fails closed. */
export const APPEARANCE_LOCUS_UNKNOWN_LOCATION = "appearance.locus.unknown_location";
/** An appearance-only read dropped an unsupported detail path to the coarse locus. */
export const APPEARANCE_LOCUS_DETAIL_COARSENED = "appearance.locus.detail_coarsened";
/** A topology write named a detail path the registry cannot validate — rejected. */
export const APPEARANCE_LOCUS_DETAIL_INVALID = "appearance.locus.detail_invalid";

export interface BodyLocusValidationOk {
  readonly ok: true;
  readonly locus: BodyLocusRef;
  /** True when an unsupported detail path was dropped back to the coarse locus. */
  readonly coarsened: boolean;
}

export interface BodyLocusValidationRejected {
  readonly ok: false;
  readonly locus: null;
  readonly coarsened: false;
}

export type BodyLocusValidation = BodyLocusValidationOk | BodyLocusValidationRejected;

const REJECTED_LOCUS: BodyLocusValidationRejected = { ok: false, locus: null, coarsened: false };

/**
 * Drop a locus to its coarse form — the containment fallback the spec allows
 * for appearance-only reads: a mark ON the ring finger is still, truthfully, a
 * mark on the fingers, so widening keeps the value semantically true.
 *
 * This is exactly why topology may NOT coarsen: "the ring finger is absent"
 * widened to "the fingers are absent" is a different, false claim. Anatomy
 * state therefore uses `validateBodyLocusRefStrict`.
 */
export function coarsenBodyLocusRef(locus: BodyLocusRef): BodyLocusRef {
  if (locus.detail === undefined) return locus;
  return locus.side === undefined
    ? { bodyLocationId: locus.bodyLocationId }
    : { bodyLocationId: locus.bodyLocationId, side: locus.side };
}

/** Why a detail path is unusable, or null when it validates. */
function detailPathIssue(locus: BodyLocusRef): string | null {
  const detail = locus.detail;
  if (detail === undefined) return null;
  const schema = bodyDetailSchemas.get(detail.schemaId);
  if (!schema) return `unknown detail schema ${detail.schemaId}`;
  const applies = schema.appliesToBodyLocationIds.some((id) =>
    bodyLocationRegistry.expand(id).includes(locus.bodyLocationId),
  );
  if (!applies) return `detail schema ${schema.id} does not apply to ${locus.bodyLocationId}`;
  if (detail.path.length > schema.maxPathDepth) {
    return `detail path is deeper than ${schema.maxPathDepth} for ${schema.id}`;
  }
  const unknown = detail.path.find((segment) => !schema.segments.includes(segment));
  return unknown === undefined ? null : `unknown ${schema.id} path segment ${unknown}`;
}

function validateLocus(
  locus: BodyLocusRef,
  mode: "appearance" | "topology",
  sink: DiagnosticSink | undefined,
  path: string,
): BodyLocusValidation {
  const parsed = bodyLocusRefSchema.safeParse(locus);
  if (!parsed.success) {
    sink?.push(diag("warn", APPEARANCE_LOCUS_MALFORMED, "Body locus is not a usable reference", { path }));
    return REJECTED_LOCUS;
  }
  const ref = parsed.data;
  if (!bodyLocationRegistry.byId(ref.bodyLocationId)) {
    sink?.push(
      diag("warn", APPEARANCE_LOCUS_UNKNOWN_LOCATION, `Unknown body location ${ref.bodyLocationId}`, {
        path,
        context: { bodyLocationId: ref.bodyLocationId },
      }),
    );
    return REJECTED_LOCUS;
  }
  const issue = detailPathIssue(ref);
  if (issue === null) return { ok: true, locus: ref, coarsened: false };
  if (mode === "topology") {
    sink?.push(diag("warn", APPEARANCE_LOCUS_DETAIL_INVALID, issue, { path, context: { locus: bodyLocusKey(ref) } }));
    return REJECTED_LOCUS;
  }
  sink?.push(
    diag("warn", APPEARANCE_LOCUS_DETAIL_COARSENED, `${issue}; read at the coarse locus instead`, {
      path,
      context: { locus: bodyLocusKey(ref), coarse: ref.bodyLocationId },
    }),
  );
  return { ok: true, locus: coarsenBodyLocusRef(ref), coarsened: true };
}

/**
 * Appearance-only validation: an unknown body location fails closed, while an
 * unsupported detail path HEALS to the coarse locus with a warn diagnostic
 * (see `coarsenBodyLocusRef` for why that stays true).
 */
export function validateBodyLocusRef(
  locus: BodyLocusRef,
  sink?: DiagnosticSink,
  path = "appearance.locus",
): BodyLocusValidation {
  return validateLocus(locus, "appearance", sink, path);
}

/**
 * Topology validation: fail closed. Anything the registry cannot validate is
 * rejected with a diagnostic rather than silently widened, because a topology
 * claim is not true at a coarser locus: unsupported detail fails closed for
 * topology writes.
 */
export function validateBodyLocusRefStrict(
  locus: BodyLocusRef,
  sink?: DiagnosticSink,
  path = "appearance.anatomy.locus",
): BodyLocusValidation {
  return validateLocus(locus, "topology", sink, path);
}
