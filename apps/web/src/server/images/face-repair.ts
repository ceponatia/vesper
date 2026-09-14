import { and, eq } from "drizzle-orm";
import { z } from "zod";
import {
  controlReferenceTransport,
  faceRepairInstruction,
  parseImageWorldStateProvenance,
  type IdentityReferenceProvenance,
  type ImageModel,
  type ResolvedImageProfile,
} from "@vesper/image-core";
import type {
  FaceRepairMethod,
  FaceRepairSubjectCheck,
  ImageGeneratorCreateRunRequest,
} from "@/contracts/images/image-generator";
import { diag, type DiagnosticSink } from "@/contracts/diagnostics";
import { characters, db, imageReferences, images } from "../db";
import { HIDDEN_IMAGE_KINDS, imageMeta, type ImageEntityKind, type ImageKind, type ImageRow } from "./asset-storage";
import { getIdentityPackForOwner } from "./identity-pack-read";

/**
 * Issue #246 — the flagged owner-admin face-repair action.
 *
 * This module is split in two, deliberately kept in one file rather than two:
 * a PURE half (`planFaceRepair`, `resolveFaceRepairMethod`,
 * `pairFaceRepairIdentityProfile`, `buildFaceRepairRunRequest`) that takes
 * plain values and a database connection touches nothing, and a LOADS half
 * (the `loadFaceRepair*` functions) that reads exactly the owner-scoped rows
 * the route needs before calling the pure half. The split is what makes the
 * multi-person table in the issue's design doc a fixture-per-row unit test
 * instead of an integration test — `face-repair.test.ts` never opens a
 * database connection.
 *
 * The repair instruction itself (`faceRepairInstruction`) is not authored
 * here: a numbered slot label like "Image 2" is `packages/image-core`'s to
 * write (`scripts/image-reference-numbering.test.ts`'s census forbids a new
 * one under `server/images`), so it is imported from `@vesper/image-core`,
 * beside that package's other numbered-reference instruction compilers.
 *
 * The route (`apps/web/src/app/api/admin/self/face-repair/route.ts`) is the
 * only caller: it loads, calls `planFaceRepair`, and on acceptance resolves
 * the repair profile, the identity references, and the method, then builds
 * and submits the run through the ordinary Image Generator path
 * (`createImageGeneratorRun` + `startJob`) — the same path
 * `apps/web/src/app/api/admin/self/image-generator/runs/route.ts` uses, so a
 * repair run is a Generator run in every way that matters: it is provenance
 * complete, it never bypasses the cost guard, and it settles through the same
 * runner. Nothing here starts a job or spends a cost-guard token; that stays
 * the route's job per the image lanes' import-cycle rule
 * (`@/server/api` imports `@/server/images`).
 */

// ---------------------------------------------------------------------------
// Refusal vocabulary
// ---------------------------------------------------------------------------

export const faceRepairCodes = [
  /** The flag (`imageFaceRepairEnabled`) is off. The route answers a hidden
   * 404 for this one, matching `withOwnerAdmin`'s own namespace gate, rather
   * than the typed 400 every other code gets. */
  "disabled",
  /** No character matches that id for this owner. */
  "character_not_found",
  /** The source image is missing, not this owner's, not ready, a hidden
   * system kind, or belongs to a different character's render entirely. */
  "source_unavailable",
  /** The source depicts, or asserts, more than one person. */
  "multi_person",
  /** The identity-pack render lane refused before any byte was read. */
  "identity_unavailable",
  /** No image model profile is offered for a repair. */
  "model_unavailable",
  /** A regional (masked) repair is declared but no mask source exists yet. */
  "method_unavailable",
] as const;
export type FaceRepairCode = (typeof faceRepairCodes)[number];

/** The dotted diagnostic/refusal code every face-repair failure pushes and reports. */
export function faceRepairDiagnosticCode(code: FaceRepairCode): string {
  return `face_repair.${code}`;
}

// ---------------------------------------------------------------------------
// The request body
// ---------------------------------------------------------------------------

export const faceRepairCreateRequestSchema = z.object({
  characterId: z.string().min(1),
  sourceImageId: z.string().min(1),
  /** A profile id, model id, or model slug — the same loose vocabulary
   * `resolveImageProfileForTask`'s `stored` parameter accepts. Omitted, the
   * task's own default `variant` profile runs (today, the registered
   * `qwen/qwen-image-edit-2511` row's `variant-standard` profile). */
  modelId: z.string().min(1).optional(),
});
export type FaceRepairCreateRequest = z.infer<typeof faceRepairCreateRequestSchema>;

// ---------------------------------------------------------------------------
// PURE: the multi-person / source-validity decision
// ---------------------------------------------------------------------------

/** The scene/chat_place kinds whose cast lives in `image_references`. */
const FACE_REPAIR_SCENE_KINDS: readonly ImageKind[] = ["scene", "chat_place"];

/**
 * The hidden system kinds a face-repair source refuses — every
 * `HIDDEN_IMAGE_KINDS` entry except `reference_view`.
 *
 * `reference_view` sits in `HIDDEN_IMAGE_KINDS` for a different surface's
 * reason entirely: it must stay out of the player-facing gallery. A
 * reference view is still a genuine render of this character — the identity
 * pack's own accepted view — so it is a legitimate repair source, and this
 * subtracts it out here rather than editing `HIDDEN_IMAGE_KINDS` itself,
 * which other surfaces rely on unchanged for gallery hiding.
 */
const FACE_REPAIR_REFUSED_HIDDEN_KINDS: readonly ImageKind[] = HIDDEN_IMAGE_KINDS.filter(
  (kind) => kind !== "reference_view",
);

/** The source image row, exactly as loaded — no bytes, no provenance parsed yet. */
export interface FaceRepairSourceRow {
  id: string;
  kind: ImageKind;
  status: ImageRow["status"];
  entityKind: ImageEntityKind | null;
  entityId: string | null;
  /** Raw `images.meta` — `evaluateFaceRepairSource` parses `worldState` out of it. */
  meta: unknown;
}

/** A scene/chat_place row's cast, read from `image_references` (kind `character`). */
export interface FaceRepairSceneCastEvidence {
  /** Distinct character entity ids the scene names — de-duplication is the caller's. */
  characterEntityIds: readonly string[];
}

/** The character's own identity-pack quality record — measurement, not a verdict. */
export interface FaceRepairIdentityPackEvidence {
  failureCode: string | null;
  detectedFaces: number | null;
}

export interface PlanFaceRepairInput {
  enabled: boolean;
  characterId: string;
  /** Whether `characterId` exists and is this caller's. */
  characterOwned: boolean;
  /** Null when the source image is missing or not this owner's. */
  source: FaceRepairSourceRow | null;
  /** Loaded only when `source.kind` is `scene`/`chat_place`; null otherwise
   * (including when a scene's cast genuinely could not be loaded — see the
   * note on `evaluateFaceRepairSource`). */
  sceneCast: FaceRepairSceneCastEvidence | null;
  /** Null when the character has no identity pack at all. */
  identityPack: FaceRepairIdentityPackEvidence | null;
}

export type PlanFaceRepairRefusalCode = Extract<
  FaceRepairCode,
  "disabled" | "character_not_found" | "source_unavailable" | "multi_person"
>;

export type PlanFaceRepairResult =
  | { ok: true; subjectCheck: FaceRepairSubjectCheck }
  | { ok: false; code: PlanFaceRepairRefusalCode; message: string };

/**
 * The multi-person check and the source-validity gates around it — everything
 * the design's accept/deny table decides before any identity reference is
 * resolved or any byte is spent. Takes already-loaded rows so it needs no
 * database and no async boundary; the route supplies them.
 */
export function planFaceRepair(input: PlanFaceRepairInput): PlanFaceRepairResult {
  if (!input.enabled) {
    return { ok: false, code: "disabled", message: "face repair is not enabled" };
  }
  if (!input.characterOwned) {
    return { ok: false, code: "character_not_found", message: "no character matches that id" };
  }
  const { source } = input;
  if (!source) {
    return { ok: false, code: "source_unavailable", message: "no source image matches that id" };
  }
  if (source.status !== "ready") {
    return { ok: false, code: "source_unavailable", message: "the source image is not ready" };
  }
  if (FACE_REPAIR_REFUSED_HIDDEN_KINDS.some((kind) => kind === source.kind)) {
    return {
      ok: false,
      code: "source_unavailable",
      message: "the source image is a system asset, not a repairable render",
    };
  }
  return evaluateFaceRepairSource(input.characterId, source, input.sceneCast, input.identityPack);
}

/**
 * The design's accept/deny table, row by row:
 *
 * | source                                                      | outcome                                    |
 * | ------------------------------------------------------------| ------------------------------------------ |
 * | scene/chat_place cast (2+ distinct characters)               | refuse `multi_person`, method `reference_cast` |
 * | recorded operation asserts more than one subject              | refuse `multi_person`, method `render_contract` |
 * | the character's identity pack records ambiguity/`>1` faces    | refuse `multi_person`, method `pack_quality`   |
 * | avatar/portrait/chat_look/reference_view/single-cast scene     | accept, honest `subjectCheck`              |
 * | source belongs to a different character and isn't a scene     | refuse `source_unavailable`                |
 * | that includes this one                                        |                                             |
 *
 * **Why `render_contract` reads `meta.worldState.subjectRefs` rather than the
 * compiled prompt program's `operation.subject_count` claim.** The claim id
 * `operation.subject_count` is pushed onto every render's `positiveClaimIds`
 * UNCONDITIONALLY (`packages/image-core/src/prompt-program/positive-claims.ts`)
 * — its bare presence cannot distinguish a solo portrait from a two-person
 * scene, because the claim's VALUE (the actual count) is never persisted, only
 * its id. `meta.worldState.subjectRefs` is produced by the same digest compile
 * step (`compile-program.ts`: `subjectRefs: digest.subjects.map((s) =>
 * s.ref)`) and is the actual enumerated cast — one entry per subject, and the
 * embodied viewer is explicitly excluded from `digest.subjects`
 * (`world-digest.ts`'s own doc: "they describe a body that is in frame but is
 * not in the cast"). It is the persisted fact the design's `render_contract`
 * row is asking for, even though the design doc names the sibling
 * `promptProgram` key.
 */
function evaluateFaceRepairSource(
  characterId: string,
  source: FaceRepairSourceRow,
  sceneCast: FaceRepairSceneCastEvidence | null,
  identityPack: FaceRepairIdentityPackEvidence | null,
): PlanFaceRepairResult {
  const isSceneKind = FACE_REPAIR_SCENE_KINDS.some((kind) => kind === source.kind);
  const namesAnotherCharacter = source.entityKind === "character" && source.entityId !== characterId;

  if (isSceneKind && sceneCast) {
    if (!sceneCast.characterEntityIds.includes(characterId)) {
      return {
        ok: false,
        code: "source_unavailable",
        message: "the scene's cast does not include this character",
      };
    }
    if (sceneCast.characterEntityIds.length >= 2) {
      return {
        ok: false,
        code: "multi_person",
        message: `the scene's cast names ${String(sceneCast.characterEntityIds.length)} characters`,
      };
    }
  } else if (namesAnotherCharacter) {
    // Not a scene whose own cast could vindicate it (or the cast could not be
    // loaded — a defensive fallback the route should never actually exercise,
    // since it always loads the cast for a scene/chat_place kind): a row tied
    // to a specific different character is not this character's source.
    return {
      ok: false,
      code: "source_unavailable",
      message: "the source image belongs to a different character",
    };
  }

  const worldState = parseImageWorldStateProvenance(imageMeta(source.meta)["worldState"]);
  const worldSubjectCount = worldState ? new Set(worldState.subjectRefs).size : null;
  if (worldSubjectCount !== null && worldSubjectCount > 1) {
    return {
      ok: false,
      code: "multi_person",
      message: `the render's own recorded operation asserts ${String(worldSubjectCount)} subjects`,
    };
  }

  if (identityPack?.failureCode === "ambiguous_faces") {
    return {
      ok: false,
      code: "multi_person",
      message: "the character's identity pack records an ambiguous face selection",
    };
  }
  if (identityPack && identityPack.detectedFaces !== null && identityPack.detectedFaces > 1) {
    return {
      ok: false,
      code: "multi_person",
      message: `the character's identity pack detected ${String(identityPack.detectedFaces)} faces`,
    };
  }

  if (isSceneKind && sceneCast && sceneCast.characterEntityIds.length === 1) {
    return { ok: true, subjectCheck: { method: "reference_cast", subjects: 1 } };
  }
  if (worldSubjectCount !== null) {
    return { ok: true, subjectCheck: { method: "render_contract", subjects: worldSubjectCount } };
  }
  // No evidence either way — recorded honestly, never claimed as a detection.
  return { ok: true, subjectCheck: { method: "none", subjects: null } };
}

// ---------------------------------------------------------------------------
// PURE: identity profile pairing and method resolution
// ---------------------------------------------------------------------------

/**
 * Pair a resolved `variant` profile with the identity strategy the repair
 * action wants — canonical portrait THEN face crop — in memory only, the
 * `pairProfileWithNsfwLora` precedent for overriding one facet of a stored
 * profile without a new registry row (`nsfw-lora.ts`). A model whose registry
 * row caps it at one reference (a single-reference candidate like PuLID)
 * cannot carry two identity images, so it degrades explicitly to
 * canonical-only instead of asking `identityPackRenderReferences` for a
 * strategy the model has no slot for.
 */
export function pairFaceRepairIdentityProfile(profile: ResolvedImageProfile): ResolvedImageProfile {
  const identityStrategy = profile.model.maxReferences <= 1 ? "canonical_only" : "canonical_then_face_detail";
  return {
    ...profile,
    profile: {
      ...profile.profile,
      referencePolicy: { ...profile.profile.referencePolicy, identityStrategy },
    },
  };
}

export type ResolveFaceRepairMethodResult =
  | { ok: true; method: FaceRepairMethod }
  | { ok: false; code: Extract<FaceRepairCode, "method_unavailable">; message: string };

/**
 * `regional_mask` when the model's probed `additionalImageInputs` binds the
 * `mask` role to a dedicated field; otherwise `full_frame_identity_edit`. No
 * registered model binds one today (`controlReferenceTransport` then answers
 * `numbered_reference`, never `dedicated_input`, for every seeded row), so the
 * regional branch is exercised only by the synthetic model in
 * `face-repair.test.ts`.
 *
 * Deliberately refuses rather than degrading: mask EXTRACTION is not
 * implemented (no admin ever draws or is offered a mask), so a model that
 * DECLARES a mask input must not be silently run full-frame under the
 * "regional" label — that would tell a reader the repair was targeted when it
 * touched the whole image.
 */
export function resolveFaceRepairMethod(model: ImageModel): ResolveFaceRepairMethodResult {
  const transport = controlReferenceTransport(model, "mask");
  if (transport.kind === "dedicated_input") {
    return {
      ok: false,
      code: "method_unavailable",
      message: "masked repair is declared but no mask source exists yet",
    };
  }
  return { ok: true, method: "full_frame_identity_edit" };
}

// ---------------------------------------------------------------------------
// PURE: the run-request assembly
// ---------------------------------------------------------------------------

export interface BuildFaceRepairRunRequestInput {
  /** `image_models.id` — the registered model row, not the resolved profile's id. */
  modelId: string;
  characterId: string;
  sourceImageId: string;
  /** In plan order — canonical identity first when both roles are sent. */
  identityReferenceImageIds: readonly string[];
  method: FaceRepairMethod;
  subjectCheck: FaceRepairSubjectCheck;
  identityReferences: readonly IdentityReferenceProvenance[];
}

/**
 * The Generator create-run request a face repair submits: the source image
 * (the picture to repair) as the first primary reference under the neutral
 * `reference` role, the identity references after it under the `identity`
 * role in plan order, `faceRepairInstruction`'s numbered instruction (imported
 * from `@vesper/image-core`, above) as the whole prompt, one image, and the
 * `purpose` bag the run's meta persists for provenance and for the admin UI's
 * repair-run filter.
 */
export function buildFaceRepairRunRequest(input: BuildFaceRepairRunRequestInput): ImageGeneratorCreateRunRequest {
  const {
    modelId,
    characterId,
    sourceImageId,
    identityReferenceImageIds,
    method,
    subjectCheck,
    identityReferences,
  } = input;
  return {
    modelId,
    prompt: faceRepairInstruction(identityReferenceImageIds.length),
    inputs: {
      primary: [
        { imageId: sourceImageId, purpose: "reference" },
        ...identityReferenceImageIds.map((imageId) => ({ imageId, purpose: "identity" as const })),
      ],
      dedicated: [],
    },
    controls: { imageCount: 1 },
    purpose: {
      kind: "face_repair",
      characterId,
      sourceImageId,
      method,
      subjectCheck,
      identityReferences: [...identityReferences],
    },
  };
}

// ---------------------------------------------------------------------------
// Loads — owner-scoped reads the route composes before calling the pure plan
// above. Kept in this file, not inside the pure functions, so those stay
// callable with plain fixtures and no database (`face-repair.test.ts`).
// ---------------------------------------------------------------------------

/** Whether this character exists and belongs to this owner. */
export async function isFaceRepairCharacterOwned(characterId: string, ownerId: string): Promise<boolean> {
  const [row] = await db()
    .select({ id: characters.id })
    .from(characters)
    .where(and(eq(characters.id, characterId), eq(characters.ownerId, ownerId)))
    .limit(1);
  return row !== undefined;
}

/** The source image row, owner-scoped — null when missing or not this owner's. */
export async function loadFaceRepairSource(
  sourceImageId: string,
  ownerId: string,
): Promise<FaceRepairSourceRow | null> {
  const [row] = await db()
    .select()
    .from(images)
    .where(and(eq(images.id, sourceImageId), eq(images.ownerId, ownerId)))
    .limit(1);
  if (!row) return null;
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    entityKind: row.entityKind,
    entityId: row.entityId,
    meta: row.meta,
  };
}

/**
 * A scene/chat_place row's cast: every DISTINCT character `image_references`
 * names on it — the one queryable source of a scene's cast, read fresh rather
 * than trusted from the row's own `entityKind`/`entityId`, which names at most
 * one focal character.
 */
export async function loadFaceRepairSceneCast(sceneImageId: string): Promise<FaceRepairSceneCastEvidence> {
  const rows = await db()
    .selectDistinct({ entityId: imageReferences.entityId })
    .from(imageReferences)
    .where(and(eq(imageReferences.sceneImageId, sceneImageId), eq(imageReferences.kind, "character")));
  return {
    characterEntityIds: rows.map((row) => row.entityId).filter((id): id is string => id !== null),
  };
}

/** The character's own identity-pack quality evidence; null with no pack at all. */
export async function loadFaceRepairIdentityPackEvidence(
  characterId: string,
  ownerId: string,
  sink?: DiagnosticSink,
): Promise<FaceRepairIdentityPackEvidence | null> {
  const summary = await getIdentityPackForOwner(characterId, ownerId, sink);
  if (!summary?.pack) return null;
  return { failureCode: summary.pack.failureCode, detectedFaces: summary.pack.quality?.detectedFaces ?? null };
}

/** One diagnostic, in the module's own dotted vocabulary, for the route to push. */
export function faceRepairDiagnostic(code: FaceRepairCode, message: string, context?: Record<string, unknown>) {
  return diag("warn", faceRepairDiagnosticCode(code), message, context ? { context } : {});
}
