import {
  evaluateIdentityEffectiveSize,
  type EvaluateIdentityPackResult,
  evaluateIdentityProfilePolicy,
  type IdentityPackProfilePolicy,
  type IdentityPackPurpose,
  type IdentityReferenceCandidate,
  type IdentityReferenceProvenance,
  type IdentityReferenceRole,
  type IdentityReferenceStrategy,
  type ImageIdentityPackV1,
  type ImageIdentityPackWarningCode,
  type PixelSize,
  PROFILE_POLICY_DEFAULTS_V1,
} from "@vesper/image-core";
import { diag, type DiagnosticSink } from "@/contracts/diagnostics";
import { ensureIdentityPack } from "./identity-pack-ensure";
import { projectIdentityPackPolicy } from "./identity-pack-store";

/**
 * Profile-aware identity reference evaluation — the pack system's whole surface
 * to the render path (docs/developer-notes/image-identity-packs.spec.integration.md).
 *
 * **What this module is, and is not.** It answers one question: given a character
 * and a profile's declared identity strategy, which authorized references MAY be
 * sent, in what order, and what was measured about them. It returns ids and
 * measurements — never bytes, never a provider payload, never a model choice. The
 * capabilities layer owns which task is identity-critical, total reference
 * capacity, transport field names and effective resize behavior; the
 * render-quality layer owns prompt wording. Those layers do not exist yet: shared
 * render intent (image-model-capabilities.plan.md slice 2) is unbuilt, so NOTHING
 * calls this in production today.
 *
 * **The contract for when they land.** A lane obtains identity references ONLY
 * through this module, gated by `imageIdentityPackReferencesEnabled()` from
 * `./identity-packs` (one flag, `IMAGE_IDENTITY_PACK_REFERENCES`, default off — do
 * not spell a second copy). No lane may query `identity_face_crop` by kind,
 * recompute its own face crop, substitute a Gallery image when the pack is
 * blocked, reorder roles after profile resolution, or drop the provenance.
 *
 * **The flag is checked by the CALLER, not here.** Evaluation is measurement, and
 * measurement is exactly what the trial needs while the flag is off: packs may be
 * prepared, inspected and evaluated with no provider behavior change. Gating this
 * function would blind the admin and trial surfaces to the numbers they exist to
 * collect.
 *
 * **Eligibility runs BEFORE provider reservation** (spec §"Eligibility timing"):
 * a stale, ambiguous, missing or undersized pack must stop the render before
 * render-unit and price guards are charged, which is why every refusal here is a
 * value with an actionable code rather than an exception from a provider call.
 */

export interface EvaluateIdentityPackForProfileInput {
  ownerId: string;
  characterId: string;
  /** The pinned profile's declared strategy — never inferred from a provider schema. */
  strategy: IdentityReferenceStrategy;
  profilePolicy?: IdentityPackProfilePolicy;
  /**
   * What the provider actually feeds the model, when its resize behavior has been
   * reviewed. `null`/omitted means unknown, and the evaluation stays conservative:
   * uploading a 1024px file is not evidence the model sees 1024px.
   */
  effectiveReferenceSize?: { widthPx: number; heightPx: number } | null;
  /**
   * The audit label for the pack ensure this evaluation performs — behaviorally
   * identical either way. Defaults to `identity_render` (the render seam);
   * the trial surface passes `admin_trial` so its ensures are labeled as trial
   * activity, not render activity.
   */
  purpose?: IdentityPackPurpose;
  sink?: DiagnosticSink;
}

export interface RolePlanEntry {
  role: IdentityReferenceRole;
  required: boolean;
}

/**
 * Resolve a character's identity references for one profile.
 *
 * The pack is ensured first (bounded local derivation, no provider call), then
 * judged against the profile's facts by
 * {@link evaluateIdentityPackContractForProfile}. The same revision may be
 * eligible for one profile and ineligible for another — that is the point of
 * separating intrinsic measurement from profile evaluation — and nothing here
 * mutates the pack.
 */
export async function evaluateIdentityPackForProfile(
  input: EvaluateIdentityPackForProfileInput,
): Promise<EvaluateIdentityPackResult> {
  const { ownerId, characterId, sink } = input;
  const ensured = await ensureIdentityPack({ ownerId, characterId, purpose: input.purpose ?? "identity_render", sink });
  if (ensured.status !== "ready") {
    // A pack failure is product feedback ("use a clearer portrait", "crop it
    // yourself"), not a provider error — and it arrives before any spend.
    return ineligible(ensured.code, `images.identity_pack.${ensured.code}`, sink, characterId);
  }

  return evaluateIdentityPackContractForProfile({
    pack: ensured.pack,
    strategy: input.strategy,
    profilePolicy: input.profilePolicy,
    effectiveReferenceSize: input.effectiveReferenceSize,
    sink,
  });
}

export interface EvaluateIdentityPackContractInput {
  /** An already-resolved pack — the character's current revision, or a pinned
   * historical one the caller obtained by an owner-rooted read. */
  pack: ImageIdentityPackV1;
  /** The pinned profile's declared strategy — never inferred from a provider schema. */
  strategy: IdentityReferenceStrategy;
  profilePolicy?: IdentityPackProfilePolicy;
  /** As on {@link EvaluateIdentityPackForProfileInput}: null/omitted keeps the
   * evaluation conservative rather than assuming the uploaded size is seen. */
  effectiveReferenceSize?: { widthPx: number; heightPx: number } | null;
  /**
   * Judge a RETIRED-but-derived revision (`superseded`/`stale`) under today's
   * policy instead of letting it skip the projection. Trial-only, and off by
   * default — see {@link readyForRetiredJudgment} for why the flag has to exist
   * and why no production path may set it.
   */
  treatRetiredRevisionAsReady?: boolean;
  sink?: DiagnosticSink;
}

/**
 * A retired-but-derived revision, restamped `ready` for the length of ONE policy
 * judgment.
 *
 * `projectIdentityPackPolicy` re-judges only `ready` rows — deliberately, because
 * a `failed`/`unusable` revision has no crop bytes to hand anybody and the only
 * honest way to accept it would be to derive it again. `superseded` and `stale`
 * are caught by that rule INCIDENTALLY rather than by design: their derivation
 * finished and their crop bytes exist, they are simply no longer the character's
 * current pack. Left unstamped they would skip the projection entirely, and the
 * trial's pinned-revision arm would grade an old revision on the verdict an OLD
 * policy recorded — the one thing the projection exists to prevent.
 *
 * Only those two statuses are restamped. `pending` never finished and
 * `failed`/`unusable` have nothing to send, so claiming any of them is ready
 * would be a lie the projection cannot catch. The restamp lives for one call and
 * never reaches storage: this is a read-path judgment, and the row keeps the
 * status its own lifecycle gave it.
 */
function readyForRetiredJudgment(pack: ImageIdentityPackV1): ImageIdentityPackV1 {
  if (pack.status !== "superseded" && pack.status !== "stale") return pack;
  return { ...pack, status: "ready" };
}

/**
 * The eligibility judgment itself, over a pack the caller already has.
 *
 * This is the whole of {@link evaluateIdentityPackForProfile} minus the ensure —
 * the policy projection and the role walk, unchanged — and it is exported for
 * ONE reason: the trial's pinned-revision comparison arms must evaluate a
 * HISTORICAL revision, and the only honest way to do that is to run the same
 * interpretation of eligibility the render path runs. A trial-local copy of "may
 * this role be sent?" would drift from this one, and then the trial would be
 * measuring its own rules rather than the system's.
 *
 * It does no IO and takes no owner: authorization happened when the caller
 * obtained the pack (`ensureIdentityPack` for the current revision,
 * `getIdentityPackRevisionForTrial` for a pinned one), and re-deciding it here
 * from a pack alone would be exactly the bare-pack-id authorization the pack
 * system forbids.
 */
export function evaluateIdentityPackContractForProfile(
  input: EvaluateIdentityPackContractInput,
): EvaluateIdentityPackResult {
  const { sink } = input;
  const characterId = input.pack.characterId;

  // The third read seam re-judges the pack under the policy in force as well.
  // `ensureIdentityPack` already projects what it returns, so this is normally a
  // no-op — it is here so the render seam's guarantee is its own rather than an
  // inherited property of one caller's internals, and the projection is
  // idempotent by construction (it restamps the version it judged under). For a
  // PINNED revision it is not a no-op at all: an old revision was judged under
  // an old policy, and this is where today's policy gets its say — which is
  // exactly what `treatRetiredRevisionAsReady` is for, since a retired revision
  // would otherwise walk past the projection untouched.
  const projection = projectIdentityPackPolicy(
    input.treatRetiredRevisionAsReady ? readyForRetiredJudgment(input.pack) : input.pack,
    sink,
  );
  if (projection.blockedBy !== null) {
    return ineligible(projection.blockedBy, `images.identity_pack.${projection.blockedBy}`, sink, characterId);
  }

  const pack = projection.pack;
  const policy = input.profilePolicy ?? PROFILE_POLICY_DEFAULTS_V1;
  const effectiveReference: PixelSize | null = input.effectiveReferenceSize
    ? { width: input.effectiveReferenceSize.widthPx, height: input.effectiveReferenceSize.heightPx }
    : null;

  const candidates: IdentityReferenceCandidate[] = [];
  const warnings = new Set<ImageIdentityPackWarningCode>(pack.warningCodes);
  for (const entry of identityRolePlan(input.strategy)) {
    const resolved = resolveRole(entry, pack, policy, effectiveReference);
    for (const warning of resolved.warnings) warnings.add(warning);
    if (resolved.ok) {
      candidates.push(resolved.candidate);
      continue;
    }
    if (entry.required) {
      return ineligible(
        "profile_ineligible",
        `images.identity_pack.profile_ineligible.${resolved.reason}`,
        sink,
        characterId,
      );
    }
    // Optional role omitted, loudly: the render still happens, with less facial
    // detail, and the warning is what tells the trial which cell it actually ran.
    sink?.push(
      diag("warn", "images.identity_pack.profile_ineligible", `optional ${entry.role} omitted: ${resolved.reason}`, {
        context: { characterId, packId: pack.id, revision: pack.revision, role: entry.role },
      }),
    );
  }

  if (candidates.length === 0) {
    return ineligible("profile_ineligible", "images.identity_pack.profile_ineligible.no_roles", sink, characterId);
  }
  return { eligible: true, candidates, warnings: [...warnings] };
}

/**
 * Which roles this strategy sends, in send order, and which of them the profile
 * cannot do without.
 *
 * The required/optional split is a ruling the strategy names imply but does not
 * state: the CANONICAL portrait is the character's identity, so it is required
 * wherever it appears, and face detail is an enhancement that a profile may lose
 * without losing the character. `face_detail_only` is the exception — it is the
 * sole identity in that strategy, so it is necessarily required. This is what
 * makes "a profile never ejects one character's identity to fit another
 * character's face crop" mechanically true rather than a convention.
 *
 * Exported READ-ONLY, for the identity trial. A trial cell needs to know what a
 * strategy PROMISED as well as what the evaluation delivered: an optional role
 * that was omitted is a degraded-but-fine render in production and a degenerate
 * comparison arm in a trial (it duplicates a shorter strategy under a longer
 * name). The trial refuses such a cell; it does not, and must not, change this
 * plan — production evaluation semantics are exactly what the harness is
 * measuring, so a trial-shaped edit here would make it measure itself.
 */
export function identityRolePlan(strategy: IdentityReferenceStrategy): RolePlanEntry[] {
  switch (strategy) {
    case "canonical_only":
      return [{ role: "canonical_identity", required: true }];
    case "face_detail_only":
      return [{ role: "face_detail", required: true }];
    case "canonical_then_face_detail":
      return [
        { role: "canonical_identity", required: true },
        { role: "face_detail", required: false },
      ];
    case "face_detail_then_canonical":
      return [
        { role: "face_detail", required: false },
        { role: "canonical_identity", required: true },
      ];
  }
}

/** Why one role could not be supplied. Each maps to a `profile_ineligible` message key. */
type RoleRefusal =
  | "missing_source"
  | "missing_face_crop"
  | "policy_disallowed"
  | "small_effective_face";

type RoleResolution =
  | { ok: true; candidate: IdentityReferenceCandidate; warnings: ImageIdentityPackWarningCode[] }
  | { ok: false; reason: RoleRefusal; warnings: ImageIdentityPackWarningCode[] };

/**
 * Turn one planned role into a candidate, or explain why it cannot be supplied.
 *
 * Two rulings live here that the spec leaves to implementation:
 *
 * 1. **The profile's crop-provenance gates apply to `face_detail` only.** A
 *    profile that forbids heuristic crops is making a statement about a GUESSED
 *    rectangle, not about the character's own portrait — applying it to the
 *    canonical role would make every heuristic-pack character unrenderable by that
 *    profile, which is not what "allowHeuristic: false" means.
 * 2. **An undersized effective face refuses `face_detail` but only warns for
 *    `canonical_identity`.** Refusing the canonical role over face size would
 *    leave the render with no identity at all and no better alternative; the
 *    warning records the doubt where the trial can find it.
 */
function resolveRole(
  entry: RolePlanEntry,
  pack: ImageIdentityPackV1,
  policy: IdentityPackProfilePolicy,
  effectiveReference: PixelSize | null,
): RoleResolution {
  const sourceImageId = pack.source.imageId;
  if (sourceImageId === null) return { ok: false, reason: "missing_source", warnings: [] };

  const faceDetail = entry.role === "face_detail";
  const imageId = faceDetail ? pack.faceDetail.imageId : sourceImageId;
  if (imageId === null) return { ok: false, reason: "missing_face_crop", warnings: [] };

  const crop = pack.faceDetail.crop;
  const referenceRegion: PixelSize | null = faceDetail
    ? crop && { width: crop.width, height: crop.height }
    : { width: pack.source.width, height: pack.source.height };

  const warnings: ImageIdentityPackWarningCode[] = [];
  if (faceDetail) {
    const gate = evaluateIdentityProfilePolicy({
      method: pack.derivation.method,
      adminOverride: pack.warningCodes.includes("manual_admin_override"),
      policy,
    });
    warnings.push(...gate.warnings);
    if (!gate.allowed) return { ok: false, reason: "policy_disallowed", warnings };
  }

  const size = evaluateIdentityEffectiveSize({
    role: entry.role,
    faceBox: pack.quality?.faceBox ?? null,
    referenceRegion,
    effectiveReference,
    policy,
  });
  warnings.push(...size.warnings);
  if (size.belowEffectiveFaceFloor && faceDetail) {
    return { ok: false, reason: "small_effective_face", warnings };
  }

  return {
    ok: true,
    warnings,
    candidate: {
      role: entry.role,
      imageId,
      packId: pack.id,
      packRevision: pack.revision,
      sourceImageId,
      sourceContentHash: pack.source.contentHash,
      required: entry.required,
      warningCodes: [...new Set([...pack.warningCodes, ...warnings])],
      evaluation: {
        policyVersion: pack.derivation.policyVersion,
        effectiveReferenceWidthPx: size.effectiveReferenceWidthPx,
        effectiveReferenceHeightPx: size.effectiveReferenceHeightPx,
        effectiveFaceWidthPx: size.effectiveFaceWidthPx,
        effectiveFaceHeightPx: size.effectiveFaceHeightPx,
      },
    },
  };
}

function ineligible(
  code: Extract<EvaluateIdentityPackResult, { eligible: false }>["code"],
  messageKey: string,
  sink: DiagnosticSink | undefined,
  characterId: string,
): EvaluateIdentityPackResult {
  sink?.push(
    diag("warn", "images.identity_pack.profile_ineligible", `identity references unavailable: ${messageKey}`, {
      context: { characterId, code },
    }),
  );
  return { eligible: false, code, messageKey };
}

/**
 * The record that travels with the render attempt for one selected reference
 * (spec §"Render provenance").
 *
 * It belongs on the attempt rather than on the character or the image row because
 * an old render has to stay explainable after its pack is superseded: the
 * revision, the exact source bytes, the rectangle and the pixels the provider saw
 * are the entire evidence chain behind "why does this scene look like that".
 *
 * `crop` and `cropMethod` are null for `canonical_identity` on purpose — the bytes
 * sent for that role are the whole portrait, uncropped, and naming the pack's crop
 * there would claim a rectangle was applied to an image that never saw one.
 *
 * Pass the pack the candidates were evaluated from; by construction they are the
 * same revision.
 */
export function identityReferenceProvenanceFor(
  candidate: IdentityReferenceCandidate,
  pack: ImageIdentityPackV1,
): IdentityReferenceProvenance {
  const faceDetail = candidate.role === "face_detail";
  return {
    characterId: pack.characterId,
    packId: candidate.packId,
    packRevision: candidate.packRevision,
    packSchemaVersion: pack.derivation.schemaVersion,
    derivationVersion: pack.derivation.derivationVersion,
    policyVersion: candidate.evaluation.policyVersion,
    role: candidate.role,
    imageId: candidate.imageId,
    sourceImageId: candidate.sourceImageId,
    sourceContentHash: candidate.sourceContentHash,
    cropMethod: faceDetail ? pack.derivation.method : null,
    crop: faceDetail ? pack.faceDetail.crop : null,
    warningCodes: candidate.warningCodes,
    adminOverride: pack.warningCodes.includes("manual_admin_override"),
    effectiveReferenceWidthPx: candidate.evaluation.effectiveReferenceWidthPx,
    effectiveReferenceHeightPx: candidate.evaluation.effectiveReferenceHeightPx,
    effectiveFaceWidthPx: candidate.evaluation.effectiveFaceWidthPx,
    effectiveFaceHeightPx: candidate.evaluation.effectiveFaceHeightPx,
  };
}
