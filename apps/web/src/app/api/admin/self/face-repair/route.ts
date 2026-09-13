import type { NextRequest } from "next/server";
import { DiagnosticCollector } from "@/contracts/diagnostics";
import {
  imageRenderRejection,
  jobCapRejection,
  jsonError,
  jsonOk,
  readBody,
  startJob,
  withOwnerAdmin,
} from "@/server/api";
import {
  buildFaceRepairRunRequest,
  createImageGeneratorRun,
  deleteImageGeneratorRun,
  faceRepairCreateRequestSchema,
  faceRepairDiagnostic,
  faceRepairDiagnosticCode,
  identityPackRenderReferences,
  imageFaceRepairEnabled,
  isFaceRepairCharacterOwned,
  loadFaceRepairIdentityPackEvidence,
  loadFaceRepairSceneCast,
  loadFaceRepairSource,
  pairFaceRepairIdentityProfile,
  planFaceRepair,
  resolveFaceRepairMethod,
  resolveImageProfileForTask,
  runImageGeneratorRun,
  toWireImageGeneratorRun,
} from "@/server/images";

/**
 * Issue #246 — the flagged owner-admin face-repair action.
 *
 * `GET` reports whether the action is enabled at all, so the admin Settings
 * page can hide its Face repair section with a one-sentence explanation
 * instead of guessing from a failed request. `POST` runs the action itself,
 * over the ordinary Image Generator run path
 * (`api/admin/self/image-generator/runs/route.ts` is the reference this route
 * mirrors): the cost guard runs after every pre-spend refusal and before the
 * run row, `createImageGeneratorRun` records the row, and `startJob` is
 * called from THIS route rather than a service, for the same import-cycle
 * reason the Generator route calls it here (`@/server/api` imports
 * `@/server/images`).
 *
 * Refusals: every code but `disabled` is a typed JSON error at 400 —
 * `{ code: "face_repair.<code>", message }` — so the admin UI can read why.
 * `disabled` alone answers the SAME hidden 404 `withOwnerAdmin`'s own
 * namespace gate gives a caller outside `/api/admin/self`: a flagged-off
 * action must be indistinguishable from a route that does not exist, so its
 * diagnostic still carries the real dotted code for the server log, but the
 * response body never says so. A per-request `DiagnosticCollector` carries
 * every pushed diagnostic for the duration of the request — nothing here
 * persists it further, matching the Generator run route this mirrors, which
 * threads no sink of its own either.
 */

export const GET = withOwnerAdmin(async () => {
  return jsonOk({ enabled: imageFaceRepairEnabled() });
});

export const POST = withOwnerAdmin(async (user, req: NextRequest) => {
  const sink = new DiagnosticCollector();

  if (!imageFaceRepairEnabled()) {
    sink.push(faceRepairDiagnostic("disabled", "face repair is not enabled"));
    return jsonError("not_found", "not found", 404);
  }

  const body = await readBody(req, faceRepairCreateRequestSchema);
  if (!body.ok) return body.response;
  const { characterId, sourceImageId, modelId } = body.value;

  const [characterOwned, source] = await Promise.all([
    isFaceRepairCharacterOwned(characterId, user.id),
    loadFaceRepairSource(sourceImageId, user.id),
  ]);

  const [sceneCast, identityPackEvidence] = await Promise.all([
    source && (source.kind === "scene" || source.kind === "chat_place")
      ? loadFaceRepairSceneCast(source.id)
      : Promise.resolve(null),
    loadFaceRepairIdentityPackEvidence(characterId, user.id, sink),
  ]);

  const plan = planFaceRepair({
    enabled: true,
    characterId,
    characterOwned,
    source,
    sceneCast,
    identityPack: identityPackEvidence,
  });
  if (!plan.ok) {
    sink.push(faceRepairDiagnostic(plan.code, plan.message, { characterId, sourceImageId }));
    return jsonError(faceRepairDiagnosticCode(plan.code), plan.message, 400);
  }
  if (!source) {
    // Unreachable: `planFaceRepair` only answers `ok: true` when `source` was
    // given. Kept as a real branch (never a cast) so a future refactor that
    // breaks that invariant degrades to a refusal instead of a runtime crash.
    const message = "no source image matches that id";
    sink.push(faceRepairDiagnostic("source_unavailable", message));
    return jsonError(faceRepairDiagnosticCode("source_unavailable"), message, 400);
  }

  const resolvedProfile = await resolveImageProfileForTask("variant", modelId ?? null, sink);
  if (!resolvedProfile) {
    const message = "no image model profile is offered for a face repair";
    sink.push(faceRepairDiagnostic("model_unavailable", message));
    return jsonError(faceRepairDiagnosticCode("model_unavailable"), message, 400);
  }

  const pairedProfile = pairFaceRepairIdentityProfile(resolvedProfile);
  const identityResult = await identityPackRenderReferences({
    ownerId: user.id,
    characterId,
    profile: pairedProfile,
    sink,
  });
  if (!identityResult.ok) {
    sink.push(faceRepairDiagnostic("identity_unavailable", identityResult.error));
    return jsonError(faceRepairDiagnosticCode("identity_unavailable"), identityResult.error, 400);
  }

  const methodResult = resolveFaceRepairMethod(resolvedProfile.model);
  if (!methodResult.ok) {
    sink.push(faceRepairDiagnostic(methodResult.code, methodResult.message));
    return jsonError(faceRepairDiagnosticCode(methodResult.code), methodResult.message, 400);
  }

  const blocked = await imageRenderRejection(user, req, { outputKind: "generator_output", count: 1 });
  if (blocked) return blocked;

  const runRequest = buildFaceRepairRunRequest({
    // `image_models.id` — what `createImageGeneratorRun` resolves through
    // `loadImageModel`, NOT the profile id `resolveImageProfileForTask`
    // accepted as `modelId` above (that parameter is the resolver's own loose
    // vocabulary: a profile id, model id, or model slug).
    modelId: resolvedProfile.model.id,
    characterId,
    sourceImageId: source.id,
    identityReferenceImageIds: identityResult.references.map((reference) => reference.candidate.imageId),
    method: methodResult.method,
    subjectCheck: plan.subjectCheck,
    identityReferences: identityResult.provenance,
  });

  const created = await createImageGeneratorRun({ ownerId: user.id, request: runRequest, sink });
  if (!created.ok) return jsonError(created.refusal.code, created.refusal.message, 400);

  const { run } = created;
  const job = await startJob({
    type: "generator_image",
    ownerId: user.id,
    payload: { runId: run.id },
    run: async ({ reportProviderOutcome }) => {
      const result = await runImageGeneratorRun(run.id, user.id);
      reportProviderOutcome(result.providerOutcome);
      return result;
    },
  });
  if (!job.ok) {
    // Undone through the service's own owner-scoped delete, exactly as the
    // Generator run route undoes a refused job slot.
    await deleteImageGeneratorRun(run.id, user.id);
    return jobCapRejection(job, user, req);
  }
  return jsonOk({ run: toWireImageGeneratorRun(run) }, 201);
});
